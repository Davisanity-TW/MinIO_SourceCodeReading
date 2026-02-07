# Trace：PutObject vs Healing（PutObject 寫入後，Healing 怎麼補洞/重建）

> 目標：把 **PutObject 的落盤/rename/commit** 路徑，跟 **Healing（healObject）** 的「讀來源 → 重建 → 寫回」路徑接起來。
>
> 你在排查的核心問題通常是：
> - PutObject 寫到一半或 commit 前後出事，後續是誰補？
> - Healing 是怎麼判斷哪些 disks/parts 需要修？
> - 真的重建時，資料從哪裡讀、寫到哪裡？

本頁以 workspace 的 MinIO source tree 為準：`/home/ubuntu/clawd/minio`

---

## 1) PutObject：從 ObjectLayer 入口一路落到 erasureObjects.putObject()

PutObject 在 distributed/erasure 架構下，常見的 call chain（按 receiver 層級拆）是：

1) `cmd/object-handlers.go`
   - `objectAPIHandlers.PutObjectHandler()` → `objectAPI.PutObject(...)`

2) `cmd/erasure-server-pool.go`
   - `(*erasureServerPools).PutObject()`
   - 重點：multi-pool 會先拿 NSLock，再決定 pool index

3) `cmd/erasure-sets.go`
   - `(*erasureSets).PutObject()` → `s.getHashedSet(object)`

4) `cmd/erasure-object.go`
   - `erasureObjects.PutObject()` → `erasureObjects.putObject()`（主要流程在這裡）

你可以用 grep 快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func \(z \*erasureServerPools\) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func \(s \*erasureSets\) PutObject" -n cmd/erasure-sets.go
grep -RIn "func \(er erasureObjects\) putObject" -n cmd/erasure-object.go
```

---

## 2) PutObject 落盤的三個關鍵階段：Encode → tmp → rename/commit

在 `cmd/erasure-object.go: erasureObjects.putObject()` 內，你通常會想把寫入流程拆成三段看：

### 2.1 Encode（把 stream 變成 data/parity shards）
- 會建立：`erasure, err := NewErasure(...)`
- 會準備 temp 物件路徑：
  - `fi.DataDir = mustGetUUID()`
  - `tempObj := uniqueID`
  - `tempErasureObj := pathJoin(uniqueID, fi.DataDir, "part.1")`
- 後續會走 `erasure.Encode(...)`/寫 shards（實際 writer 建立與寫入在 putObject 內部後段）

> 觀察點：如果 encode 或寫 tmp shard 階段出錯，通常會留下 `.minio.sys/tmp` 的殘骸（但 putObject 也有 defer cleanup：`defer er.deleteAll(..., minioMetaTmpBucket, tempObj)`）。

### 2.2 tmp（先寫到 `.minio.sys/tmp`，避免半套覆蓋正式物件）
PutObject 的寫入通常會先落到 `minioMetaTmpBucket`（也就是 `.minio.sys/tmp`）底下，再做 rename。

### 2.3 rename/commit（把 tmp 變成正式物件資料）
後段常見會經過這些「你要下斷點/打 log 的點」：
- `renameData()`
- `commitRenameDataDir()`
- 以及底層 disk API：`StorageAPI.RenameData()` → `xlStorage.RenameData()`

> 觀察點：你要判斷「寫入成功但 commit 卡住」或「某些盤 rename 失敗導致需要後續 heal」，通常 rename/commit 這段最關鍵。

---

## 3) Healing：從 HealObject() 到 healObject()（如何挑來源、如何重建、如何寫回）

### 3.1 HealObject 的入口層級（從 pool → sets → objects）
Healing 跟 PutObject 一樣是分層下去：
- `cmd/erasure-server-pool.go`：`(*erasureServerPools).HealObject()`
- `cmd/erasure-sets.go`：`(*erasureSets).HealObject()`
- `cmd/erasure-healing.go`：`(*erasureObjects).healObject()`（主要流程）

（如果你要精準定位，建議直接在 repo 裡 grep `HealObject(` / `healObject(`。）

### 3.2 healObject() 的「前半段」：讀 meta → 算 quorum → 挑有效來源
檔案：`cmd/erasure-healing.go`
- `func (er *erasureObjects) healObject(...)`

前半段的核心呼叫鏈（很適合當作「healing 為什麼會做/不做」的判斷點）：
1) 拿鎖（如果沒 `opts.NoLock`）：`er.NewNSLock(bucket, object).GetLock(...)`
2) 讀所有磁碟上的 `xl.meta`：`readAllFileInfo(...)`
3) 依 meta 計算 read quorum：`objectQuorumFromMeta(...)`
4) 選出 online disks 與最新版本基準：
   - `listOnlineDisks(...)`
   - `pickValidFileInfo(...)`
5) 確認哪些 disks 具備所有 parts（可當重建來源）：`disksWithAllParts(...)`
6) 若不是 delete marker/remote：建立 `NewErasure(...)`

> 你要快速定位「為什麼 healing 認定 object 不存在 / 或 dangling purge」：通常就是 `readAllFileInfo` + `objectQuorumFromMeta` 這段的分支。

### 3.3 healObject() 的「後半段」：重建 → 寫 `.minio.sys/tmp` → RenameData 寫回
後半段（概念上）會做：
- 決定哪些 disk 需要 heal（missing/stale/bitrot）
- 呼叫 erasure 的 Heal/Decode 類邏輯重建缺失 shards
- **先寫到 `.minio.sys/tmp`**
- 最後 `disk.RenameData()` 把 tmp data dir 轉正

> 這段的觀察點：如果你看到大量 healing 但磁碟 latency/queue depth 飆高，常見是「重建讀 + 寫回」把 I/O 打爆，進而影響 inter-node 心跳（grid ping）與整體 S3 latency。

---

## 4) 把 PutObject 與 Healing 串起來的「實務對照」

你可以用下面這個簡單對照表，把現象快速歸類：

- PutObject 期間報錯（或 client timeout）+ `.minio.sys/tmp` 有殘留：
  - 優先看 putObject 的 tmp/rename/commit 路徑（`renameData` / `commitRenameDataDir`）

- 物件存在，但某些 disks 缺片/bitrot，之後被修好：
  - 走 healObject（`readAllFileInfo` → `disksWithAllParts` → `NewErasure` → 重建/寫回）

- healing/scanner 時段同時出現 `canceling remote connection ... not seen for ...`：
  - 常見是「資源壓力（I/O/CPU/GC）」讓 grid ping handler 跑不動
  - 連到 troubleshooting 頁：`/troubleshooting/canceling-remote-connection`

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

### 2.1 Encode（把 stream 變成 data/parity shards，並寫到 `.minio.sys/tmp`）
檔案：`cmd/erasure-object.go`
- function：`func (er erasureObjects) putObject(...)`

你在這段要抓的重點通常是三件事：**DataDir / tmp 路徑、writer 怎麼建、以及 quorum encode 怎麼寫**。

1) **建立 erasure encoder（RS）**
- `erasure, err := NewErasure(ctx, dataBlocks, parityBlocks, blockSize)`

2) **準備 DataDir 與 tmp object 路徑**
- `fi.DataDir = mustGetUUID()`（本次 PutObject 的新 DataDir）
- `uniqueID := mustGetUUID()`
- `tempObj := uniqueID`
- `tempErasureObj := pathJoin(uniqueID, fi.DataDir, "part.1")`

3) **建立 writers：bitrot writer 寫到 `.minio.sys/tmp`**
（這邊是你要下斷點/插 trace 的好位置）
- 非 inline data：`newBitrotWriter(disk, bucket, minioMetaTmpBucket, tempErasureObj, shardFileSize, DefaultBitrotAlgorithm, erasure.ShardSize())`
- inline data（小物件）：`newStreamingBitrotWriterBuffer(...)`（最後會把 bytes 塞到 `partsMetadata[i].Data`）

4) **真正 encode + write quorum**
- `n, erasureErr := erasure.Encode(ctx, toEncode, writers, buffer, writeQuorum)`
- `closeBitrotWriters(writers)`
- `n < data.Size()` → `IncompleteBody{}`（client 端內容不足/提前斷線的典型訊號）

> 觀察點：如果 encode 或寫 tmp shard 階段出錯，通常會留下 `.minio.sys/tmp` 的殘骸；但 PutObject 本身也有 defer cleanup：`defer er.deleteAll(..., minioMetaTmpBucket, tempObj)`，所以「有沒有殘留」要跟當下 crash/kill -9、或某些 disk 卡住導致 cleanup 沒跑完一起判讀。

### 2.2 tmp（先寫到 `.minio.sys/tmp`，避免半套覆蓋正式物件）
PutObject 的寫入通常會先落到 `minioMetaTmpBucket`（也就是 `.minio.sys/tmp`）底下，再做 rename。

### 2.3 rename/commit（把 tmp 變成正式物件資料：`renameData` → `commitRenameDataDir`）
檔案：`cmd/erasure-object.go`

PutObject 在 encode 寫完 `.minio.sys/tmp` 後，通常會進入兩段「把 tmp 變成正式資料」的流程：

1) **rename tmp data → bucket/object data**：`renameData(...)`
- 你可以 grep：`func renameData(`
- 典型呼叫：
  - `onlineDisks, versions, oldDataDir, err := renameData(ctx, onlineDisks, minioMetaTmpBucket, tempObj, partsMetadata, bucket, object, writeQuorum)`
- 直覺語意：
  - `.minio.sys/tmp/<tmpID>/<dataDir>/part.N` → `<bucket>/<object>/<dataDir>/part.N`
  - 並同步處理 `xl.meta`（依版本化/inline data/oldDataDir 等分支）

2) **commit（切換 DataDir / 讓新版本對外可見）**：`commitRenameDataDir(...)`
- method：`func (er erasureObjects) commitRenameDataDir(...)`
- 呼叫：`er.commitRenameDataDir(ctx, bucket, object, oldDataDir, onlineDisks)`

3) **落到 storage 層 rename（PutObject 的「原子切換點」）**
PutObject 這段最終會把 `.minio.sys/tmp` 裡的 shards 以 rename 方式切換到正式路徑；你在 trace/pprof 上看到卡住時，最有用的落點通常是 storage 層的 rename。

- interface：`cmd/storage-interface.go`（`StorageAPI.RenameData`）
- 實作：`cmd/xl-storage.go`（`func (s *xlStorage) RenameData(...)`）

讀碼定位：
```bash
cd /home/ubuntu/clawd/minio

# PutObject 端 rename/commit 的主要函式
grep -RIn "func renameData\(" -n cmd/erasure-object.go cmd/*.go
grep -RIn "commitRenameDataDir\(" -n cmd/erasure-object.go cmd/*.go

# storage 層 RenameData 落地
grep -RIn "type StorageAPI" -n cmd/storage-interface.go
grep -RIn "RenameData\(" -n cmd/storage-interface.go cmd/xl-storage.go
```

> 觀察點：要定位「卡在 encode/tmp/rename/commit 哪一段」時，最有效的切點通常是：`erasure.Encode()`、`renameData()`、`commitRenameDataDir()` 這三個位置。

### 2.4 PutObject 寫成功但「有洞」：MRF/partial 是怎麼被記下來、後續誰來補？
PutObject 有一個很關鍵但常被忽略的路徑：**client 端看起來「寫入成功」**，但當下其實有部分 disks offline / write quorum 勉強達成，導致「某些 shards 沒寫到」。

在這種情境下，MinIO 會把「需要後續補洞」記成 partial，讓背景機制（MRF / healing / scanner）有機會把缺片補回來。

你可以在 `cmd/erasure-object.go` 的 `erasureObjects.putObject()` 後段看到類似邏輯（不同版本細節會略有差）：
- 若本次寫入期間有 disk offline，會呼叫：
  - `er.addPartial(bucket, object, fi.VersionID)`

在你這份 source tree 裡，`addPartial()` 本身就是把事件丟進 **MRF queue**（Most Recently Failed）：
- 檔案：`cmd/erasure-object.go`
- 函式：`func (er erasureObjects) addPartial(bucket, object, versionID string)`
  - 內容：`globalMRFState.addPartialOp(partialOperation{ bucket, object, versionID, queued: time.Now() })`

而 MRF queue 的消費端在：
- 檔案：`cmd/mrf.go`
- 函式：`func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 從 `m.opCh` 取出 `partialOperation`
  - 對 bucket/object 會呼叫：`healBucket(bucket, scanMode)` / `healObject(bucket, object, versionID, scanMode)`

### 2.4.2 MRF 補洞的「完整 call chain」（精準到檔案/receiver）
把 `mrf.go` 裡的 `healObject(...)` 往下追，你可以把「背景補洞」跟 `HealObject()` 的正式 healing 路徑接起來：

1) `cmd/mrf.go`
- `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - `healObject(bucket, object, versionID, scanMode)`（內部會呼叫 object layer 的 heal）

2) `cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - multi-pool：併發呼叫各 pool 的 heal，回第一個成功結果

3) `cmd/erasure-sets.go`
- `func (s *erasureSets) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - `return s.getHashedSet(object).HealObject(...)`

4) `cmd/erasure-healing.go`
- `func (er erasureObjects) HealObject(...) (madmin.HealResultItem, error)`
  - quick read：`readAllFileInfo(..., lock=false)`
  - then：`er.healObject(...)`
- `func (er *erasureObjects) healObject(...)`（真正重建→寫回：`erasure.Heal()` + `disk.RenameData()`）

也就是：
**PutObject(成功但缺片) → addPartial → globalMRFState queue → mrfState.healRoutine → (ObjectLayer) HealObject → erasureObjects.healObject 真正補洞**。

> 實務意義：當你看到「PutObject client 回 200/204，但同時間又有 healing/scanner 很忙」時，MRF 這條線往往就是「為什麼 heal 會突然變多」的直接原因。

### 2.4.1 MRF `healRoutine()` 的「更精準」行為（實際 code）
以下以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準（`cmd/mrf.go`）：

1) **會跳過 `.minio.sys` 底下的特定路徑**（避免去 heal metacache/tmp/multipart）
- `buckets/*/.metacache/*`
- `tmp/*`
- `multipart/*`
- `tmp-old/*`

2) **剛失敗的 op 會先等一下（讓網路有時間回復）**
- 若 `now.Sub(u.queued) < 1s`：會 `time.Sleep(1s)`

3) **每次 heal 之間會做節流（dynamic sleeper）**
- `healSleeper := newDynamicSleeper(5, time.Second, false)`
- 每次處理前：`wait := healSleeper.Timer(context.Background())`
- heal 完後：`wait()`

4) **scan mode 可被 partialOperation 帶入**
- 預設 `scan := madmin.HealNormalScan`
- 若 `u.scanMode != 0` 則用 `u.scanMode`

5) **版本化物件：可能會對多個 VersionID 逐一呼叫 healObject**
- 若 `len(u.versions) > 0`：每 16 bytes 解析成一個 UUID，逐一 `healObject(bucket, object, <uuid>, scan)`
- 否則用 `u.versionID`

> 實戰判讀：如果你看到「PutObject 已回 200/204，但某些節點後續仍在跑 HealObject」，而且 log/trace 又常伴隨 `canceling remote connection`，MRF 這條背景補洞線通常就是你要先對照的『自動修復來源』之一。

**讀碼定位建議（在 `/home/ubuntu/clawd/minio`）：**
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "addPartial(" -n cmd/erasure-object.go cmd/*.go
grep -RIn "globalMRFState" -n cmd/erasure-object.go cmd/*.go
```

實務判讀：
- 如果你看到「PutObject 有成功回應」，但之後 scanner/healing 一直在補同一批 objects，通常就是這類「quorum 過了但有洞」的後果。
- 若同時伴隨 inter-node grid 的 `canceling remote connection ... not seen for ...`，常見是：**背景補洞/掃描把磁碟打滿**，導致 grid ping/pong handler 延遲累積。

---

## 3) Healing：從 HealObject() 到 healObject()（如何挑來源、如何重建、如何寫回）

### 3.1 HealObject 的入口層級（從 pool → sets → objects → healObject）
Healing 跟 PutObject 一樣是分層下去；你要追「實際重建」最終會落到 `(*erasureObjects).healObject()`：

1) `cmd/erasure-server-pool.go`
   - `func (z *erasureServerPools) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
   - multi-pool 會對每個 pool 併發呼叫 `pool.HealObject()`，然後回傳第一個成功（nil error）的結果。

2) `cmd/erasure-sets.go`
   - `func (s *erasureSets) HealObject(...) (madmin.HealResultItem, error)`
   - 直接 `return s.getHashedSet(object).HealObject(...)`

3) `cmd/erasure-healing.go`
   - `func (er erasureObjects) HealObject(...) (madmin.HealResultItem, error)`
     - 先做 quick read：`readAllFileInfo(..., lock=false)` 判斷「是否全都 not found」（可以很快 return）
     - 然後呼叫真正的修復：`er.healObject(...)`
     - 若遇到 `errFileCorrupt` 且原本不是 deep scan，會自動把 `opts.ScanMode` 升級成 `madmin.HealDeepScan` 再 heal 一次。
       - 檔案：`cmd/erasure-healing.go`
       - 你要找的判斷通常長得像：`if errors.Is(err, errFileCorrupt) && opts.ScanMode != madmin.HealDeepScan { opts.ScanMode = madmin.HealDeepScan; return er.healObject(...) }`
       - 實務意義：你看到 heal result/trace 變成 deep scan，不一定是 admin 指定，而可能是 **repair 過程自動升級**。
   - `func (er *erasureObjects) healObject(...) (madmin.HealResultItem, error)`（真正重建/寫回的主流程）

（精準定位建議：在 `/home/ubuntu/clawd/minio` 直接 `grep -RIn "HealObject(ctx" cmd` + `grep -RIn "healObject(ctx" cmd/erasure-healing.go`。）

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

### 3.3 healObject() 的「後半段」：實際重建 → 寫 `.minio.sys/tmp` → `RenameData()` 寫回（精準到函式/檔案）
檔案：`cmd/erasure-healing.go`
- 入口：`func (er *erasureObjects) healObject(...)`

當 `disksToHealCount > 0` 且非 dry-run 後，`healObject()` 後半段會真的開始「重建缺失的 parts」，流程非常像 PutObject：

1) **決定來源/目標 DataDir**
- 你會看到邏輯會挑出：
  - `srcDataDir`：用來讀既有 shards 的 DataDir（來源）
  - `dstDataDir`：本次 heal 寫回的 DataDir（目標）
  - `tmpID := mustGetUUID()`：本次 heal 的 tmp 目錄 id（對應 `.minio.sys/tmp/<tmpID>/...`）

2) **對每個 part 建 reader/writer（含 bitrot）**
- 讀來源：`newBitrotReader(...)`
  - partPath：`pathJoin(object, srcDataDir, fmt.Sprintf("part.%d", partNumber))`
- 寫 tmp：`newBitrotWriter(...)` 或 inline data 分支的 `newStreamingBitrotWriterBuffer(...)`
  - tmp partPath：`pathJoin(tmpID, dstDataDir, fmt.Sprintf("part.%d", partNumber))`

3) **核心重建：`erasure.Heal()`**
- 真正做 erasure 重建、並把重建後的 shard 寫到 writers：
  - `err = erasure.Heal(ctx, writers, readers, partSize, prefer)`

4) **更新各 disk 的 partsMetadata（指向 dstDataDir）**
- 對成功寫入的 disk：
  - `partsMetadata[i].DataDir = dstDataDir`
  - `partsMetadata[i].AddObjectPart(...)`
  - inline data 則：`partsMetadata[i].Data = inlineBuffers[i].Bytes()` + `partsMetadata[i].SetInlineData()`

5) **defer 清理 tmp**
- `defer er.deleteAll(context.Background(), minioMetaTmpBucket, tmpID)`
  - 代表即使成功 rename，tmp 也會嘗試清掉；失敗時也避免留下過多殘骸。

6) **最關鍵：把 `.minio.sys/tmp` rename 到正式位置：`disk.RenameData()`**
- 對每個要修的 disk：
  - `partsMetadata[i].SetHealing()`（標記這是 healing 寫回）
  - `disk.RenameData(ctx, minioMetaTmpBucket, tmpID, partsMetadata[i], bucket, object, RenameOptions{})`

> 這裡的 `RenameData()` 就是 healing 把「重建出的資料（tmp）」變成「正式 object data dir」的原子性切換點。
>
> 如果你在 production 看到 healing 與 `canceling remote connection ... not seen for ...` 同時大量出現，常見是：**heal 的讀+寫把 I/O 打滿** → goroutine 排隊/GC/磁碟延遲飆高 → inter-node grid ping 跟不上。

---

## 4) 快速 grep / 跳轉清單（把 call chain 變成 10 秒內可定位）

在不同 RELEASE tag 版本間，檔案可能拆分/合併；最穩的方式是直接用 signature grep。

以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準：
```bash
cd /home/ubuntu/clawd/minio

# PutObject（handler → object layer → erasure）
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" cmd/object-handlers.go
grep -RIn "func (z \\*erasureServerPools) PutObject" cmd/*.go
grep -RIn "func (s \\*erasureSets) PutObject" cmd/*.go
grep -RIn "func (er erasureObjects) putObject" cmd/*.go

# PutObject rename/commit 的切換點
grep -RIn "func renameData\\(" cmd/*.go
grep -RIn "commitRenameDataDir\\(" cmd/*.go

# Healing（MRF → HealObject → healObject）
grep -RIn "type mrfState" cmd/mrf.go
grep -RIn "healRoutine" cmd/mrf.go
grep -RIn "func (z \\*erasureServerPools) HealObject" cmd/*.go
grep -RIn "func (s \\*erasureSets) HealObject" cmd/*.go
grep -RIn "func (er \\*erasureObjects) healObject" cmd/*.go

# 真正寫回（storage 層 rename）
grep -RIn "RenameData\\(" cmd/storage-interface.go cmd/xl-storage.go
```

> 你要做 profiling/trace/斷點時，通常先把觀察點放在：
> - PutObject：`erasure.Encode()` / `renameData()` / `commitRenameDataDir()`
> - Healing：`readAllFileInfo()` / `erasure.Heal()` / `disk.RenameData()`

---

## 5) 把 PutObject 與 Healing 串起來的「實務對照」

你可以用下面這個簡單對照表，把現象快速歸類：

- PutObject 期間報錯（或 client timeout）+ `.minio.sys/tmp` 有殘留：
  - 優先看 putObject 的 tmp/rename/commit 路徑（`renameData` / `commitRenameDataDir`）

- 物件存在，但某些 disks 缺片/bitrot，之後被修好：
  - 走 healObject（`readAllFileInfo` → `disksWithAllParts` → `NewErasure` → 重建/寫回）

- healing/scanner 時段同時出現 `canceling remote connection ... not seen for ...`：
  - 常見是「資源壓力（I/O/CPU/GC）」讓 grid ping handler 跑不動
  - 連到 troubleshooting 頁：`/troubleshooting/canceling-remote-connection`

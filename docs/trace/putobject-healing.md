# Trace：PutObject vs Healing（PutObject 寫入後，Healing 怎麼補洞/重建）

> TL;DR：
> - **PutObject** 寫入達到 write quorum 就可能回成功，但仍可能留下「部分 disks 缺片」
> - 缺片會被記到 **MRF (Most Recently Failed)** queue：`addPartial()` → `globalMRFState.addPartialOp()`
> - 後續由 **MRF/scanner/background healing** 走 `HealObject()` → `erasureObjects.healObject()` 做 RS 重建並 `RenameData()` 寫回

> 目標：把 **PutObject 的落盤/rename/commit** 路徑，跟 **Healing（healObject）** 的「讀來源 → 重建 → 寫回」路徑接起來。
>
> 你在排查的核心問題通常是：
> - PutObject 寫到一半或 commit 前後出事，後續是誰補？
> - Healing 是怎麼判斷哪些 disks/parts 需要修？
> - 真的重建時，資料從哪裡讀、寫到哪裡？

本頁以 upstream MinIO `master`（GitHub raw/檔名與函式名）為準（行號可能因版本不同而漂移）。

---

## 0) 一張圖把 PutObject ↔ Healing（MRF/scanner）串起來（含檔案/函式）

> 你在 incident note 最常需要的是「一句話 + 可跳轉的 code 錨點」。下面這張 cheat sheet 盡量用 *函式簽名 + 檔案* 表示，避免行號漂移。

### 0.1 PutObject 主線（client 寫入）

- `cmd/object-handlers.go`
  - `objectAPIHandlers.PutObjectHandler()`
  - 這個 handler 會先把 request body 包成 `PutObjReader`，最後呼叫 ObjectLayer 的 `PutObject()`（upstream `master` 摘錄）：

```go
// cmd/object-handlers.go
putObject := objectAPI.PutObject
...
rawReader := hashReader
pReader := NewPutObjReader(rawReader)
...
objInfo, err := putObject(ctx, bucket, object, pReader, opts)
```

- `cmd/erasure-server-pool.go`
  - `(*erasureServerPools).PutObject()`（multi-pool：NSLock + 選 pool）
- `cmd/erasure-sets.go`
  - `(*erasureSets).PutObject()`（hash 到 set）
- `cmd/erasure-object.go`
  - `erasureObjects.PutObject()` → `erasureObjects.putObject()`
  - encode：`erasure.Encode(...)`
  - tmp→正式：`renameData(...)` → `commitRenameDataDir(...)`
  - quorum 過但有洞：`er.addPartial(...)` → `globalMRFState.addPartialOp(...)`
    - `cmd/erasure-object.go:2107`：`func (er erasureObjects) addPartial(bucket, object, versionID string)`
      - 只做一件事：把 `partialOperation{bucket,object,versionID,queued:time.Now()}` 丟進 `globalMRFState.opCh`
    - `cmd/mrf.go:52`：`func (m *mrfState) addPartialOp(op partialOperation)`
      - `select { case m.opCh <- op: default: }`（queue 滿就直接 drop，不會 block PutObject）

### 0.2 Healing 主線（背景補洞/重建）

- 來源 A：MRF（PutObject 成功但缺片）
  - `cmd/mrf.go`
    - `(*mrfState).addPartialOp(...)`
    - `(*mrfState).healRoutine(z *erasureServerPools)`（消費 queue）
      - `cmd/mrf.go:68`：`func (m *mrfState) healRoutine(z *erasureServerPools)`
      - 核心 loop：`u := <-m.opCh` →（必要時 sleep 1s）→ `healSleeper.Timer()` → `healObject(u.bucket,u.object,u.versionID,scan)` → `wait()`
      - 會跳過 `.minio.sys` 的 `.metacache/ tmp/ multipart/ tmp-old/`（避免對暫存物件做 MRF heal）
    - `healObject(...)` helper → `z.HealObject(...)`
- 來源 B：scanner（背景掃描直接觸發 heal）
  - `cmd/data-scanner.go`
    - `(*scannerItem).applyHealing(...)` → `o.HealObject(...)`
- 真正執行 heal（ObjectLayer）
  - `cmd/erasure-server-pool.go` → `cmd/erasure-sets.go` → `cmd/erasure-healing.go`
    - `(*erasureServerPools).HealObject()`
    - `(*erasureSets).HealObject()`
    - `erasureObjects.HealObject()` → `(*erasureObjects).healObject()`
    - RS rebuild：`erasure.Heal(...)`
    - 寫回切換點：`disk.RenameData(...)`（interface：`StorageAPI.RenameData` / 實作：`(*xlStorage).RenameData`）

> 實務用法：看到「PutObject latency 變差 + healing 變多」時，先用上面這張圖把兩條線接起來（多半是 quorum 仍達成但留下 partial → MRF 開始補洞）。

## 0.3 healObject() 內部「真的重建 + 寫回」的呼叫鏈（補精準函式/檔案）

> 這段是把 Healing 從「呼叫到 HealObject」往下鑽到「RS 重建 → 寫到 tmp → RenameData 原子切換」的核心。
> 以下錨點以 upstream MinIO `master` 為參考（檔名/函式名穩定；行號請以 `grep` 自行定位）。

- 檔案：`cmd/erasure-healing.go`
  - `func (er *erasureObjects) healObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

在 `healObject()` 內部，實際上大致可拆成 4 段（每段都有明確的函式/介面切點）：

1) **拿鎖 + 重新讀取 xl.meta（決定 read quorum / 最新版本）**
   - `er.NewNSLock(bucket, object).GetLock(...)`（若 `!opts.NoLock`）
   - `readAllFileInfo(ctx, storageDisks, "", bucket, object, versionID, true, true)`
   - `objectQuorumFromMeta(ctx, partsMetadata, errs, er.defaultParityCount)`
   - `listOnlineDisks(...)` → `pickValidFileInfo(...)`
   - `disksWithAllParts(ctx, onlineDisks, partsMetadata, errs, latestMeta, bucket, object, scanMode)`

2) **初始化 RS encoder（NewErasure）並決定要 heal 哪些 disks/parts**
   - `NewErasure(ctx, latestMeta.Erasure.DataBlocks, latestMeta.Erasure.ParityBlocks, latestMeta.Erasure.BlockSize)`
   - 依 `availableDisks/errs/dataErrs` 組出 `outDatedDisks`（需要被補的 disks）

3) **對每個 part 做重建：讀來源 → erasure.Heal() → 寫到 .minio.sys/tmp**
   - 讀來源（ReaderAt）：`newBitrotReader(...)`
   - 寫入 tmp（Writer）：`newBitrotWriter(...)`（或 inline：`newStreamingBitrotWriterBuffer(...)`）
   - 核心重建：`err = erasure.Heal(ctx, writers, readers, partSize, prefer)`
   - tmp 目錄：`minioMetaTmpBucket`（`.minio.sys/tmp`）下以 `tmpID/dstDataDir/part.N` 暫存

4) **原子寫回：RenameData() 把 tmp 內容切到正式 object dataDir**
   - 介面：`StorageAPI.RenameData(...)`
   - 呼叫點（同檔案）：`disk.RenameData(ctx, minioMetaTmpBucket, tmpID, partsMetadata[i], bucket, object, RenameOptions{})`
   - 直覺語意：`.minio.sys/tmp/<tmpID>/.../part.N` → `<bucket>/<object>/<dstDataDir>/part.N`（同時更新/寫回 xl.meta）

> 你要把「heal 造成的 I/O 壓力」跟現象（例如 `canceling remote connection`）對齊時，通常就是在 (3) 的 `erasure.Heal()` 大量讀 + (4) 的 `RenameData()` 大量寫/rename 這兩段把磁碟打滿。

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
cd /path/to/minio

grep -RIn "func \(z \*erasureServerPools\) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func \(s \*erasureSets\) PutObject" -n cmd/erasure-sets.go
grep -RIn "func (er erasureObjects) PutObject" -n cmd/erasure-object.go
grep -RIn "func \(er erasureObjects\) putObject" -n cmd/erasure-object.go
```

### 1.1（補）以目前 workspace source tree 的「精準位置」對照（含行號/commit）
> 下面行號是我在本 workspace（`/path/to/minio`）當下 checkout 直接 grep 出來的結果；你換 MinIO 版本/commit 後行號會飄，但函式簽名不太會變。

- `cmd/object-handlers.go`
  - `objectAPIHandlers.PutObjectHandler()`：`cmd/object-handlers.go:1987`
- `cmd/erasure-server-pool.go`
  - `(*erasureServerPools).PutObject()`：`cmd/erasure-server-pool.go:1056`
- `cmd/erasure-object.go`
  - `erasureObjects.PutObject()`（wrapper）：`cmd/erasure-object.go:1242`
  - `erasureObjects.putObject()`（主流程）：`cmd/erasure-object.go:1247`
  - `renameData(...)`（func 定義）：`cmd/erasure-object.go:1015`
  - `renameData(...)`（putObject 內呼叫點）：`cmd/erasure-object.go:1526`
  - `commitRenameDataDir(...)`（呼叫點）：`cmd/erasure-object.go:1539`
  - `commitRenameDataDir(...)`（func 定義）：`cmd/erasure-object.go:1785`

#### 1.1.1 一鍵重抓（避免行號/版本漂移）
在你自己的 checkout（RELEASE tag / fork）想重抓同樣的錨點，建議用「函式簽名 grep」而不要寫死行號：

```bash
cd /path/to/minio

git rev-parse --short HEAD

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go

grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

grep -n "^func renameData" cmd/erasure-object.go

grep -n "^func (er erasureObjects) commitRenameDataDir" cmd/erasure-object.go

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go

grep -n "^func (er \\*erasureObjects) healObject" cmd/erasure-healing.go
```

### 1.2（補）multi-pool 時 PutObject 的「鎖 + 選 pool」實際落點
PutObject 在 multi-pool（多個 erasure pools）情境，`(*erasureServerPools).PutObject()` 會先做：
1) input 檢查：`checkPutObjectArgs(ctx, bucket, object)`
   - 檔案：`cmd/object-api-input-checks.go`
   - 本機 workspace ：`cmd/object-api-input-checks.go:161`
2) 物件名編碼（dir object）：`object = encodeDirObject(object)`
3) 若 `!opts.NoLock`：
   - 先在「pool 之上」拿 **object lock**：`z.NewNSLock(bucket, object).GetLock(...)`
   - 然後把 `opts.NoLock = true`，避免 lower-level 再重複拿鎖
4) 選出寫入的 pool index：`z.getPoolIdxNoLock(ctx, bucket, object, data.Size())`
5) 寫入：`z.serverPools[idx].PutObject(...)`

讀碼定位（同 commit）：
- `cmd/erasure-server-pool.go:1056`：`func (z *erasureServerPools) PutObject(...)`
  - `checkPutObjectArgs(...)` 呼叫點：`cmd/erasure-server-pool.go:1058`
  - `getPoolIdxNoLock(...)` 呼叫點：`cmd/erasure-server-pool.go:1082`

這段很適合拿來回答兩個現場常見問題：
- 「multi-pool 時，PutObject 是在 pool 上面拿鎖，還是到 set/object 層才拿？」（答案：pool 上面就拿）
- 「怎麼決定寫到哪個 pool？」（答案：`getPoolIdxNoLock(...)` 依 bucket/object/size + pool 使用狀況做選擇）

- Healing 入口（同 commit）
  - `(*erasureServerPools).HealObject(...)`：`cmd/erasure-server-pool.go:2319`
  - `(*erasureSets).HealObject(...)`：`cmd/erasure-sets.go:1176`
  - `erasureObjects.HealObject(...)`：`cmd/erasure-healing.go:999`
  - `(*erasureObjects).healObject(...)`：`cmd/erasure-healing.go:242`

（補）MRF（Most Recently Failed）queue 的精準錨點（同 commit）
  - `type partialOperation struct`：`cmd/mrf.go:35`
  - `(*mrfState).addPartialOp(...)`：`cmd/mrf.go:52`（non-blocking，滿了會 drop）
  - `(*mrfState).healRoutine(...)`：`cmd/mrf.go:68`（消費 queue，呼叫 `HealObject()`）

### 1.3（新增）現場筆記最小欄位（把 PutObject ↔ Healing 關聯記得可回溯）
建議你每次在 incident note 記到「PutObject 之後出現 healing / grid 斷線」時，至少固定寫下：
- time window：`T ± 5m`
- object key：`bucket/object`（最好含 versionID）
- PutObject 是不是有 offline disk / partial（是否走到 `addPartial()` / MRF）
- 同時間窗 healing 是否活躍（MRF queue / scanner / admin heal）

目的：後續你要回到同一個 RELEASE tag 抓 grep 錨點、或用 trace/pprof 對齊時，會非常省時間。

如果要自己重抓一次（避免行號不一致）：
```bash
cd /path/to/minio

git rev-parse --short HEAD

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
grep -n "func renameData" cmd/erasure-object.go

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head
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
- 精準位置（本 workspace `/path/to/minio`）：`cmd/erasure-object.go:1015`
- 典型呼叫：
  - `onlineDisks, versions, oldDataDir, err := renameData(ctx, onlineDisks, minioMetaTmpBucket, tempObj, partsMetadata, bucket, object, writeQuorum)`
- 直覺語意：
  - `.minio.sys/tmp/<tmpID>/<dataDir>/part.N` → `<bucket>/<object>/<dataDir>/part.N`
  - 並同步處理 `xl.meta`（依版本化/inline data/oldDataDir 等分支）

2) **commit（切換 DataDir / 讓新版本對外可見）**：`commitRenameDataDir(...)`
- method：`func (er erasureObjects) commitRenameDataDir(...)`
- 精準位置（本 workspace `/path/to/minio`）：`cmd/erasure-object.go:1785`
- 呼叫點（同檔案）：`cmd/erasure-object.go:1539`
- 呼叫：`er.commitRenameDataDir(ctx, bucket, object, oldDataDir, onlineDisks)`

3) **落到 storage 層 rename（PutObject 的「原子切換點」）**
PutObject 這段最終會把 `.minio.sys/tmp` 裡的 shards 以 rename 方式切換到正式路徑；你在 trace/pprof 上看到卡住時，最有用的落點通常是 storage 層的 rename。

- interface：`cmd/storage-interface.go`（`StorageAPI.RenameData`）
  - 本機 workspace ：`cmd/storage-interface.go:88`
- 實作：`cmd/xl-storage.go`（`func (s *xlStorage) RenameData(...)`）
  - 本機 workspace ：`cmd/xl-storage.go:2456`

讀碼定位：
```bash
cd /path/to/minio

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

#### 2.4.1 `addPartial()` 何時被觸發？（精準到 PutObject 內部時序）
以你目前 workspace 的 MinIO source tree（`/path/to/minio`）為準，`addPartial()` 最典型的觸發點是在 `erasureObjects.putObject()` **完成 tmp rename + commit 之後**：

- `renameData(...)` 成功（tmp → 正式 data path）
- `commitRenameDataDir(...)` 成功（切換 DataDir / 讓新版本可見）
- 接著檢查是否有任何 `onlineDisks[i] == nil` 或 `!onlineDisks[i].IsOnline()`
  - 若是 → `er.addPartial(bucket, object, fi.VersionID)`（把「這個 object 需要補洞」丟給 MRF）

另外一個重要分支：如果 `renameData()` 回傳 `versions`（代表 *versions disparity*，需要「一次性對多版本做 implicit healing」），PutObject 會直接走：
- `globalMRFState.addPartialOp(partialOperation{versions: versions, ...})`
而不是只丟單一 `VersionID`。

（你可以在 `/path/to/minio/cmd/erasure-object.go` 看到這段邏輯緊接在 `commitRenameDataDir` 之後。）

##### 2.4.1.1（補）把「versions disparity → 丟 MRF」的分支釘死（方便你在 incident note 引用）
在 `erasureObjects.putObject()` 完成 `commitRenameDataDir()` 之後，通常會有兩種「丟 MRF」的形態：

A) **單一版本 partial**（某些 disks offline）：
- `er.addPartial(bucket, object, fi.VersionID)`

B) **多版本 disparity**（`renameData()` 回傳 `versions`）：
- `globalMRFState.addPartialOp(partialOperation{ versions: versions, ... })`

建議你直接在 workspace MinIO source 這樣定位（比猜行號穩）：
```bash
cd /path/to/minio

# putObject() 裡 addPartial / versions disparity 的兩個分支
grep -n "commitRenameDataDir" -n cmd/erasure-object.go
grep -n "addPartial(" -n cmd/erasure-object.go
grep -n "versions" -n cmd/erasure-object.go | head -n 80

# MRF 的 partialOperation 定義 + queue 消費端
grep -n "type partialOperation" -n cmd/mrf.go
grep -n "func (m \*mrfState) addPartialOp" -n cmd/mrf.go
grep -n "func (m \*mrfState) healRoutine" -n cmd/mrf.go
```

> 實務上：把上述 grep 的輸出（檔案/行號 + Git commit）貼到事件筆記裡，後續你要在相同 RELEASE tag 版本做 code review/回溯，會省非常多時間。

#### 2.4.2 partial/MRF 的產生者：`addPartial()` 把事件丟進 queue
在你這份 source tree 裡，`addPartial()` 本身就是把事件丟進 **MRF queue**（Most Recently Failed）：
- 檔案：`cmd/erasure-object.go`
- 函式：`func (er erasureObjects) addPartial(bucket, object, versionID string)`
  - 內容：`globalMRFState.addPartialOp(partialOperation{ bucket, object, versionID, queued: time.Now() })`

而 `addPartialOp()` 的實作在：
- 檔案：`cmd/mrf.go`
- method：`func (m *mrfState) addPartialOp(u partialOperation)`
  - 典型行為：把 op 送進 channel（`m.opCh <- u`）。

##### 2.4.2.1（補）`partialOperation` 結構長什麼樣？`addPartialOp()` 有沒有節流/丟棄？
以 workspace 的 MinIO source（`/path/to/minio`，）為準：

- 檔案：`cmd/mrf.go`
- struct：`type partialOperation struct { ... }`

實際欄位（節錄）：
```go
type partialOperation struct {
    bucket              string
    object              string
    versionID           string
    versions            []byte
    setIndex, poolIndex int
    queued              time.Time
    scanMode            madmin.HealScanMode
}
```

`addPartialOp()` 的行為是 **non-blocking**，channel 滿的時候會直接 drop：
```go
func (m *mrfState) addPartialOp(op partialOperation) {
    select {
    case m.opCh <- op:
    default:
    }
}
```

實務意義：
- MRF 是「盡力而為」的背景補洞 queue；如果 opCh 壓滿，會直接丟棄新 op。
- 因此你在 incident note 看到「PutObject 當下留下 partial，但後續沒有立刻被補洞」時，除了看 healing/scanner 是否忙，也要記得把 **MRF queue 是否可能被塞滿** 納入判讀。

> 實務上你要回答「MRF 會不會把 healing 打爆」時，最關鍵是看這裡的 channel 緩衝/節流策略 + `healRoutine()` 的 dynamic sleeper。

#### 2.4.3 MRF 的消費端：`mrfState.healRoutine()` 觸發 HealObject
而 MRF queue 的消費端在：
- 檔案：`cmd/mrf.go`
- 函式：`func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 從 `m.opCh` 取出 `partialOperation`
  - 對 bucket/object 會呼叫：`healBucket(bucket, scanMode)` / `healObject(bucket, object, versionID, scanMode)`

### 2.4.3（補）另一個常見 healing 來源：scanner 直接呼叫 `HealObject()`
除了 MRF 會把「缺片」丟進背景補洞之外，MinIO 的 **data scanner** 也可能在掃描時直接觸發 `HealObject()`。

在你目前的 workspace source tree（`/path/to/minio`）裡，最直的落點是：
- 檔案：`cmd/data-scanner.go`
- method：`func (i *scannerItem) applyHealing(ctx context.Context, o ObjectLayer, oi ObjectInfo) (size int64)`

典型程式碼語意（摘出關鍵行為，方便你 grep/對照）：
- 依掃描條件決定 scan mode：
  - 預設 `madmin.HealNormalScan`
  - 若要檢 bitrot → `madmin.HealDeepScan`
- 組 `madmin.HealOpts{ Remove: healDeleteDangling, ScanMode: scanMode }`
- 直接呼叫：`o.HealObject(ctx, i.bucket, i.objectPath(), oi.VersionID, healOpts)`

快速定位：
```bash
cd /path/to/minio

grep -RIn "applyHealing" -n cmd/data-scanner.go
grep -RIn "HealObject(ctx" -n cmd/data-scanner.go | head
```

> 實務判讀：如果你看到「不是新盤事件、也不是 PutObject 剛寫入」但 healing 仍持續出現，scanner 這條線常常是來源之一；它也會跟 I/O 壓力、以及 `canceling remote connection` 這類 grid log 共振。

### 2.4.2 MRF 補洞的「完整 call chain」（精準到檔案/receiver）
把 `mrf.go` 裡的 `healObject(...)` 往下追，你可以把「背景補洞」跟 `HealObject()` 的正式 healing 路徑接起來：

1) `cmd/mrf.go`
- `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - `healObject(bucket, object, versionID, scanMode)`（內部會呼叫 object layer 的 heal）
  - （補）在 `cmd/mrf.go` 裡的 `healObject(...)` helper，最終會呼叫：
    - `z.HealObject(ctx, bucket, object, versionID, madmin.HealOpts{ScanMode: scanMode})`

  你要把這段釘死（方便 incident note 引用）可以直接用 signature grep：
  ```bash
  cd /path/to/minio

  # mrf consumer + helper
  grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go
  grep -RIn "func healObject" -n cmd/mrf.go

  # 版本化物件：versions bytes → UUID 切片解析
  grep -RIn "len(u\.versions)" -n cmd/mrf.go
  ```

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
以下以 workspace 的 MinIO source（`/path/to/minio`）為準（`cmd/mrf.go`）：

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

**讀碼定位建議（在 `/path/to/minio`）：**
```bash
cd /path/to/minio

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

（精準定位建議：在 `/path/to/minio` 直接 `grep -RIn "HealObject(ctx" cmd` + `grep -RIn "healObject(ctx" cmd/erasure-healing.go`。）

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

以 workspace 的 MinIO source（`/path/to/minio`）為準：
```bash
cd /path/to/minio

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

---

## 6) 精準定位「部分寫入」：addPartial → MRF healRoutine → HealObject

如果你在現場看到「PutObject 成功回應」但後續 healing/scanner 突然變多，想快速驗證是不是 **quorum 過了但有洞（partial）**，最有效的是把這 3 個點用 grep 釘死：

1) **PutObject 記 partial 的入口（產生者）**
- 檔案：`cmd/erasure-object.go`
- 常見呼叫：`er.addPartial(bucket, object, fi.VersionID)`
- 常見實作：`func (er erasureObjects) addPartial(...)` → `globalMRFState.addPartialOp(partialOperation{...})`

2) **MRF queue 的消費端（背景補洞調度者）**
- 檔案：`cmd/mrf.go`
- 入口：`func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 從 `m.opCh` 取出 `partialOperation`
  - 依內容呼叫 `healBucket(...)` / `healObject(...)`

3) **真正做修復的 ObjectLayer 路徑（執行者）**
- `cmd/erasure-server-pool.go`：`(*erasureServerPools).HealObject(...)`
- `cmd/erasure-sets.go`：`(*erasureSets).HealObject(...)`
- `cmd/erasure-healing.go`：`erasureObjects.HealObject(...)` → `(*erasureObjects).healObject(...)`

建議你在版本對照時不要猜檔案拆分，直接用 signature grep：
```bash
cd /path/to/minio

grep -RIn "addPartial(" cmd | head -n 50
grep -RIn "globalMRFState\.addPartialOp" cmd | head -n 50

grep -RIn "func (m \*mrfState) healRoutine" cmd/mrf.go

grep -RIn "func (z \*erasureServerPools) HealObject" cmd | head
grep -RIn "func (er \*erasureObjects) healObject" cmd | head
```

> 實務用法：把 grep 結果（檔案/行號）貼到 incident note 裡，後續任何人都可以在同一個 RELEASE tag 上快速跳轉，不需要再重新推一次 call chain。

### 3.2（補）`healObject()` 內部真正重建的三段：Read sources → RS rebuild → RenameData 寫回

> 你要把 Healing 跟「實際磁碟 I/O」對起來時，**最關鍵**的是追到 `(*erasureObjects).healObject()`，因為真正的：
> - 讀哪些 disks/哪些 parts 當來源
> - 何時觸發 `erasure.Heal(...)`（RS 重建）
> - 何時對缺片 disk 做 `RenameData(...)` 寫回
> 都集中在這裡。

以本 workspace 的 MinIO source tree（`/path/to/minio`）為準，你可以用下面方式快速定位：

```bash
cd /path/to/minio

# 1) HealObject() 入口與 healObject() 本體
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go

# 2) RS rebuild 的核心呼叫點
grep -RIn "\\.Heal(ctx" -n cmd/erasure-healing.go cmd/*.go | head

# 3) 寫回缺片的落地點（storage 層 rename）
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head
```

#### 3.2.1 Read sources：`readAllFileInfo()` + 選來源 disks/parts
在 `erasureObjects.HealObject()` 前段通常會做 quick read：
- `readAllFileInfo(ctx, er.getDisks(), bucket, object, versionID, ...)`

目的：
- 把每顆 disk 上的 `xl.meta` / fileInfo 讀回來，判斷：
  - 哪些 disk online/offline
  - 哪些版本/parts 存在
  - 是否需要 heal（缺片/bitrot/metadata 不一致）

你要把「Healing 在讀什麼」跟實際 I/O 對起來時，可以把 `readAllFileInfo` 當作第一個 trace 插點。

#### 3.2.2 RS rebuild：`erasure.Heal(...)` 把缺片重建出來
在 `(*erasureObjects).healObject()` 的中段，會用 `NewErasure(...)` 建好 encoder，然後呼叫：
- `erasure.Heal(ctx, readers, writers, ...)`（或對應版本的 `Heal` 入口）

概念上：
- readers：從「仍然健康的 disks」讀出 shards
- writers：對「缺片/壞片的 disks」寫回重建 shards（通常仍會走 bitrot writer）

你在現場看到 healing 把磁碟打滿（尤其是很多小檔/metadata heavy）時，大多會在這段看到大量 read + write。

#### 3.2.3 RenameData 寫回：`disk.RenameData(...)` 是最明顯的 I/O 原子切換點
Healing 在把缺片重建到 tmp（或新 dataDir）之後，最後會對目標 disks 做 rename/commit，常見會落到：
- `StorageAPI.RenameData(...)`（interface：`cmd/storage-interface.go`）
- `(*xlStorage).RenameData(...)`（實作：`cmd/xl-storage.go`）

這一段是你在 latency/卡住分析上最常需要的落點：
- 如果 rename 阻塞（filesystem、IO scheduler、ext4/xfs 行為、磁碟 latency），Healing 的尾端會被拖長
- 同時間 grid streaming mux 的 ping handler 可能也會因為排程/I/O 壓力延遲，進而與 `canceling remote connection` 這類 log 共振

> 實務上：如果你要在事件中快速「把 symptom 對回 code」，我會建議你在筆記裡同時記兩條鏈：
> 1) `MRF healRoutine → HealObject → healObject → erasure.Heal → RenameData`
> 2) `PutObject → addPartial → MRF`（為什麼突然開始 heal）
> 這樣你在看到 healing/grids logs 互相拉扯時，會更快收斂到底是網路問題還是資源/背景任務造成的心跳延遲。

---

## 7)（補）Healing 如何決定「要修哪些 disk / 哪些 parts」？（disksToHeal / partsToHeal 的讀碼定位）

> 目的：你在現場看到 HealObject 在跑，最常問的其實是：
> - 到底是哪些 disks 被判定缺片/壞片？
> - 這次 heal 是補哪幾個 parts？
> - 為什麼有些 disk 明明 online 但仍被列入 `disksToHeal`？
>
> 這段會把 `(*erasureObjects).healObject()` 裡常見的「判斷點」列成可 grep 的錨點，讓你可以快速跳到 code 對齊。

以 workspace 的 MinIO source tree（`/path/to/minio`）為準，建議直接在 `cmd/erasure-healing.go` 內找這幾個關鍵字：

### 7.1 `disksToHeal` 是怎麼長出來的？
在 `healObject()` 前半段完成：
- `readAllFileInfo(...)`（拿到每顆 disk 的 `FileInfo`/xl.meta）
- `objectQuorumFromMeta(...)`（算 read quorum / 判斷是否可修）
- `pickValidFileInfo(...)`（挑一個最可信的版本基準）

接著通常會進入：
- 比對每顆 disk 的 `FileInfo`：
  - 是否 missing
  - 是否 part 缺失
  - 是否 bitrot / checksum mismatch
  - 是否 metadata 不一致

最後得到類似：
- `disksToHeal []StorageAPI`（需要被修的那些 disk）
- `partsToHeal []int`（需要被重建的 part 編號）
- `disksToHealCount`（要修的 disk 數量）

快速定位（不依賴 `rg`）：
```bash
cd /path/to/minio

# 直接在 healing 主檔找關鍵變數（不同版本命名可能略有差，但多半相近）
grep -n "disksToHeal" -n cmd/erasure-healing.go | head -n 50
grep -n "partsToHeal" -n cmd/erasure-healing.go | head -n 50
```

### 7.2 `disksWithAllParts()`：哪些 disks 可以當作重建來源？
即使有 disks 要被 heal，也不是所有 online disks 都能當來源；通常會先用：
- `disksWithAllParts(...)`
挑出「有完整 parts 且 metadata 合法」的 disks，作為 `erasure.Heal()` 的 readers。

定位：
```bash
cd /path/to/minio

grep -RIn "disksWithAllParts" -n cmd/erasure-healing.go cmd/*.go
```

### 7.3 真正 RS 重建時：`erasure.Heal(readers, writers, ...)` 的 readers/writers 對應
當 `partsToHeal` / `disksToHeal` 決定好後，`healObject()` 後半段會針對每個 `partNumber`：
- 建 readers：只從「健康來源 disks」讀 `part.N`
- 建 writers：只對「需要被修的 disks」寫 `part.N`（先寫到 `.minio.sys/tmp/<tmpID>`）
- 呼叫 `erasure.Heal(...)` 重建
- 最後 `disk.RenameData(...)` 寫回（原子切換點）

你在現場要對齊 I/O 的話，最重要的三個 grep 錨點依序是：
```bash
cd /path/to/minio

grep -RIn "readAllFileInfo" -n cmd/erasure-healing.go | head
grep -RIn "\\.Heal(ctx" -n cmd/erasure-healing.go cmd/*.go | head
grep -RIn "RenameData" -n cmd/erasure-healing.go cmd/xl-storage.go | head
```

> 實務判讀：
> - `readAllFileInfo` 很重 → 大量 `xl.meta` 讀取 + fan-out（小檔/大量版本時特別明顯）
> - `erasure.Heal` 很重 → 讀來源 shards + 寫回 shards
> - `RenameData` 卡住 → 常見是 filesystem/磁碟 latency、或目標 disk 本身異常
>
> 這三段任一段被拖慢，都可能讓 grid ping/pong handler 延遲累積，最後跟 `canceling remote connection` 共振。

---

## 8)（補）把 Healing 跟 `mc admin trace` 對齊：`healTrace()` / `madmin.TraceHealing`

當你在 production 想用 `mc admin trace` 把「HealObject 到底在修什麼」抓成事件流，最直接的 source code 錨點是 `healTrace()`：

- 檔案：`cmd/erasure-healing.go`
- function：`healTrace(...)`
- 事件類型：`madmin.TraceHealing`

你可以用下面的 grep 快速把它釘死（不同版本行號會飄，但函式名通常不變）：

```bash
cd /path/to/minio

# HealObject 內部 trace 的產生點
grep -RIn "healTrace" -n cmd/erasure-healing.go cmd/*.go | head -n 50

# TraceHealing enum / 欄位定義在 madmin-go（不同版本路徑可能不同）
grep -RIn "TraceHealing" -n . | head -n 50
```

實務判讀：
- 若你在 `mc admin trace --type healing`（或 internal trace）看到 healing 事件量暴增、且 duration 拉長，同時間又出現 `canceling remote connection ... not seen for ...`，通常代表「修復路徑把 I/O/排程壓力拉高」而不是單純網路抖動。

---

## 9)（新增）跟 `canceling remote connection` 的「最短因果鏈」對照（方便寫 incident note）

你在現場最常需要寫成一句話、且能回鏈到 code 的版本化描述。建議用下面這條最短鏈：

1) **PutObject quorum 達成但留下缺片（partial）**
- `cmd/erasure-object.go`：`erasureObjects.putObject()` 在 `commitRenameDataDir(...)` 後段偵測到部分 `onlineDisks[i]` offline → `er.addPartial(bucket, object, fi.VersionID)`（或 `versions` disparity → `globalMRFState.addPartialOp(...)`）

2) **MRF 背景補洞開始跑（HealObject）**
- `cmd/mrf.go`：`(*mrfState).healRoutine()` 消費 `partialOperation` → `z.HealObject(...)`

3) **Healing 真正重建/寫回造成 I/O 壓力**
- `cmd/erasure-healing.go`：`(*erasureObjects).healObject()` 內部 `readAllFileInfo(...)` / `erasure.Heal(...)` / `disk.RenameData(...)`

4) **grid streaming mux 心跳（ping）因資源壓力延遲 → 觸發 watchdog**
- `minio/internal/grid/muxserver.go`：`(*muxServer).checkRemoteAlive()` 判定 `LastPing` 超過 threshold → 印 `canceling remote connection ... not seen for ...` → `m.close()`

> 延伸閱讀（同 repo）：`docs/troubleshooting/canceling-remote-connection.md`

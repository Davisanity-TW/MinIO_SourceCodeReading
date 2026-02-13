# Healing 路徑追蹤（背景掃描 → heal 調度 → erasure heal）

> 目標：把 MinIO 的 **Healing**（修復/重建）從「觸發點」到「實際做哪些讀寫」串起來，讓你能定位：
> - 什麼情境會觸發 healing（啟動、磁碟掉線/回復、讀取時發現不一致、後台掃描）
> - healing 的工作單位（bucket/object/part）與佇列/節流
> - erasure heal 的 quorum 與資料重建方式

> 本頁以 **MinIO master (GitHub)** 的程式碼結構/檔名做索引；你實際線上版本（RELEASE tag）可能有差異。

---

## 0) Healing 在 MinIO 裡大致分幾類？
- **啟動後的 background healing**：背景慢慢掃、慢慢補（避免啟動後立刻打爆磁碟）
- **online healing**：讀/寫路徑上發現損壞或缺片，觸發更即時的修復
- **admin/heal API**：管理者手動下指令（或 UI / `mc admin heal`）
- **disk/drive 事件驅動（Auto drive healing）**：偵測到新盤/回復後，針對缺失資料做補齊

---

## 1) 觸發點（Trigger points）— 先從「自動新盤 healing」落地

### 1.0 先把「背景 healing」的兩條主線分清楚（讀碼時比較不會迷路）
MinIO 啟動後通常同時存在兩套「會丟 heal 任務」的來源：

1) **新盤/回復事件導向**（auto drive healing）
- 入口：`cmd/background-newdisks-heal-ops.go: initAutoHeal()`
- 特色：會鎖住 *特定 poolIdx/setIdx*，針對「某顆 disk」做集中式補齊

2) **背景掃描/例行調度導向**（background heal routine）
- 入口：`cmd/background-heal-ops.go: initBackgroundHealing()`
- 特色：以 `healTask{bucket, object,...}` 為工作單位，worker 端統一分流到：
  - `objAPI.HealFormat()` / `objAPI.HealBucket()` / `objAPI.HealObject()`

> 實務上你看到「heal 很忙」時，先判斷是 (1) 某顆盤回復在補齊，還是 (2) background/scanner/MRF 在丟 object heal，方向會差很多。

### 1.1 `initAutoHeal()`：啟動後掛上自動 healing 的地方
- 檔案：`cmd/background-newdisks-heal-ops.go`
- function：`func initAutoHeal(ctx context.Context, objAPI ObjectLayer)`

重點（實際 code 行為）：
- 只在 erasure 模式才會做（`objAPI.(*erasureServerPools)`）
- 啟動「快速 background healing」：
  - `initBackgroundHealing(ctx, objAPI)`
- 若 `_MINIO_AUTO_DRIVE_HEALING` 開啟（預設 on），會：
  - `globalBackgroundHealState.pushHealLocalDisks(getLocalDisksToHeal()...)`
  - `go monitorLocalDisksAndHeal(ctx, z)`

> 也就是：**啟動後會有一條 goroutine 週期性檢查本機 disks 狀態並觸發 heal**。

### 1.2 `monitorLocalDisksAndHeal()`：每 10s 檢查一次
- 檔案：`cmd/background-newdisks-heal-ops.go`
- interval：`defaultMonitorNewDiskInterval = 10s`

流程（概念）：
1) 從 `globalBackgroundHealState.getHealLocalDiskEndpoints()` 取待 heal disks
2) 先嘗試 `z.HealFormat(...)`（會 reformat unformatted disk / 或確認狀態）
3) 對每顆 disk 起 goroutine：
   - `healFreshDisk(ctx, z, diskEndpoint)`

### 1.3 `initBackgroundHealing()`：背景 healer worker（不是新盤）
除了「新盤/回復」驅動的 healing 之外，MinIO 還會在啟動後啟動一組 **background healer**，用來處理各種 healing task（bucket/object/format）。

- 檔案：`cmd/background-heal-ops.go`
- 入口：`func initBackgroundHealing(ctx context.Context, objAPI ObjectLayer)`
  - 建 `bgSeq := newBgHealSequence()`
  - 起多個 worker：`go globalBackgroundHealRoutine.AddWorker(ctx, objAPI, bgSeq)`
  - `globalBackgroundHealState.LaunchNewHealSequence(bgSeq, objAPI)`（排程/序列狀態）

worker 端的「實際分流」在：
- `cmd/background-heal-ops.go: (*healRoutine).AddWorker()`：

實際 switch 長這樣（精準到 bucket/object 的語意分流）：
- `task.bucket == nopHeal`：直接 skip（`errSkipFile`）
- `task.bucket == "/"`（`SlashSeparator`）：`healDiskFormat()` → `objAPI.HealFormat()`
- `task.bucket != "/"` 且 `task.object == ""`：`objAPI.HealBucket()`
- `task.bucket != "/"` 且 `task.object != ""`：`objAPI.HealObject()`

另外，healing task 的工作單位定義在同檔案：
- `type healTask struct { bucket, object, versionID string; opts madmin.HealOpts; respCh chan healResult }`
- 註解直接寫了「path 語意」：
  - `path: '/'` → heal disk formats（含 metadata）
  - `path: 'bucket/' or '/bucket/'` → heal bucket
  - `path: 'bucket/object'` → heal object

> 讀碼時你可以把它當成：**一個統一的 healing task executor**。

### 1.4 "online healing" 的一個常見來源：scanner 發現不一致
如果你想把「讀/掃描時發現壞片」連到 `HealObject()`，最直接的落點在：
- 檔案：`cmd/data-scanner.go`
- method：`func (i *scannerItem) applyHealing(ctx context.Context, o ObjectLayer, oi ObjectInfo) (size int64)`

你可以在這裡看到 scanner 對每個掃描到的 object/version 會（依 scan mode）呼叫：
```go
scanMode := madmin.HealNormalScan
if i.heal.bitrot {
    scanMode = madmin.HealDeepScan
}
healOpts := madmin.HealOpts{ Remove: healDeleteDangling, ScanMode: scanMode }
res, _ := o.HealObject(ctx, i.bucket, i.objectPath(), oi.VersionID, healOpts)
```

幾個實務重點：
- **Deep scan 不是預設**：只有在 scanner 設定 `i.heal.bitrot` 時才會用 `madmin.HealDeepScan`（bitrot check 更重）。
- `Remove: healDeleteDangling` 代表 healing 會順便清掉 dangling 資料（需要搭配 `HealObject()` 內部判斷）。
- 這條路徑常見的運維現象是：
  - 平常沒有 admin heal 也沒有新盤事件
  - 但 scanner 週期掃到不一致（或 bitrot / missing parts）→ 觸發 heal object

---

## 2) 單顆 disk healing 的實際工作：`healFreshDisk()`

- 檔案：`cmd/background-newdisks-heal-ops.go`
- function：`func healFreshDisk(ctx context.Context, z *erasureServerPools, endpoint Endpoint) error`

你想追的「實際 call chain」在這裡已經很清楚：

### 2.1 防止同一個 erasure set 平行 healing（namespace lock）

```go
locker := z.NewNSLock(minioMetaBucket, fmt.Sprintf("new-drive-healing/%d/%d", poolIdx, setIdx))
lkctx, err := locker.GetLock(ctx, newDiskHealingTimeout)
...
defer locker.Unlock(lkctx)
```

> 這個鎖很重要：如果你看到 healing 卡住/同 set 被重複觸發，這裡是第一個觀察點。

### 2.2 Healing tracker：`.healing.bin`
- 檔案：`cmd/background-newdisks-heal-ops.go`
- 常數：`healingTrackerFilename = ".healing.bin"`
- 位置：`minioMetaBucket/pathJoin(bucketMetaPrefix, ".healing.bin")`

這個 tracker 會持久化：
- `ItemsHealed/ItemsFailed/ItemsSkipped`、`BytesDone/BytesFailed/...`
- 目前掃到的 `Bucket/Object`
- `QueuedBuckets/HealedBuckets`
- `HealID`、`Started/LastUpdate` 等

（對應型別：`type healingTracker struct { ... }`）

> 實務上：你用 `mc admin heal alias/ --verbose` 看到的狀態，很多就是從這類 tracker/state 反映出來的。

### 2.3 真的開始 heal：`healErasureSet()`

`healFreshDisk()` 會列 bucket 並把 meta buckets 也加進去：
- `z.ListBuckets(ctx, BucketOptions{})`
- append：
  - `minioMetaBucket/minioConfigPrefix`
  - `minioMetaBucket/bucketMetaPrefix`

然後關鍵呼叫是：

```go
err = z.serverPools[poolIdx].sets[setIdx].healErasureSet(ctx, tracker.QueuedBuckets, tracker)
```

補兩個容易誤會的點：
1) `serverPools[poolIdx].sets[setIdx]` 這裡的 `sets[*]` 在目前 source tree 裡其實是 **`*erasureObjects`**（也就是「一個 erasure set 的 object layer 實作」）。
2) `healErasureSet` 的實作點在：
   - `cmd/global-heal.go`：`func (er *erasureObjects) healErasureSet(ctx context.Context, buckets []string, tracker *healingTracker) error`

> 這行就是「進到特定 poolIdx/setIdx 的底層 erasure set healing」的入口。

### 2.4 retry 行為（為什麼你會看到同一顆盤反覆 heal）
在 `healFreshDisk()` 內：
- 若 `tracker.ItemsFailed > 0` 且 `tracker.RetryAttempts < 4`，會 `RetryAttempts++`，並回傳 `errRetryHealing` 讓上層稍後重試。

---

## 3) Erasure heal 的核心動作（你下一步要追的最底層）

有了上面的入口後，你接下來的讀碼目標會是（以 `/home/ubuntu/clawd/minio` 這份 source tree 對照）：

- `cmd/global-heal.go`：`func (er *erasureObjects) healErasureSet(ctx context.Context, buckets []string, tracker *healingTracker) error`

### 3.1 `healErasureSet()` 一進來先做什麼？（實際 code 片段）
在 `cmd/global-heal.go:145`（目前 workspace 版本）可以看到三個非常實務的重點：

1) **先把 bucket heal 一輪（即使後面才開始掃 objects）**
```go
for _, bucket := range healBuckets {
    _, err := objAPI.HealBucket(ctx, bucket, madmin.HealOpts{ScanMode: scanMode})
    ...
}
```
而且在「逐 bucket heal」的主迴圈開始前，還會再對該 bucket `HealBucket()` 一次（用來處理一開始 bucket heal 失敗、但後面要 retry 的情境）。

2) **用 disk 的 `NRRequests` + CPU core 估算 healer worker 數量**
```go
info, _ := tracker.disk.DiskInfo(ctx, DiskInfoOptions{})
if info.NRRequests > uint64(runtime.GOMAXPROCS(0)) {
    numHealers = uint64(runtime.GOMAXPROCS(0)) / 4
} else {
    numHealers = info.NRRequests / 4
}
if numHealers < 4 { numHealers = 4 }
if v := globalHealConfig.GetWorkers(); v > 0 { numHealers = uint64(v) }
```
> 這段在排查「heal 太慢/太快打爆磁碟」時很好用：你能快速看出 worker 數量是怎麼算出來、以及如何被 `globalHealConfig` 覆寫。

3) **選一組可用 disks 當來源（quorum-like），避免把 healing disk 拿來當來源**
- `disks, _, healing := er.getOnlineDisksWithHealingAndInfo(true)`
- `disks = disks[:len(disks)-healing]`（把 healing disks 切掉）
- `expectedDisks := len(disks)/2 + 1`（抓「過半」當來源）

### 3.2 object/entry 是怎麼被掃到並丟給 heal worker？
同一個 function 後段可以看到：
- 建立 worker pool：`jt, _ := workers.New(int(numHealers))`
- 建立 `results` channel，集中更新 tracker（避免多 goroutine 直接寫 tracker）
- `healEntry(bucket, entry metaCacheEntry)`：對每個 metacache entry 做 heal

`healEntry()` 裡的關鍵點：
- 會跳過 dir（`entry.isDir()`）、以及 `.minio.sys` 下的 `.metacache/.trash/multipart` 等系統路徑
- 會把 entry name 做 encode（erasureObjects 需要 encoded object name）：`encodeDirObject(entry.name)`
- 如果 entry 解析 fileInfo 失敗，會直接走：
  - `er.HealObject(ctx, bucket, encodedEntryName, "", madmin.HealOpts{ScanMode: scanMode, Remove: healDeleteDangling})`

而更底層的動作仍然是：
- 讀 `xl.meta` → 判斷 shard/parts → 滿足 read quorum → Reed-Solomon reconstruct → 寫回缺片 → 更新 meta

> 小結：新盤自動 heal 的呼叫鏈已經很「直通」：`healFreshDisk()`（`cmd/background-newdisks-heal-ops.go`）→ `sets[setIdx].healErasureSet()`（同檔案呼叫點）→ `cmd/global-heal.go: (*erasureObjects).healErasureSet()`。

你最關心的問題（建議對照到 code 的 checklist）：
- **heal quorum 怎麼算？**（read quorum / write quorum）
- **是只補缺片、還是整段重寫？**（缺損類型/metadata 狀態/bitrot）
- **如何避免 concurrent update？**（namespace lock / versioning / temp object）

---

## 3.3 `HealObject()` 的實際呼叫鏈（精準到檔案/函式）

當 healing 的工作單位落到「某個 object」時，最常見的呼叫鏈（以 `/home/ubuntu/clawd/minio` source tree 為準）是：

1) `cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - 這層會做 pool 選擇/前置處理，然後把 heal 交給 set。

2) `cmd/erasure-sets.go`
- `func (s *erasureSets) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - 這層會把 object hash 到特定 set，最後落到該 set 的 `erasureObjects`。

3) `cmd/erasure-healing.go`
- `func (er erasureObjects) HealObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) (hr madmin.HealResultItem, err error)`
  - 這裡會先做「快速 read（不拿 lock）」：`readAllFileInfo(..., false, false)`
    - 如果 *all not found* → 直接回傳 default heal result。
  - 然後呼叫：`er.healObject(...)` 做真正的修復。
  - 一個很重要的分支：若偵測到 `errFileCorrupt` 且 `opts.ScanMode != madmin.HealDeepScan`，會 **自動改成 deep scan 再 heal 一次**（讓 bitrot 檢查更完整）。

4) `cmd/erasure-healing.go`
- `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - 若 `!opts.NoLock`：會 `er.NewNSLock(bucket, object)` 拿 namespace lock，再重新 `readAllFileInfo(..., true, true)`。
  - 會用 `objectQuorumFromMeta(...)` 算出 `readQuorum`，並把 `DataBlocks/ParityBlocks` 寫到 heal result。
  - 會 `pickValidFileInfo(...)` 選出 latest 的 `xl.meta`（modtime/etag/quorum）。
  - 會 `disksWithAllParts(...)` / `NewErasure(...)` 決定可重建來源與建立 RS encoder。

### 4.1 `healObject()` 內部「兩段 readAllFileInfo」的用意（實戰觀察點）
同一個 object heal，通常會看到 **至少一次** `readAllFileInfo(...)`，而在 `!opts.NoLock` 時會在拿到 namespace lock 後再讀一次：

- **第一次（可能不拿 lock）**：快速判斷「是不是 all not found / 是否需要進一步」
- **第二次（拿 lock 後）**：確保在修復時看到的 `xl.meta`/parts 狀態是穩定的，並避免 concurrent update 造成「剛重建完又被覆寫」

因此你在排查：
- heal 一直 retry、或 heal 看似成功但很快又進 heal
- heal latency 很高（尤其是 metadata heavy bucket）

時，通常可以把 profiling/trace 觀察點放在：
- `readAllFileInfo(...)`（讀 meta/parts 的 fan-out）
- `objectQuorumFromMeta(...)`（quorum 計算/判斷讀不到 vs 壞掉）
- `pickValidFileInfo(...)`（選哪一份 meta 當準）

> 這條鏈的好處：你排「HealObject 很慢 / 一直 retry / 為什麼進 deep scan」時，幾乎每個觀察點都能在 `cmd/erasure-healing.go` 找到對應的 if/loop。

### 4.2 `healObject()` 內部的「精準步驟」（把流程補到實際函式名）
以下以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準（`cmd/erasure-healing.go:242` 起），把 `healObject()` 前半段最常用的判讀點補成「可 grep 的函式名」：

1) **拿 lock（預設會拿）**
- `er.NewNSLock(bucket, object)` → `lk.GetLock(ctx, globalOperationTimeout)`

2) **拿到 lock 後「重新讀一次 metadata」**（這輪才是用來做修復判斷的基準）
- `readAllFileInfo(ctx, storageDisks, "", bucket, object, versionID, true, true)`

3) **用 metadata 計算 read quorum（如果連 quorum 都不滿足，可能會走 dangling purge）**
- `objectQuorumFromMeta(ctx, partsMetadata, errs, er.defaultParityCount)`
- 若 quorum 算不出來：
  - `er.deleteIfDangling(ctx, bucket, object, partsMetadata, errs, nil, ObjectOptions{VersionID: versionID})`

4) **挑出「最新且可用」的 `xl.meta` 當作修復的 reference**
- `listOnlineDisks(storageDisks, partsMetadata, errs, readQuorum)` → 回 `(onlineDisks, modTime, etag)`
- `pickValidFileInfo(ctx, partsMetadata, modTime, etag, readQuorum)` → `latestMeta`

5) **確認哪些 disks 真的「有齊 parts」可當重建來源**
- `disksWithAllParts(ctx, onlineDisks, partsMetadata, errs, latestMeta, bucket, object, scanMode)`

6) **需要 RS 重建時才初始化 erasure encoder**
- `NewErasure(ctx, latestMeta.Erasure.DataBlocks, latestMeta.Erasure.ParityBlocks, latestMeta.Erasure.BlockSize)`

7) **後續才開始判斷哪些 disks 是 outdated / missing parts，並決定要 heal 的項目**
- `for i, v := range availableDisks { ... }`（對每顆 disk 計算 driveState / 是否要補）

> 小結：在你遇到「heal 一直跑但看不懂在忙什麼」時，通常先把 `objectQuorumFromMeta`（是否滿足 quorum）、`pickValidFileInfo`（以誰為準）、`disksWithAllParts`（重建來源夠不夠）這三點釐清，方向會非常快收斂。

---

## 4.3 `healObject()` 的「重建/寫回」主流程（精準到函式名）

前面 4.2 已經把 `healObject()` 的「拿 lock → 讀 meta → 算 quorum → 選 latestMeta → 決定可用 disks」補齊。
接下來這一段才是 *真正把缺片/壞片重建出來並寫回 disk* 的核心。

以下以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準：
- 檔案：`cmd/erasure-healing.go`
- function：`func (er *erasureObjects) healObject(...)`
- 主要段落：`~:430` 之後（以你當前 checkout 為準）

### A) 先把 disks/metadata reorder 成「data 盤在前、parity 盤在後」
用來確保後面讀寫 shard 的 index/分布一致：
- `shuffleDisks(availableDisks, latestMeta.Erasure.Distribution)` → `latestDisks`
- `shuffleDisks(outDatedDisks, latestMeta.Erasure.Distribution)` → `outDatedDisks`
- `shufflePartsMetadata(partsMetadata, latestMeta.Erasure.Distribution)` → `partsMetadata`

同時把需要修復的 disks 其 `partsMetadata[i]` 直接設成 `latestMeta`（清掉 inline data/checksums/index），確保寫回的是 quorum 期望的那份 metadata：
- `cleanFileInfo(latestMeta)`

### B) 準備 tmp 寫入位置（避免 partial write 直接覆蓋正式資料）
- `tmpID := mustGetUUID()`
- `migrateDataDir := mustGetUUID()`（主要用在 XLV1 遷移）
- `srcDataDir := latestMeta.DataDir`
- `dstDataDir := latestMeta.DataDir`（若 `latestMeta.XLV1` 則改用 `migrateDataDir`）

> 這裡的 `tmpID` + `dstDataDir` 對應到後面寫入 `.minio.sys/tmp/<tmpID>/<dstDataDir>/part.N`。

### C) 逐 part 做 RS 重建：`erasure.Heal()`（讀 readers → 寫 writers）
對每個 `partNumber`：
1) 組 reader（從「健康 disks」讀 shard）：
   - `newBitrotReader(disk, ..., bucket, partPath, ..., checksumAlgo, checksumInfo.Hash, erasure.ShardSize())`
2) 組 writer（寫到 `.minio.sys/tmp`）：
   - 非 inline：`newBitrotWriter(disk, bucket, minioMetaTmpBucket, partPath, ..., DefaultBitrotAlgorithm, erasure.ShardSize())`
   - inline data：`newStreamingBitrotWriterBuffer(...)`（最後塞到 `partsMetadata[i].Data`）
3) 核心重建：
   - `err = erasure.Heal(ctx, writers, readers, partSize, prefer)`

完成後會把已修復的 part 加回該 disk 的 metadata：
- `partsMetadata[i].DataDir = dstDataDir`
- `partsMetadata[i].AddObjectPart(partNumber, "", partSize, partActualSize, partModTime, partIdx, partChecksums)`

### D) 把 `.minio.sys/tmp` rename 回正式路徑：`disk.RenameData()`
對每顆修復成功的 disk：
- `partsMetadata[i].Erasure.Index = i + 1`（記錄更新 disk 的 index）
- `partsMetadata[i].SetHealing()`（標記 healing 狀態）
- `disk.RenameData(ctx, minioMetaTmpBucket, tmpID, partsMetadata[i], bucket, object, RenameOptions{})`

#### D.1 `RenameData()` 的實作位置（落地到 storage 層）
以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準：
- interface：`cmd/storage-interface.go`（`StorageAPI`）
  - grep：`RenameData(ctx` / `RenameData(`
- 實作（本地 FS / XL）：`cmd/xl-storage.go`
  - grep：`func (s *xlStorage) RenameData(`

`HealObject/healObject` 在這裡做 rename 的意義是：
- 先把重建出的 parts 寫到 `.minio.sys/tmp/<tmpID>/<dataDir>/part.N`
- 最後用 `RenameData` 以接近原子性的方式把 tmp 變成正式資料路徑

> 實戰：如果你看到 heal 卡很久但 CPU 不高，優先看 `RenameData()` 是否在某些磁碟上被 I/O latency 卡住（或遇到 filesystem error）。

最後：
- `defer er.deleteAll(context.Background(), minioMetaTmpBucket, tmpID)`
  - 代表 tmp 資料會在 heal 結束後被清掉（成功/失敗都會走 defer）

> 這段的讀碼價值：你在排查「heal 很慢」「某些 disk 一直修不好」「heal 後還是壞」時，直接看 `erasure.Heal()` 是不是卡在 reader（來源盤讀不出/bitrot）或 writer（目標盤寫入錯誤/latency），通常比只看外層 `HealObject()` log 直覺很多。

---

## 3.4) 運維現象對照：Healing 高負載 ↔ `canceling remote connection`

如果你在 production 看到：
- healing/scanner/MRF 補洞在跑
- 同時間大量出現 `canceling remote connection ... not seen for ...`

常見的解釋是：**Healing 讀來源 shards + 寫回缺片** 把磁碟 I/O（加上 Go runtime 排程/GC）推高，導致 inter-node grid 的 ping/pong handler 來不及處理。

建議你把觀察點對準到最底層 3 個位置（好下斷點/好做 profiling）：
- `readAllFileInfo(...)`（metadata fan-out，`cmd/erasure-healing.go`）
- `erasure.Heal(...)`（真正 RS 重建，`cmd/erasure-healing.go`）
- `disk.RenameData(...)`（寫回/rename，`cmd/erasure-healing.go` → storage 層 `cmd/xl-storage.go`）

Troubleshooting 參考：`docs/troubleshooting/canceling-remote-connection.md`（含 MRF/Healing 交叉驗證）。

---

## 4) 讀碼下一步（先把你最需要排障的點補齊）
- [ ] 從 `cmd/background-newdisks-heal-ops.go` 接到 `sets[setIdx].healErasureSet()` 的實作檔案與函式簽名
- [ ] 找出「background healing（非新盤）」的 scheduler/worker（`initBackgroundHealing` 內部）
- [ ] 把 `.healing.bin` 的 lifecycle（建立/更新/刪除）與何時會消失，整理成運維可用的判讀規則
- [ ] 把「常見告警/現象」對應到 code 路徑：
  - drive offline / online
  - healing stuck / 重試次數增加
  - insufficient read quorum / write quorum
  - checksum mismatch / bitrot

---

## 5. 本輪進度
- 補齊「自動新盤 healing」的實際入口與呼叫鏈：`initAutoHeal` → `monitorLocalDisksAndHeal` → `healFreshDisk` → `sets[setIdx].healErasureSet`
- 補齊 `.healing.bin` healing tracker（檔名/存放位置/用途）與 namespace lock 的實際 key


## .healing.bin 在哪裡？（預設路徑/內容）

你看到的這段：

- `minioMetaBucket/pathJoin(bucketMetaPrefix, ".healing.bin")`

在 code 上可對到：
- `cmd/object-api-utils.go`：`minioMetaBucket = ".minio.sys"`
- `cmd/object-api-common.go`：`bucketMetaPrefix = "buckets"`
- `cmd/background-newdisks-heal-ops.go`：`healingTrackerFilename = ".healing.bin"`

### 1) 在「檔案系統/本地磁碟」上，預設實體路徑
當 storage backend 是本地檔案系統（XL/erasure），`xlStorage.Healing()` 直接用 OS 讀檔：
- `cmd/xl-storage.go`：
  - `healingFile := pathJoin(s.drivePath, minioMetaBucket, bucketMetaPrefix, healingTrackerFilename)`

因此每顆資料碟（`drivePath`）上會有：

- `<drivePath>/.minio.sys/buckets/.healing.bin`

> 分散式/多節點時：每個 node 的每顆 disk 都各自有一份。

### 2) .healing.bin 內容是「進度/狀態」，不是完整 object 清單
`.healing.bin` 對應結構是 `healingTracker`（`cmd/background-newdisks-heal-ops.go`）。
它會記錄：
- disk/pool/set/disk index、endpoint
- heal start/last update
- items healed/failed/skipped、bytes done/failed/skipped
- **最後掃到哪個 bucket/object（Bucket/Object 欄位）**
- queued/healed buckets

但它 **沒有把『所有正在 heal 的 objects 清單』完整持久化**。
你通常只能從 `Bucket`/`Object` 看到「最後掃描/處理到哪裡」。

### 3) 如果你要看「目前 heal 的 object 清單」應該去哪裡看？
MinIO 會透過 admin heal API/CLI 在執行時回報細節。實務上可用：
- `mc admin heal <alias> --recursive --json`（或搭配 `--scan deep`）
  - 這會輸出每個 object 的 heal 狀態（適合留存/管線化）。

> TODO：後續把 admin heal handler（server side）與 `madmin-go` 的輸出欄位也對到 source code，讓你能把 JSON 欄位一路 trace 回內部流程。

---

## 6) `HealBucket()` / `HealFormat()` / `HealObject()` 的落地實作位置（把「調度」接到「實作」）

上面提到 background heal worker 會依 `healTask` 的 path 語意分流到：
- `objAPI.HealFormat()`
- `objAPI.HealBucket()`
- `objAPI.HealObject()`

要把「調度」接到「真正做事的地方」，你可以沿著 ObjectLayer 的 receiver 往下追：

### 6.1 `HealFormat()`（修 format / metadata）
- interface：`cmd/object-api-interface.go`（`ObjectLayer`）
- 常見實作：`cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealFormat(...)`

背景 worker 的呼叫點在：
- `cmd/background-heal-ops.go`：`(*healRoutine).AddWorker()`
  - `task.bucket == "/"`（`SlashSeparator`）→ `healDiskFormat()` → `objAPI.HealFormat()`

### 6.2 `HealBucket()`（bucket 層 metadata / bucket-level healing）
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealBucket(ctx, bucket string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

典型 call chain：
- `(*healRoutine).AddWorker()` → `objAPI.HealBucket()` → `erasureServerPools`（做 pool/set 選擇/並行） → set/object 層（視版本拆檔不同）

### 6.3 `HealObject()`（object repair 的主線，最後落到 `erasureObjects.healObject`）
這條鏈已在前文 3.3 補過，但在實作定位上你可以記這三個最穩的落點：
- `cmd/erasure-server-pool.go`：`(*erasureServerPools).HealObject()`
- `cmd/erasure-sets.go`：`(*erasureSets).HealObject()`
- `cmd/erasure-healing.go`：`erasureObjects.HealObject()` → `(*erasureObjects).healObject()`

### 6.4 快速 grep 指令（不用猜檔案拆分）
不同 RELEASE tag 可能把 heal 相關檔案拆分/合併，最穩的方式是直接 grep signature：
```bash
cd /home/ubuntu/clawd/minio

# HealFormat/HealBucket/HealObject 實作
grep -RIn "func (z \\*erasureServerPools) HealFormat" cmd/*.go
grep -RIn "func (z \\*erasureServerPools) HealBucket" cmd/*.go
grep -RIn "func (z \\*erasureServerPools) HealObject" cmd/*.go

# 真正 object heal 的底層
grep -RIn "func (er \\*erasureObjects) healObject" cmd/*.go
```

> 用意：當你看到「background/auto-heal 在跑」但不確定到底修了什麼，先用這些入口把 receiver 釐清，再回頭對照 `readAllFileInfo` / `objectQuorumFromMeta` / `erasure.Heal` / `RenameData` 這幾個最關鍵的重建與寫回點。

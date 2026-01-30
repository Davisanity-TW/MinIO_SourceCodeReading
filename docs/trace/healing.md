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

> 這行就是「進到特定 poolIdx/setIdx 的底層 erasure set healing」的入口。

### 2.4 retry 行為（為什麼你會看到同一顆盤反覆 heal）
在 `healFreshDisk()` 內：
- 若 `tracker.ItemsFailed > 0` 且 `tracker.RetryAttempts < 4`，會 `RetryAttempts++`，並回傳 `errRetryHealing` 讓上層稍後重試。

---

## 3) Erasure heal 的核心動作（你下一步要追的最底層）

有了上面的入口後，你接下來的讀碼目標會是（以 `/home/ubuntu/clawd/minio` 這份 source tree 對照）：

- `cmd/global-heal.go`：`func (er *erasureObjects) healErasureSet(ctx context.Context, buckets []string, tracker *healingTracker) error`
  - 這裡會先對每個 bucket 呼叫：`objAPI.HealBucket(ctx, bucket, madmin.HealOpts{ScanMode: ...})`
  - 接著依 disk 的 `NRRequests`/CPU core 估算 worker 數量（`globalHealConfig.GetWorkers()` 可覆寫）
  - 然後進入「逐 bucket 掃描 object、分派到 worker heal」的主迴圈（同檔案後段可繼續往下追）

而更底層的動作仍然是：
- 讀 `xl.meta` → 判斷 shard/parts → 滿足 read quorum → Reed-Solomon reconstruct → 寫回缺片 → 更新 meta

> 小結：新盤自動 heal 的呼叫鏈已經很「直通」：`healFreshDisk()`（`cmd/background-newdisks-heal-ops.go`）→ `sets[setIdx].healErasureSet()`（同檔案呼叫點）→ `cmd/global-heal.go: (*erasureObjects).healErasureSet()`。

你最關心的問題（建議對照到 code 的 checklist）：
- **heal quorum 怎麼算？**（read quorum / write quorum）
- **是只補缺片、還是整段重寫？**（缺損類型/metadata 狀態/bitrot）
- **如何避免 concurrent update？**（namespace lock / versioning / temp object）

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

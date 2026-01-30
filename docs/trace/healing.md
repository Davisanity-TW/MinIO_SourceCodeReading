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

有了上面的入口後，你接下來的讀碼目標會是：
- `(*erasureSets).healErasureSet(...)`（實作位置依版本，通常在 `cmd/erasure-heal*.go` / `cmd/erasure-sets*.go`）
- `(*erasureObjects).HealObject(...)` / `HealBucket(...)`（名稱依版本）
- 讀 `xl.meta` → 判斷 shard/parts → 滿足 read quorum → Reed-Solomon reconstruct → 寫回缺片 → 更新 meta

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

# HealObject 路徑追蹤（入口來源 → ObjectLayer → erasureObjects.healObject → RS rebuild → RenameData）

> 目標：把「物件修復（HealObject）」的主流程補成**可直接 grep 對齊**的讀碼筆記：
> - Healing 的入口來源（MRF / scanner / admin heal）
> - 正式 ObjectLayer call chain（serverPools → sets → objects）
> - `(*erasureObjects).healObject()` 內部的 5 個關鍵步驟（讀 meta → 選 quorum → RS rebuild → 寫 tmp → RenameData 寫回）
>
> 註：檔名/函式名以 upstream MinIO 的慣例為主；不同 RELEASE tag 可能拆檔或略改命名，但下面列的「關鍵函式錨點」通常足夠你用 grep 把線上版本釘死。

延伸閱讀：
- PutObject ↔ Healing 共振（partial/MRF/rename）：`docs/trace/putobject-healing-callchain.md`
- 現場症狀（grid 斷線）：`docs/troubleshooting/canceling-remote-connection.md`

---

## 0) 先釐清：HealObject 常見 3 個入口來源（你現場看到的 heal 可能是哪一種）

### A) MRF（Most Recently Failed）：PutObject 留下 partial → 背景補洞
- enqueue：`cmd/erasure-object.go`：`erasureObjects.addPartial(...)` → `globalMRFState.addPartialOp(...)`
- consumer：`cmd/mrf.go`：`(*mrfState).healRoutine(...)` → helper `healObject(...)` → `z.HealObject(...)`

### B) scanner：data scanner 偵測到需要修復 → 直接呼叫 HealObject
- `cmd/data-scanner.go`：`(*scannerItem).applyHealing(...)` → `o.HealObject(...)`

### C) admin heal：`mc admin heal ...` / Console / 自動化呼叫 admin API
- router：`cmd/admin-router.go`：`/minio/admin/v3/heal/*`
- handler：`cmd/admin-handlers.go`：`adminAPIHandlers.HealHandler(...)` → `HealObject(...)`

一鍵釘死（在你跑的 MinIO source tree）：
```bash
cd /path/to/minio

# MRF
grep -RIn "addPartialOp" -n cmd/mrf.go cmd/erasure-object.go
grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go

# scanner
grep -RIn "applyHealing" -n cmd/data-scanner.go

# admin heal
grep -RIn "HealHandler" -n cmd/admin-router.go cmd/admin-handlers.go | head -n 80
```

---

## 1) HealObject 正式 ObjectLayer call chain（pool → sets → objects）

> 你想要把「某一次 heal」對到實際 receiver/檔案，最穩的做法就是把這 4 個函式簽名 grep 出來（行號會漂移，但 signature 很穩）。

1) `cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

2) `cmd/erasure-sets.go`
- `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

3) `cmd/erasure-healing.go`
- `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

4) `cmd/erasure-healing.go`
- `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

一鍵釘死：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
```

---

## 2) `(*erasureObjects).healObject()` 內部：5 個關鍵步驟（你要下斷點/插 trace 的地方）

> 下面以「步驟」而非「行號」整理，因為不同 RELEASE tag 可能插入更多分支（versioning / xl.meta 格式 / inline data / SSEC 等）。

### Step 1：讀取/彙整 metadata（fan-out 讀 `xl.meta`）
關鍵函式錨點：
- `readAllFileInfo(...)`

目的：
- 從所有 disks 讀出 `xl.meta`（或等價的 object metadata）
- 收集各 disk 的版本/parts/erasure layout 狀態，供後續決定 quorum 與修復目標

### Step 2：算 quorum + 選「reference meta」（挑一份可信的 fileInfo）
常見錨點（不同版本可能不全都有，但通常會看到其中幾個）：
- `objectQuorumFromMeta(...)`
- `listOnlineDisks(...)`
- `pickValidFileInfo(...)`
- `disksWithAllParts(...)`

目的：
- 判斷這次 heal 至少要滿足的 read/write quorum
- 決定以哪一份 `xl.meta`/fileInfo 當作「修復參考」
- 找出缺片（partsToHeal）/壞片（bitrot）/缺 disk（disksToHeal）

### Step 3：建立 RS encoder / heal plan
關鍵錨點：
- `NewErasure(...)`

目的：
- 依 data/parity layout 建立 RS encoder
- 決定需要從哪些 disks/parts 讀出資料，用哪些 parity 重建

### Step 4：RS rebuild（讀 bitrot + 重建 + 寫 `.minio.sys/tmp`）
關鍵錨點：
- reader：`newBitrotReader(...)`
- writer：`newBitrotWriter(...)`
- rebuild：`erasure.Heal(...)`

目的：
- 從「健康 disks」讀出 shards/parts
- 透過 `erasure.Heal` 做重建
- 把重建結果寫到 `.minio.sys/tmp/<tmpID>/<dstDataDir>/part.N`

### Step 5：寫回/提交（tmp → 正式路徑）：`StorageAPI.RenameData()`
關鍵錨點：
- `RenameData(...)`（storage interface）
  - 常見實作：`cmd/xl-storage.go`：`(*xlStorage).RenameData(...)`

目的：
- 把 `.minio.sys/tmp` 的結果原子 rename 回 `<bucket>/<object>/<dataDir>/part.N`
- 這段通常是 heal tail-latency 的大宗（metadata ops / fsync / disk latency）

一鍵 grep（把上述 5 步驟釘死到你的版本）：
```bash
cd /path/to/minio

# healObject 入口
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

# Step1-2：meta/quorum
grep -RIn "readAllFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "objectQuorumFromMeta\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "pickValidFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "disksWithAllParts\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40

# Step3-4：erasure heal
grep -RIn "NewErasure\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "newBitrotReader\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "newBitrotWriter\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "\\.Heal\\(ctx" -n cmd/erasure-healing.go cmd/*.go | head -n 40

# Step5：RenameData 落地
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go | head -n 120
```

---

## 3) 現場對齊：為什麼 Healing 容易跟 `canceling remote connection` 一起出現？

> 經驗上，`canceling remote connection ... not seen for ~60s` 常是「結果」：背景 heal / scanner / MRF 把 I/O（尤其 rename/fsync）打滿，導致 grid streaming mux 的 ping handler 延遲。

把現象寫成最短因果鏈（incident note 可直接引用）：
1) PutObject quorum 過但留下 partial → MRF enqueue
2) MRF/scanner/admin 觸發 `HealObject()`
3) `healObject()` 內 `erasure.Heal()` + `RenameData()` 拉高 I/O/排程壓力
4) grid streaming mux `LastPing` 更新延遲 → server ~60s watchdog 印出 `canceling remote connection`

讀碼錨點整合頁：`docs/trace/putobject-healing-callchain.md`

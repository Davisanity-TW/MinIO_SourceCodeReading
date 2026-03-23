# Trace：PutObject / Healing 呼叫鏈速查（含檔案/函式/最短 grep 錨點）

> 目標：把 PutObject（寫入）與 Healing（補洞/重建）用 **最短且可釘死的 call chain** 串起來，方便你在不同 RELEASE tag / fork 之間快速對齊。
>
> 本頁刻意只放「穩定的檔案/函式名」+「可直接 copy 的 grep」，避免行號漂移。

延伸閱讀（更完整的細節/背景/I/O 共振）：
- `docs/trace/putobject-healing.md`
- `docs/troubleshooting/canceling-remote-connection.md`

---

## 1) PutObject：HTTP handler → ObjectLayer → erasure putObject（主流程）

### 1.1 最短 call chain（按 receiver 分層）

1) HTTP handler
- `cmd/object-handlers.go`
  - `objectAPIHandlers.PutObjectHandler()`

2) ObjectLayer：multi-pool
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

3) ObjectLayer：sets
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

4) ObjectLayer：objects（真正的 encode/tmp/rename/commit）
- `cmd/erasure-object.go`
  - `func (er erasureObjects) PutObject(...) (ObjectInfo, error)`（wrapper）
  - `func (er erasureObjects) putObject(...) (ObjectInfo, error)`（主流程）

### 1.2 putObject() 內部最關鍵的三個切點（常拿來下斷點/插 trace）

- encode：`erasure.Encode(...)`
- tmp → 正式 dataDir：`renameData(...)`
- commit（切換 DataDir / 對外可見）：`commitRenameDataDir(...)`

### 1.3 PutObject 成功但留下缺片（partial）→ 丟進 MRF queue

- `cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
    - `globalMRFState.addPartialOp(partialOperation{...})`

> 實務語意：PutObject 只要 quorum 過了就可能回成功；如果當下某些 disks offline（或 versions disparity），就會留下 partial，交由背景機制（MRF/scanner/healing）補洞。

---

## 2) Healing：MRF/scanner → HealObject() → healObject()（真正 RS rebuild + RenameData 寫回）

### 2.1 MRF（Most Recently Failed）消費 partial op 的背景 routine

- `cmd/mrf.go`
  - `func (m *mrfState) addPartialOp(op partialOperation)`
    - `select { case m.opCh <- op: default: }`（queue 滿會 drop，不會 block PutObject）
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
    - 出隊後呼叫 helper `healObject(...)` → 最終會進 `z.HealObject(...)`

### 2.2 Scanner 直接觸發 HealObject

- `cmd/data-scanner.go`
  - `func (i *scannerItem) applyHealing(ctx context.Context, o ObjectLayer, oi ObjectInfo) (size int64)`
    - `o.HealObject(ctx, bucket, object, versionID, healOpts)`

### 2.3 HealObject 的正式 ObjectLayer call chain（pool → sets → objects → healObject）

- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
    - 核心 I/O：`readAllFileInfo(...)` / `erasure.Heal(...)` / `disk.RenameData(...)`

---

## 3) Storage 層的「原子切換點」：RenameData

PutObject 與 Healing 最容易共振的點：兩者最後都會落到 storage rename/cutover 類型操作。

- 介面：`cmd/storage-interface.go`
  - `RenameData(ctx context.Context, srcBucket, srcEntry string, fi FileInfo, dstBucket, dstEntry string, opts RenameOptions) error`
- 常見實作：`cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(ctx context.Context, srcBucket, srcEntry string, fi FileInfo, dstBucket, dstEntry string, opts RenameOptions) error`

---

## 4) 一鍵 grep：在你跑的 MinIO 版本把錨點釘死（避免行號漂移）

> 在 incident/讀碼筆記裡，建議固定記下：`git rev-parse --short HEAD` + 下列 grep 的輸出。

```bash
cd /path/to/minio

git rev-parse --short HEAD

# PutObject handler → object layer
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd/erasure-sets.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# PutObject rename/commit + partial/MRF
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go
grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

# MRF queue
grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go

# Healing
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd/erasure-sets.go
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

# RenameData 落地
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go | head -n 80
```

---

## 5) 快速把 trace/現象對回這張圖（最常用的兩句話）

- **PutObject 成功但留下洞**：`putObject()` 在 `commitRenameDataDir()` 後偵測 offline/versions disparity → `addPartial()` / `globalMRFState.addPartialOp()`。
- **背景補洞把 I/O 拉高**：`MRF healRoutine` 或 `scanner applyHealing` → `HealObject()` → `healObject()` → `erasure.Heal()` + `RenameData()`。

如果同時間又看到 `canceling remote connection ... not seen for ~60s`，很常是「背景 I/O/排程壓力 → grid ping handler 延遲」的結果（見 troubleshooting 頁）。

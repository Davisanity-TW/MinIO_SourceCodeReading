# PutObject / Healing：函式/檔案對照表（Phase → anchor → grep）

> 用途：incident/讀碼時想快速把「現象」對到 MinIO source 的具體函式/檔案，不想再翻長篇筆記。
>
> 這頁刻意只放 **最短錨點**（function signature /檔名）+ **可直接 copy 的 grep**。
>
> 延伸閱讀（細節版）：
> - `docs/trace/putobject.md`
> - `docs/trace/healing.md`
> - `docs/trace/putobject-healing-callchain.md`

---

## A) PutObject：HTTP → ObjectLayer → erasure write/commit

### A1. Route / handler（你追的 PutObject 到底是哪條分流）
- router：`cmd/api-router.go`
  - normal PutObject：`api.PutObjectHandler`
  - multipart part：`api.PutObjectPartHandler`（靠 query 分流）
  - copy：`api.CopyObjectHandler`（靠 header 分流）

```bash
cd /path/to/minio

grep -RIn "PutObjectHandler" -n cmd/api-router.go
grep -RIn "PutObjectPartHandler" -n cmd/api-router.go
grep -RIn "CopyObjectHandler" -n cmd/api-router.go
```

### A2. Handler 入口（HTTP 前置/reader pipeline）
- `cmd/object-handlers.go`
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

```bash
cd /path/to/minio

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
```

### A3. ObjectLayer（pool/sets 分層跳板）
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(...)`
  - `func (p *erasureServerPool) PutObject(...)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(...)`

```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd | head
grep -RIn "func (p \\*erasureServerPool) PutObject" -n cmd | head
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd | head
```

### A4. erasureObjects：encode/tmp/rename/commit（PutObject tail latency 熱點）
- `cmd/erasure-object.go`
  - wrapper：`func (er erasureObjects) PutObject(...)`
  - heavy path：`func (er erasureObjects) putObject(...)`

PutObject 的「三段式切點」（常拿來下斷點/插 trace）：
1) `erasure.Encode(...)`：把 shards 寫到 `.minio.sys/tmp/...`
2) `renameData(...)`：tmp → 正式路徑
3) `commitRenameDataDir(...)`：DataDir/version 切換（對外可見性）

```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

grep -RIn "\\.Encode\\(ctx" -n cmd/erasure-object.go | head
grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head
```

### A5. PutObject 成功但留下洞：MRF enqueue
- `cmd/erasure-object.go`
  - `addPartial(...)` → `globalMRFState.addPartialOp(...)`

```bash
cd /path/to/minio

grep -RIn "addPartial(" -n cmd/erasure-object.go | head -n 40
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go cmd/*.go | head
```

---

## B) Healing：MRF/scanner/admin → HealObject → RS rebuild → RenameData

### B1. MRF consumer（補洞調度者）
- `cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`

```bash
cd /path/to/minio

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
```

### B2. Scanner 觸發 HealObject（背景掃描發現不一致）
- `cmd/data-scanner.go`
  - `func (i *scannerItem) applyHealing(...)`

```bash
cd /path/to/minio

grep -RIn "func (i \\*scannerItem) applyHealing" -n cmd/data-scanner.go
```

### B3. Admin heal API（手動/工具）
- `cmd/admin-router.go` / `cmd/admin-handlers.go`
  - `adminAPIHandlers.HealHandler`

```bash
cd /path/to/minio

grep -RIn "HealHandler" -n cmd/admin-router.go cmd/admin-handlers.go | head -n 80
```

### B4. HealObject 分層跳板（ObjectLayer → sets → erasureObjects）
- `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) HealObject(...)`
- `cmd/erasure-sets.go`：`func (s *erasureSets) HealObject(...)`
- `cmd/erasure-healing.go`：`func (er *erasureObjects) healObject(...)`（heavy path）

```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head
```

### B5. healObject() 內部的兩個 I/O 大頭（最常跟 PutObject/grid 共振）
- `cmd/erasure-healing.go`
  - RS rebuild：`erasure.Heal(...)`
  - 寫回 commit：`disk.RenameData(...)`（StorageAPI）

```bash
cd /path/to/minio

grep -RIn "\\.Heal\\(ctx" -n cmd/erasure-healing.go | head
grep -RIn "RenameData\\(ctx" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head
```

---

## C) 共同落盤切點：StorageAPI.RenameData（rename/fsync 類 metadata-heavy 放大器）

- interface：`cmd/storage-interface.go`：`type StorageAPI interface { RenameData(...) ... }`
- 常見實作：`cmd/xl-storage.go`：`func (s *xlStorage) RenameData(...)`

```bash
cd /path/to/minio

grep -RIn "type StorageAPI interface" -n cmd/storage-interface.go
grep -RIn "RenameData\\(" -n cmd/storage-interface.go | head

grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go
```

> 實務提醒：
> - PutObject 的 `renameData()` 內部最後也會逐 disk 呼叫 `StorageAPI.RenameData()`。
> - Healing 的 `healObject()` 也是逐 disk `RenameData()` 寫回。
> - 所以只要 rename/fsync/metadata ops 變慢，PutObject tail latency 與 Healing duration 很容易一起升高。

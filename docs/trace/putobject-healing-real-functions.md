# Trace：PutObject / Healing（補齊：實際函式 / 檔案 / 呼叫鏈錨點）

> 目的：把「PutObject 與 Healing」的關鍵路徑補成 **可在不同 release / fork 直接 grep 對齊** 的「實際函式 + 檔案」清單。
>
> 原則：
> - 不記行號（避免漂移）
> - 每個段落都給一組最短 grep anchors
>
> 延伸：
> - PutObject/Healing 大圖與更多背景：`docs/trace/putobject-healing-callchain.md`
> - `canceling remote connection` 排查總頁：`docs/troubleshooting/canceling-remote-connection.md`

---

## A) PutObject：HTTP → ObjectLayer → erasureObjects.putObject（寫入主線）

### A.1 Router → handler（你追的 PutObject 分流是哪一條）

- router：`cmd/api-router.go`
  - PutObject（normal）：`api.PutObjectHandler`
  - CopyObject：`api.CopyObjectHandler`
  - PutObjectPart：`api.PutObjectPartHandler`

Anchors：
```bash
cd /path/to/minio

grep -n "PutObjectHandler" cmd/api-router.go
grep -n "CopyObjectHandler" cmd/api-router.go
grep -n "PutObjectPartHandler" cmd/api-router.go
```

### A.2 handler → ObjectLayer.PutObject（HTTP pipeline 的切點）

- handler：`cmd/object-handlers.go`
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

你想快速分辨「卡在 HTTP 前置」還是「卡在後端 erasure 寫入」，最常看的是：
- `extractMetadataFromReq(ctx, r)`
- `isPutActionAllowed(..., policy.PutObjectAction)`
- `hash.NewReaderWithOpts(...)`（ETag / checksum / streaming）
- `putOptsFromReq(...)`
- `objectAPI.PutObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go

grep -RIn "extractMetadataFromReq\(" -n cmd/object-handlers.go
grep -RIn "isPutActionAllowed" -n cmd/object-handlers.go
grep -RIn "NewReaderWithOpts" -n cmd/object-handlers.go
grep -RIn "putOptsFromReq\(" -n cmd/object-handlers.go

grep -RIn "\.PutObject(ctx" -n cmd/object-handlers.go | head -n 20
```

### A.3 ObjectLayer：multi-pool → pool → sets → objects

常見落點（檔案/receiver 名稱跨版本相對穩定）：
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(...)`
  - `func (p *erasureServerPool) PutObject(...)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(...)`
- `cmd/erasure-object.go`
  - `func (er erasureObjects) PutObject(...)`
  - `func (er erasureObjects) putObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (p \\*erasureServerPool) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
```

### A.4 PutObject 真正動到 disk 的三個關鍵點

1) **encode + 寫 tmp**（bitrot writer）
- `cmd/erasure-object.go`：`newBitrotWriter(...)` / `erasure.Encode(...)`

2) **tmp → 正式 dataDir**
- `cmd/erasure-object.go`：`renameData(...)`（會逐 disk 呼叫 `disk.RenameData(...)`）

3) **commit（對外可見性切換）**
- `cmd/erasure-object.go`：`commitRenameDataDir(...)`

Anchors：
```bash
cd /path/to/minio

grep -n "newBitrotWriter(" cmd/erasure-object.go | head -n 50
grep -n "\\.Encode(ctx" cmd/erasure-object.go | head -n 50

grep -n "^func renameData" cmd/erasure-object.go
grep -n "\\.RenameData(ctx" cmd/erasure-object.go | head -n 80

grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 80
```

### A.5 PutObject 留洞（partial）→ MRF queue 的真正 enqueue 點

- `cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
    - `globalMRFState.addPartialOp(...)`
- `cmd/mrf.go`
  - `func (m *mrfState) addPartialOp(op partialOperation)`（queue 滿會 drop）

Anchors：
```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
```

---

## B) Healing：MRF/scanner/admin → HealObject() → erasureObjects.healObject（重建/寫回）

### B.1 觸發來源 1：MRF consumer（Most Recently Failed）

- `cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 常見 helper：`healObject(ctx, z, bucket, object, versionID, scanMode)` → `z.HealObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
grep -RIn "HealObject\\(" -n cmd/mrf.go | head -n 80
```

### B.2 觸發來源 2：Scanner（掃描到缺片就直接 HealObject）

- `cmd/data-scanner.go`
  - `func (i *scannerItem) applyHealing(...)` → `o.HealObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "applyHealing" -n cmd/data-scanner.go
grep -RIn "HealObject\\(" -n cmd/data-scanner.go | head -n 40
```

### B.3 觸發來源 3：Admin heal（mc/Console/automation）

- `cmd/admin-router.go`：heal endpoints → `HealHandler`
- `cmd/admin-handlers.go`：`func (a adminAPIHandlers) HealHandler(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "HealHandler" -n cmd/admin-router.go cmd/admin-handlers.go | head -n 80
grep -RIn "func (a adminAPIHandlers) HealHandler" -n cmd/admin-handlers.go
```

### B.4 ObjectLayer.HealObject 的入口（pool/sets/objects）

- `cmd/erasure-server-pool.go`：`(z *erasureServerPools) HealObject(...)`
- `cmd/erasure-sets.go`：`(s *erasureSets) HealObject(...)`
- `cmd/erasure-healing.go`：`(er erasureObjects) HealObject(...)` → `(*erasureObjects).healObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 40
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head -n 40

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 40
```

### B.5 healObject() 內部：最常用的「三段式」錨點

1) **讀各 disk 的 xl.meta / FileInfo**
- `readAllFileInfo(...)`

2) **RS rebuild（缺片重建）**
- `func (e Erasure) Heal(...)`（常見在 `cmd/erasure-decode.go`）

3) **寫回 + commit（RenameData）**
- `disk.RenameData(...)`（介面）
- `(*xlStorage).RenameData(...)`（常見實作）

Anchors：
```bash
cd /path/to/minio

# meta fan-out
grep -RIn "readAllFileInfo\\(" -n cmd | head -n 40

# RS heal
grep -RIn "func (e Erasure) Heal" -n cmd | head -n 40

# writeback/commit
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go | head -n 120
```

---

## C) 跟 `canceling remote connection` 的關聯：何時會共振

實務上最常見的共振條件是：
- PutObject/MRF/Healing 把 disk rename/fsync/metadata ops 拉高 → node tail latency 變大
- peer REST（grid RPC）是長連線/串流 mux → ping/pong handler 排不到 → `canceling remote connection`（server watchdog）或 `ErrDisconnected`（client watchdog）

你要把這句 log 釘到 code 的 anchors：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80
grep -RIn "clientPingInterval" -n internal/grid | head -n 80
```

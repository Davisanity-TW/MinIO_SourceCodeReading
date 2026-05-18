# Trace：PutObject / Healing（補）核心函式/檔案錨點（適合 incident note 直接引用）

目的：你在現場遇到「PutObject → Healing 暴增 → `canceling remote connection`」時，最需要的是：
- *不用靠行號* 就能在你線上的 MinIO 版本把呼叫鏈釘死
- 可以直接貼到 incident note 的「檔案 + 函式簽名 + grep」

> 本頁刻意只放 **最短鏈**。詳細解釋見：
> - `docs/trace/putobject-healing.md`
> - `docs/troubleshooting/canceling-remote-connection.md`

---

## 0) 先把版本釘死（必做）

```bash
cd /path/to/minio

git rev-parse --short HEAD

go version
```

（建議 incident note 同時記下 `minio --version` 與 binary build tags。）

---

## 1) PutObject（HTTP handler → ObjectLayer → erasureObjects.putObject）

### 1.1 HTTP handler

- `cmd/object-handlers.go`
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

```bash
cd /path/to/minio

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
```

### 1.2 ObjectLayer：multi-pool / sets / objects

- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
- `cmd/erasure-object.go`
  - `func (er erasureObjects) putObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd/erasure-sets.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
```

### 1.3 PutObject 的「原子切換點」：rename / commit

- `cmd/erasure-object.go`
  - `func renameData(...)
  - `func (er erasureObjects) commitRenameDataDir(...)

```bash
cd /path/to/minio

grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 40
```

---

## 2) PutObject 成功但「有洞」：partial → MRF queue

- `cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
  - `globalMRFState.addPartialOp(...)`
- `cmd/mrf.go`
  - `type partialOperation struct { ... }`
  - `func (m *mrfState) addPartialOp(op partialOperation)`（non-blocking；queue 滿會 drop）

```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\.addPartialOp" -n cmd/erasure-object.go

grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
```

---

## 3) MRF consumer：healRoutine() → HealObject()

- `cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - `func healObject(bucket, object, versionID string, scanMode madmin.HealScanMode) error`

```bash
cd /path/to/minio

grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
grep -n "func healObject" cmd/mrf.go
```

---

## 4) Healing：HealObject() → (*erasureObjects).healObject()（RS rebuild + RenameData）

- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(...)
- `cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(...)
  - `func (er *erasureObjects) healObject(...)

```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go
grep -RIn "^func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

# RS rebuild + 寫回（關鍵 I/O 錨點）
grep -RIn "\\.Heal(ctx" -n cmd/erasure-healing.go | head
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go | head
```

---

## 5) 最終落盤：StorageAPI.RenameData（PutObject/Healing 共同瓶頸點）

- `cmd/storage-interface.go`
  - `type StorageAPI interface { ... RenameData(...) ... }`
- `cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(ctx context.Context, srcBucket, srcEntry string, fi FileInfo, dstBucket, dstObject string, opts RenameOptions) error`

```bash
cd /path/to/minio

grep -n "RenameData(ctx" cmd/storage-interface.go
grep -n "func (s \\*xlStorage) RenameData" cmd/xl-storage.go
```

---

## 6) `canceling remote connection` 的 code 錨點（grid mux watchdog）

當你要把 log 文字對回 source：
- `internal/grid/muxserver.go`
  - `canceling remote connection`（log 字串）
  - `checkRemoteAlive()`（通常是判定 `LastPing` 超過 threshold）

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 120
```

> 這一段通常不是「網路先壞」，而是：I/O/CPU/GC 壓力讓 grid ping handler 延遲累積，最後 watchdog 主動斷線。

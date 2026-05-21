# Trace：PutObject / Healing（補：實際函式 + 檔案 + 最短呼叫鏈）

> 目的：把「PutObject 寫入」與「Healing 補洞/重建」的**最短可釘死呼叫鏈**整理成 *函式簽名 + 檔案*（避免行號漂移）。
>
> 適用場景：你在 incident note 想回答「PutObject 成功回應但留下 partial，後面是誰在 heal？實際走哪些函式？」

本頁以 upstream MinIO 的檔名/函式名為主；不同 RELEASE tag 行號會漂移，請用文內 `grep` 固定錨點。

---

## 0) PutObject：HTTP handler → ObjectLayer → erasureObjects.putObject

### 0.1 HTTP handler

- 檔案：`cmd/object-handlers.go`
- 入口：`objectAPIHandlers.PutObjectHandler()`
- 典型動作：把 request body 包成 `PutObjReader`，最後呼叫 `ObjectLayer.PutObject()`。

定位：
```bash
cd /path/to/minio

grep -RIn "PutObjectHandler" cmd/object-handlers.go
```

### 0.2 ObjectLayer（multi-pool / sets / objects）

- 檔案：`cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
- 檔案：`cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
- 檔案：`cmd/erasure-object.go`
  - `func (er erasureObjects) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
  - `func (er erasureObjects) putObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

定位：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) PutObject" cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) PutObject" cmd/erasure-sets.go
grep -RIn "func (er erasureObjects) putObject" cmd/erasure-object.go
```

### 0.3 PutObject 的落盤切換點：encode → tmp → rename/commit

- 檔案：`cmd/erasure-object.go`
  - RS encode：`erasure.Encode(...)`
  - tmp→正式：`renameData(...)` → `commitRenameDataDir(...)`
  - storage 介面：`StorageAPI.RenameData(...)`
    - interface：`cmd/storage-interface.go`
    - 實作：`cmd/xl-storage.go`（`func (s *xlStorage) RenameData(...) error`）

定位：
```bash
cd /path/to/minio

grep -RIn "func renameData\(" cmd/erasure-object.go
grep -RIn "commitRenameDataDir" cmd/erasure-object.go

grep -RIn "RenameData\(" cmd/storage-interface.go cmd/xl-storage.go
```

---

## 1) PutObject 寫成功但留下 partial：addPartial → MRF queue

當 write quorum 勉強達成但「有洞」（某些 disk offline / shard 沒寫到）時，PutObject 會把「需要後續補洞」丟進 MRF (Most Recently Failed) queue。

- 檔案：`cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
  - `globalMRFState.addPartialOp(...)`

- 檔案：`cmd/mrf.go`
  - `type partialOperation struct { ... }`
  - `func (m *mrfState) addPartialOp(op partialOperation)`
    - 重要：non-blocking，queue 滿會 `default:` 直接 drop（PutObject 不會被卡住）

定位：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" cmd/erasure-object.go
grep -RIn "globalMRFState\\.addPartialOp" cmd/erasure-object.go

grep -RIn "type partialOperation" cmd/mrf.go
grep -RIn "func (m \\*mrfState) addPartialOp" cmd/mrf.go
```

---

## 2) Healing：MRF consumer → HealObject() → (*erasureObjects).healObject()

### 2.1 MRF 背景消費者（healRoutine）

- 檔案：`cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 會出隊 `partialOperation`，最後呼叫 object layer：`z.HealObject(...)`

定位：
```bash
cd /path/to/minio

grep -RIn "func (m \\*mrfState) healRoutine" cmd/mrf.go
grep -RIn "HealObject\(" cmd/mrf.go | head -n 50
```

### 2.2 HealObject 分層（serverPools → sets → objects）

- 檔案：`cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- 檔案：`cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- 檔案：`cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

定位：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) HealObject" cmd/erasure-healing.go
grep -RIn "^func (er \\*erasureObjects) healObject" cmd/erasure-healing.go
```

### 2.3 Healing 的落盤切換點：disk.RenameData（原子切換）

- 檔案：`cmd/erasure-healing.go`
  - 呼叫：`disk.RenameData(ctx, minioMetaTmpBucket, tmpID, partsMetadata[i], bucket, object, RenameOptions{})`
- storage 介面/實作同 PutObject：`StorageAPI.RenameData` / `(*xlStorage).RenameData`。

定位：
```bash
cd /path/to/minio

grep -RIn "RenameData\(" cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 80
```

---

## 3)（對照）為何常與 `canceling remote connection` 同時出現？

你在現場很常遇到：PutObject / Healing 變多的同一時間窗，grid log 開始出現：
- `canceling remote connection ... not seen for ...`

最常見不是「網路先壞」，而是：
- Healing / PutObject 的 rename+fsync / metadata ops 把 disk 打滿
- goroutine 排程延遲 → grid ping/pong handler 沒跟上
- `internal/grid/muxserver.go` watchdog 判定 remote long time not seen → close connection

釘 code 錨點：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" internal/grid | head

grep -RIn "checkRemoteAlive\(" internal/grid/muxserver.go | head -n 80
grep -RIn "LastPing" internal/grid/muxserver.go | head -n 80
```

（延伸：可搭配本 repo 的 troubleshooting 集合頁 `/docs/troubleshooting/canceling-remote-connection.md`。）

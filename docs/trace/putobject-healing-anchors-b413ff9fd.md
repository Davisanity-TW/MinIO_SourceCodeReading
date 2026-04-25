# Trace anchors（workspace snapshot）：PutObject → partial/MRF → HealObject → grid `canceling remote connection`

> 目的：把 **PutObject / Healing（MRF）/ grid** 這三段最常一起出現在 incident 的路徑，用「可以在你自己的 MinIO checkout 直接 `grep` 到」的方式釘死。
>
> 這頁不是 upstream `master` 的固定行號文件；它是一個 **工作用 snapshot**：以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準。
>
> - MinIO commit（short）：`b413ff9fd`
> - 你要對照線上 `RELEASE.*`：請用同樣的 grep 方式在該版本重抓一次（行號會漂移）。

---

## 0) 版本指紋（先記下來，避免後面都在猜）

```bash
cd /home/ubuntu/clawd/minio

git rev-parse --short HEAD
# b413ff9fd
```

---

## 1) PutObject 入口：HTTP handler → ObjectLayer

### 1.1 HTTP handler

- 檔案：`cmd/object-handlers.go`
- 函式：`(api objectAPIHandlers) PutObjectHandler(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (api objectAPIHandlers) PutObjectHandler" cmd/object-handlers.go
# 1987:func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request) {
```

### 1.2 ObjectLayer（multi-pool）PutObject

- 檔案：`cmd/erasure-server-pool.go`
- 函式：`(z *erasureServerPools) PutObject(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (z \\*erasureServerPools) PutObject" cmd/erasure-server-pool.go
# 1056:func (z *erasureServerPools) PutObject(ctx context.Context, bucket string, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error) {
```

### 1.3 進入 erasureObjects.putObject（實際 encode/tmp/rename/commit 流程）

- 檔案：`cmd/erasure-object.go`
- 函式：`(er erasureObjects) putObject(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (er erasureObjects) putObject" cmd/erasure-object.go
# 1247:func (er erasureObjects) putObject(ctx context.Context, bucket string, object string, r *PutObjReader, opts ObjectOptions) (objInfo ObjectInfo, err error) {
```

---

## 2) PutObject 寫成功但留下洞：`addPartial()` → `globalMRFState.addPartialOp(...)`

### 2.1 `addPartial()` 定義

- 檔案：`cmd/erasure-object.go`
- 函式：`(er erasureObjects) addPartial(bucket, object, versionID string)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go
# 2107:func (er erasureObjects) addPartial(bucket, object, versionID string) {
```

### 2.2 PutObject 內部的 enqueue 點（同檔案）

> 這段通常出現在 putObject() 內 commit 後（quorum 過但有 disk offline / versions disparity），把補洞事件丟進 MRF queue。

```bash
cd /home/ubuntu/clawd/minio

grep -n "globalMRFState.addPartialOp" cmd/erasure-object.go | head -n 20
# 403:... globalMRFState.addPartialOp(partialOperation{ ... })
# 837:... globalMRFState.addPartialOp(partialOperation{ ... })
# 1569:... globalMRFState.addPartialOp(partialOperation{ ... })
```

---

## 3) MRF：queue consumer（背景補洞調度者）

### 3.1 MRF state + non-blocking enqueue（queue 滿會 drop）

- 檔案：`cmd/mrf.go`
- method：`(m *mrfState) addPartialOp(op partialOperation)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
# 52:func (m *mrfState) addPartialOp(op partialOperation) {
```

### 3.2 MRF 背景消費：`healRoutine()`

- 檔案：`cmd/mrf.go`
- method：`(m *mrfState) healRoutine(z *erasureServerPools)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
# 68:func (m *mrfState) healRoutine(z *erasureServerPools) {
```

> 注意：在這個版本裡，`mrfState.healRoutine()` 並不是直接呼叫 `z.HealObject(...)`，而是呼叫 `healObject(...)` helper，把物件丟到 background healing workers。

### 3.3 `healObject(...)` helper（把 object/version 送進 background heal workers）

- 檔案：`cmd/global-heal.go`
- function：`healObject(bucket, object, versionID string, scan madmin.HealScanMode) error`

```bash
cd /home/ubuntu/clawd/minio

grep -n "^func healObject" cmd/global-heal.go
# 541:func healObject(bucket, object, versionID string, scan madmin.HealScanMode) error {
```

---

## 4) Healing：真正做 RS rebuild + `RenameData()` 的入口（I/O heavy path）

> 這一段是你要對齊 I/O（讀 `xl.meta` / 重建 / rename/fsync）時最常下手的地方。

- 檔案：`cmd/erasure-healing.go`
- 入口函式：`(er *erasureObjects) healObject(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (er \\*erasureObjects) healObject" cmd/erasure-healing.go | head
# 242:func (er *erasureObjects) healObject(ctx context.Context, bucket string, object string, versionID string, opts madmin.HealOpts) (result madmin.HealResultItem, err error) {
```

### 4.1 metadata fan-out（讀 `xl.meta`）的 anchor：`readAllFileInfo(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "readAllFileInfo" cmd/erasure-healing.go | head -n 20
# 279:    partsMetadata, errs := readAllFileInfo(ctx, storageDisks, "", bucket, object, versionID, true, true)
# 1027:   _, errs := readAllFileInfo(healCtx, storageDisks, "", bucket, object, versionID, false, false)
```

### 4.2 RS rebuild 的 anchor：`Erasure.Heal(...)`

- 檔案：`cmd/erasure-decode.go`
- 函式：`func (e Erasure) Heal(...)`

```bash
cd /home/ubuntu/clawd/minio

grep -n "func (e Erasure) Heal" cmd/erasure-decode.go
# 314:func (e Erasure) Heal(ctx context.Context, writers []io.Writer, readers []io.ReaderAt, totalLength int64, prefer []bool) (derr error) {
```

### 4.3 最後落地（tmp → 正式）的 storage commit anchor：`xlStorage.RenameData(...)`

- 介面：`cmd/storage-interface.go`（`StorageAPI.RenameData`）
- 實作：`cmd/xl-storage.go`（`(*xlStorage).RenameData`）

```bash
cd /home/ubuntu/clawd/minio

grep -n "RenameData(ctx" cmd/storage-interface.go | head -n 5
# 88:    RenameData(ctx context.Context, srcVolume, srcPath string, fi FileInfo, dstVolume, dstPath string, opts RenameOptions) (RenameDataResp, error)

grep -n "func (s \\*xlStorage) RenameData" cmd/xl-storage.go | head
# 2456:func (s *xlStorage) RenameData(ctx context.Context, srcVolume, srcPath string, fi FileInfo, dstVolume, dstPath string, opts RenameOptions) (res RenameDataResp, err error) {
```

> 實務判讀（寫 incident note 用一句就夠）：當 healing 很熱時，重點通常不是 RS 計算，而是 `readAllFileInfo()`（metadata fan-out）與 `RenameData()`（rename/fsync/metadata ops）這兩段把 tail latency 拉高；grid ping handler 也可能因此排隊，放大成 `canceling remote connection`。

---

## 5) grid：`canceling remote connection` 的 log anchor

- 檔案：`internal/grid/muxserver.go`
- 位置：`(*muxServer).checkRemoteAlive()` 內印出

```bash
cd /home/ubuntu/clawd/minio

grep -n "canceling remote connection" internal/grid/muxserver.go
# 246:                gridLogIf(m.ctx, fmt.Errorf("canceling remote connection %s not seen for %v", m.parent, last))
```

> 判讀重點：這條 log 的語意是「server 端在 threshold 內沒看到/沒能處理到 remote 的 ping（`LastPing` 沒更新）」；原因可能是網路丟包，也可能是對端 I/O/CPU/GC/背景任務壓力讓 handler 排隊太久。

---

## 6) 一句話把三段鏈接起來（incident note 可直接照抄）

- PutObject quorum 過但有 disk offline / metadata disparity → `cmd/erasure-object.go` enqueue `globalMRFState.addPartialOp(...)`
- MRF consumer → `cmd/mrf.go: (*mrfState).healRoutine()` → `cmd/global-heal.go: healObject()` 把物件送進 background healing workers
- Healing 真正做重建/寫回（I/O heavy）→ `cmd/erasure-healing.go: (*erasureObjects).healObject(...)`（含 `erasure.Heal(...)` + `RenameData(...)`）
- 同時間 grid streaming mux ping handler 若延遲累積，server watchdog 會印：`internal/grid/muxserver.go: "canceling remote connection ... not seen for ..."`

（延伸閱讀）
- Trace：`docs/trace/putobject-healing.md`
- Troubleshooting：`docs/troubleshooting/canceling-remote-connection.md`

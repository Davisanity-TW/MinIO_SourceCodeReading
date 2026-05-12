# Trace：PutObject / Healing（補：實際函式/檔案/呼叫鏈；已在 b413ff9fd 驗證）

> 本頁是 `docs/trace/putobject-healing-callchain.md` 的「可落地版本」：把關鍵點補成**可直接打開檔案就看到的實際函式**（含檔案路徑 + 本 workspace 版本的行號）。
>
> - MinIO source（workspace）：`/home/ubuntu/clawd/minio`
> - MinIO git rev（short）：`b413ff9fd`
>
> 注意：行號會隨 upstream 變動；但本頁至少能在你切到同一個 commit 時 100% 對齊，並且提供「下一跳」的函式名讓你在別的版本用 grep 快速重定位。

---

## 0) 一鍵自證（你現在追的 source 是不是同一版）

```bash
cd /home/ubuntu/clawd/minio

git rev-parse --short HEAD
```

期望輸出：`b413ff9fd`

---

## 1) PutObject：HTTP handler → ObjectLayer → erasureObjects.putObject()

### 1.1 handler 入口（S3 API）

- 檔案：`cmd/object-handlers.go`
- 函式：`func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`
- 本版行號：`cmd/object-handlers.go:1987`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
```

### 1.2 ObjectLayer（multi-pool）入口

- 檔案：`cmd/erasure-server-pool.go`
- 函式：`func (z *erasureServerPools) PutObject(ctx context.Context, bucket string, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
- 本版行號：`cmd/erasure-server-pool.go:1056`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
```

> 這層通常會把 request 依 bucket/placement 導到對應 pool/sets（你要追「寫入到底落到哪個 set」時，這裡是第一個切點）。

### 1.3 真正寫入主流程：erasureObjects.putObject()

- 檔案：`cmd/erasure-object.go`
- 函式：`func (er erasureObjects) putObject(ctx context.Context, bucket string, object string, r *PutObjReader, opts ObjectOptions) (objInfo ObjectInfo, err error)`
- 本版行號：`cmd/erasure-object.go:1247`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
```

> 你要做「PutObject latency」或「rename/fsync」相關的 trace/pprof，大多數時候把堆疊釘到 `erasureObjects.putObject()` 就已經夠精準。

---

## 2) PutObject 留洞（partial）→ MRF queue → 背景 HealObject

### 2.1 MRF consumer：healRoutine()

- 檔案：`cmd/mrf.go`
- 函式：`func (m *mrfState) healRoutine(z *erasureServerPools)`
- 本版行號：`cmd/mrf.go:68`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
```

> 你在 incident 裡要回答「MRF 到底有沒有在跑？」：
> - goroutine dump 裡看得到 `mrfState.healRoutine`（或 pprof goroutine）
> - 再對照 queue/backlog（依版本可能有 metrics/expvar）

### 2.2 ObjectLayer.HealObject（multi-pool）入口

- 檔案：`cmd/erasure-server-pool.go`
- 函式：`func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- 本版行號：`cmd/erasure-server-pool.go:2319`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
```

### 2.3 真正 heavy path：(*erasureObjects).healObject()

- 檔案：`cmd/erasure-healing.go`
- 函式：`func (er *erasureObjects) healObject(ctx context.Context, bucket string, object string, versionID string, opts madmin.HealOpts) (result madmin.HealResultItem, err error)`
- 本版行號：`cmd/erasure-healing.go:242`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
```

> 你要追「healing 的 I/O 壓力」時，通常就是：
> - `readAllFileInfo()`（讀 xl.meta / fan-out metadata）
> - `Erasure.Heal()`（RS rebuild）
> - `RenameData()`（tmp → 正式；rename/fsync/metadata ops）
>
> 這些更細的錨點仍建議回 `docs/trace/putobject-healing-callchain.md`（它整理得比較完整）。

---

## 3) `canceling remote connection`（internal/grid）實際位置（與 healing/PutObject 壓力同窗時常一起出現）

### 3.1 server 端 watchdog：muxServer.checkRemoteAlive()

- 檔案：`internal/grid/muxserver.go`
- log 字串：`canceling remote connection %s not seen for %v`
- 本版位置：`internal/grid/muxserver.go:246`

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "func (m \\*muxServer) checkRemoteAlive" -n internal/grid/muxserver.go
```

### 3.2 ping 間隔/閾值（為什麼常看到 ~60s）

- `internal/grid/grid.go`：`clientPingInterval = 15 * time.Second`
- `internal/grid/muxserver.go`：`const lastPingThreshold = 4 * clientPingInterval`（= 60s）

快速定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "clientPingInterval" -n internal/grid | head -n 20

grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go
```

---

## 4) 建議怎麼用這頁（最實用的兩段貼文）

### A) PutObject / Healing 共振（call chain 版）

> PutObject handler 入口在 `cmd/object-handlers.go:PutObjectHandler()`，最後會進 `cmd/erasure-object.go:erasureObjects.putObject()` 做 encode/tmp/rename/commit；若留下缺片則會進 MRF queue（`cmd/mrf.go:mrfState.healRoutine()`），背景再呼叫 `HealObject()`，最終進 `cmd/erasure-healing.go:(*erasureObjects).healObject()` 做 RS rebuild + `RenameData()` 寫回。

### B) `canceling remote connection`（為什麼跟 I/O 壓力同時出現）

> `canceling remote connection ... not seen for ~60s` 是 internal/grid 的 mux server watchdog（`internal/grid/muxserver.go:checkRemoteAlive()`），當 peer RPC 的 ping/pong 長時間沒更新就會斷線；在 healing/MRF/rename/fsync 尖峰時，remote 端 goroutine 可能因 I/O 或排程延遲，導致 ping handler 排不到而被誤判「不 alive」。

---

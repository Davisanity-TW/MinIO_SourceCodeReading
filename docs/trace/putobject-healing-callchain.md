# Trace：PutObject / Healing 呼叫鏈速查（含檔案/函式/最短 grep 錨點）

> 目標：把 PutObject（寫入）與 Healing（補洞/重建）用 **最短且可釘死的 call chain** 串起來，方便你在不同 RELEASE tag / fork 之間快速對齊。
>
> 本頁刻意只放「穩定的檔案/函式名」+「可直接 copy 的 grep」，避免行號漂移。

延伸閱讀（更完整的細節/背景/I/O 共振）：
- `docs/trace/putobject-healing.md`
- `docs/troubleshooting/canceling-remote-connection.md`

---

## 1) PutObject：router → HTTP handler → ObjectLayer → erasure putObject（主流程）

### 1.0 先確認你追的到底是哪條 PutObject 分流（Copy / Multipart / Normal）
PutObject 的 URL 都是 `PUT /{object:.+}`，但 MinIO 會先靠 header/query 做分流（不同版本可能略有差）。

- router：`cmd/api-router.go`
  - CopyObject：`HeadersRegexp(xhttp.AmzCopySource, ...)` → `api.CopyObjectHandler`
  - PutObjectPart：`Queries("partNumber", ..., "uploadId", ...)` → `api.PutObjectPartHandler`
  - PutObject（normal）：無特殊 headers/query → `api.PutObjectHandler`

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

grep -RIn "PutObjectHandler" -n cmd/api-router.go
grep -RIn "CopyObjectHandler" -n cmd/api-router.go
grep -RIn "PutObjectPartHandler" -n cmd/api-router.go
```

### 1.1 最短 call chain（按 receiver 分層）

1) HTTP handler
- `cmd/object-handlers.go`
  - `objectAPIHandlers.PutObjectHandler()`

2) ObjectLayer：multi-pool
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

3) ObjectLayer：單一 pool（實際會把 request 導到 sets）
- `cmd/erasure-server-pool.go`
  - `func (p *erasureServerPool) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
    - 常見語意：做 pool 內部的前置/轉派，最後落到 `p.sets.PutObject(...)`

4) ObjectLayer：sets
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

5) ObjectLayer：objects（真正的 encode/tmp/rename/commit）
- `cmd/erasure-object.go`
  - `func (er erasureObjects) PutObject(...) (ObjectInfo, error)`（wrapper）
  - `func (er erasureObjects) putObject(...) (ObjectInfo, error)`（主流程）

### 1.2 PutObjectHandler() 內部：HTTP 參數/reader pipeline → ObjectOptions → ObjectLayer.PutObject

> 這段是把「PutObject handler 到底做了哪些前置」釘成可 grep 的錨點；方便你在 incident 時快速分辨問題是卡在 **HTTP/驗證/reader pipeline** 還是 **底層 erasure 寫入**。

- `cmd/object-handlers.go`
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

常見（且跨版本相對穩定）的關鍵呼叫點：
- metadata：`extractMetadataFromReq(ctx, r)`
- authz：`isPutActionAllowed(..., policy.PutObjectAction)`
- quota：`enforceBucketQuotaHard(ctx, bucket, size)`
- chunked reader：`newSignV4ChunkedReader(...)` / `newUnsignedV4ChunkedReader(...)`
- hash/etag/checksum：`hash.NewReaderWithOpts(...)` + `hashReader.AddChecksum(...)` → `NewPutObjReader(hashReader)`
- options：`putOptsFromReq(ctx, r, bucket, object, metadata)`
- 最終：`objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

```bash
cd /path/to/minio

grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go

grep -RIn "extractMetadataFromReq\(" -n cmd/object-handlers.go
grep -RIn "isPutActionAllowed" -n cmd/object-handlers.go
grep -RIn "enforceBucketQuotaHard" -n cmd/object-handlers.go

grep -RIn "newSignV4ChunkedReader" -n cmd/object-handlers.go
grep -RIn "NewPutObjReader\(" -n cmd/object-handlers.go

grep -RIn "putOptsFromReq\(" -n cmd/object-handlers.go
```

### 1.3 putObject() 內部最關鍵的切點（常拿來下斷點/插 trace）

> 目的：把「PutObject 寫入」在 erasure 層最吃 I/O、也最常跟 MRF/Healing 共振的切點釘死。

- **encode + 寫 tmp**：`erasure.Encode(...)`
  - writer：`newBitrotWriter(...)`（寫到 `.minio.sys/tmp/<tmpID>/<dataDir>/part.N`）
- **tmp → 正式 dataDir**：`renameData(...)`
- **commit（切換 DataDir / 對外可見）**：`commitRenameDataDir(...)`

你要在 code 裡最快定位（避免行號漂移）：
```bash
cd /path/to/minio

grep -n "func (er erasureObjects) putObject" cmd/erasure-object.go

grep -n "newBitrotWriter(" cmd/erasure-object.go | head -n 50
grep -n "\\.Encode(ctx" cmd/erasure-object.go | head -n 50

grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 50
```

### 1.4 PutObject 成功但留下缺片（partial）→ 丟進 MRF queue

- `cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
    - `globalMRFState.addPartialOp(partialOperation{...})`

- `cmd/mrf.go`
  - `type partialOperation struct { ... }`（bucket/object/versionID 等欄位）
  - `func (m *mrfState) addPartialOp(op partialOperation)`
    - `select { case m.opCh <- op: default: }`
    - **重點：queue 滿會 drop，不會 block PutObject**（所以你會看到「洞存在，但 heal 沒立刻追上」的情境）

> 實務語意：PutObject 只要 quorum 過了就可能回成功；如果當下某些 disks offline（或 versions disparity），就會留下 partial，交由背景機制（MRF/scanner/healing）補洞。

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
```

### 1.4.1（補）versions disparity：PutObject 不是只丟單一 VersionID，可能丟「多版本」bytes 讓 MRF 逐一 heal

你在現場如果看到「同一個 object 在短時間內被 heal 很多次」，但 PutObject log/trace 看起來只寫了一次，常見原因之一是：
- `renameData(...)` 在 commit/rename 過程中偵測到 **versions disparity**（不同 disks 上看到的版本集合不一致）
- PutObject 會把 `versions`（一段 bytes，通常是多個 UUID 串接）塞進 `partialOperation.versions`
- MRF 的 `healRoutine()` 會把 `versions` 每 16 bytes 解析成一個 VersionID，逐一呼叫 `healObject(bucket, object, versionID, scanMode)`

可釘死的 grep 錨點（在你跑的版本）：
```bash
cd /path/to/minio

# putObject() 內：commit 之後，若拿到 versions bytes → enqueue 到 MRF
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 30
grep -n "versions" cmd/erasure-object.go | head -n 120

# MRF 端：versions bytes → 逐 16 bytes 切 UUID → 逐一 heal
grep -n "len(u\\.versions" cmd/mrf.go
```

> 實務意義：你在事件筆記要能區分「單一版本 partial」vs「多版本 disparity」；後者更容易把 healing 放大成一串連續 heal。

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

### 2.2.1 Admin API（手動/工具觸發）→ HealHandler → HealObject

> 目的：把你在現場常用的 `mc admin heal ...`（或 Console/自動化呼叫 admin heal API）對回實際 server handler；避免把「手動 heal」跟「MRF/scanner 自動 heal」混在一起。

- Admin router：`cmd/admin-router.go`
  - `POST /minio/admin/v3/heal/`、`/heal/{bucket}`、`/heal/{bucket}/{prefix:.*}` → `adminAPIHandlers.HealHandler`
- Admin handler：`cmd/admin-handlers.go`
  - `func (a adminAPIHandlers) HealHandler(w http.ResponseWriter, r *http.Request)`
  - 解析 request 後，最終仍會落到 ObjectLayer 的 `HealObject(...)`（同一條 healing 主線）

快速定位（在你跑的 MinIO 版本把 API ↔ handler ↔ ObjectLayer 錨點釘死）：
```bash
cd /path/to/minio

grep -RIn "HealHandler" -n cmd/admin-handlers.go cmd/admin-router.go | head -n 50

grep -RIn "func \(a adminAPIHandlers\) HealHandler" -n cmd/admin-handlers.go

grep -RIn "HealObject\(" -n cmd/admin-handlers.go | head -n 80
```

（背景 heal 狀態查詢也常一起用）
- `cmd/admin-handlers.go`：`BackgroundHealStatusHandler`
- `cmd/peer-rest-server.go`：`BackgroundHealStatusHandler`（peer/grid RPC）

### 2.2.2（新增）當 Healing 需要跨節點：Peer REST（grid）怎麼把 HealObject 分派到 peer

> 目的：你在現場常看到「某個 node 很忙/很慢」但 heal/trace 看起來是從別的節點發起；這時候把 **peer REST（grid RPC）** 的 client/server 錨點釘死，就能更快回答：
> - 是不是透過 grid 把 heal request 轉發到某個 peer？
> - 哪個 handler 在 peer 端處理？
> - 為什麼會跟 `canceling remote connection`（streaming mux watchdog）同時間出現？

典型結構（跨版本相對穩定的檔名/概念）：
- **server 端（peer 端接收）**：`cmd/peer-rest-server.go`
  - 會註冊多個 peer REST handler（含 background heal status / heal 相關 RPC）
- **client 端（發起端呼叫 peer）**：`cmd/peer-rest-client.go`
  - 會用 grid connection 對 peer 打 RPC

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

# peer REST server/client 的入口檔案
ls cmd/peer-rest-*.go

# 找 heal/background heal/status 相關的 handler/route（不同版本命名略有差）
grep -RIn "BackgroundHealStatus" -n cmd/peer-rest-server.go cmd/peer-rest-client.go | head -n 50

grep -RIn "Heal" -n cmd/peer-rest-server.go cmd/peer-rest-client.go | head -n 120

# 如果你是想把「grid 連線心跳」跟「peer REST RPC 很忙」關聯起來：
# 直接在 internal/grid 找 streaming mux 的 watchdog（server 端 ~60s 沒 ping）
grep -RIn "canceling remote connection" -n internal/grid | head
```

> 實務判讀：
> - Healing/MRF/scanner 若造成大量跨節點 RPC（peer REST），會放大 grid streaming mux 的壓力；
> - 這時 `canceling remote connection` 往往是「結果」（心跳/handler 排隊/網路丟包），不是根因。

### 2.3 HealObject 的正式 ObjectLayer call chain（pool → sets → objects → healObject）

- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

### 2.4（補）`healObject()` 內部最短「可釘死」步驟鏈：read meta → 算 quorum → RS rebuild → RenameData

> 目的：把真正最吃 I/O 的 heal 路徑補到「實際函式名」，讓你在 incident 時可以很快回答：
> - 卡在 metadata fan-out？（`readAllFileInfo`）
> - 卡在 RS 重建？（`erasure.Heal`）
> - 卡在寫回/rename？（`disk.RenameData` / `xlStorage.RenameData`）

在 `cmd/erasure-healing.go: (*erasureObjects).healObject()`（不同版本可能拆檔，但函式名通常穩定）你會反覆看到這組關鍵點：

1) metadata fan-out（讀 `xl.meta`）
- `readAllFileInfo(...)`

2) quorum/選 meta reference（決定以哪份 `xl.meta` 當準）
- `objectQuorumFromMeta(...)`
- `listOnlineDisks(...)`
- `pickValidFileInfo(...)`
- `disksWithAllParts(...)`

3) 建 RS encoder
- `NewErasure(...)`

4) 逐 part RS 重建 + 寫 `.minio.sys/tmp`
- reader：`newBitrotReader(...)`
- writer：`newBitrotWriter(...)`（寫 `.minio.sys/tmp/<tmpID>/<dstDataDir>/part.N`）
- rebuild：`erasure.Heal(...)`

5) 原子寫回（tmp → 正式）
- `disk.RenameData(...)`（storage 介面）
  - 常見實作：`cmd/xl-storage.go: (*xlStorage).RenameData(...)`

一鍵 grep（在你跑的版本把錨點釘死）：
```bash
cd /path/to/minio

grep -RIn "^func (er \\*erasureObjects) healObject" -n cmd | head

grep -RIn "readAllFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20
grep -RIn "objectQuorumFromMeta\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20
grep -RIn "pickValidFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20
grep -RIn "disksWithAllParts\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20

grep -RIn "newBitrotReader\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20
grep -RIn "newBitrotWriter\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20
grep -RIn "\\.Heal(ctx" -n cmd/erasure-healing.go cmd/*.go | head -n 20

grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go | head -n 80
```

---

## 2.5（補）MRF 的 `healObject()` helper 也要釘死：它怎麼包 `HealObject()`

> 目的：很多現場筆記只記到「MRF healRoutine 會呼叫 HealObject」，但你真正想知道的是：
> - `healRoutine()` 出隊後到底怎麼組 `HealObject` 的參數？（bucket/object/versionID/opts）
> - 它在什麼情況會 skip / retry / sleep？
>
> 這段通常在 `cmd/mrf.go` 內，以 helper function 的形式存在（版本可能略有差異，但 `healObject` 這個名字常見）。

- `cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`（consumer loop）
  - `func healObject(ctx context.Context, z *erasureServerPools, bucket, object, versionID string, scanMode madmin.HealScanMode) error`
    - 內部會呼叫：`z.HealObject(ctx, bucket, object, versionID, healOpts)`
    - 常見會設定：`healOpts.ScanMode = scanMode`、以及 `healOpts.Remove/Recursive/DryRun` 等（依版本）

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "func healObject" -n cmd/mrf.go

grep -RIn "HealObject\\(" -n cmd/mrf.go | head -n 50
```

> 實務用法：你在 incident note 只要貼出 `cmd/mrf.go` 裡 `healObject()` 那段 `HealObject()` 呼叫，就能把「MRF 觸發的 heal」跟「scanner/人工觸發的 heal」在 code 上區分開。

## 3) Storage 層的「原子切換點」：RenameData

PutObject 與 Healing 最容易共振的點：兩者最後都會落到 storage rename/cutover 類型操作。

- 介面：`cmd/storage-interface.go`
  - `RenameData(ctx context.Context, srcBucket, srcEntry string, fi FileInfo, dstBucket, dstEntry string, opts RenameOptions) error`
- 常見實作：`cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(ctx context.Context, srcBucket, srcEntry string, fi FileInfo, dstBucket, dstEntry string, opts RenameOptions) error`

### 3.1（補）PutObject vs Healing：最後的「commit/可見性切換點」其實長得不一樣

同樣都是「tmp → 正式路徑」的安全提交模型，但 PutObject 與 Healing 在 code 上的 commit 點不同：

- **PutObject（object layer 主導）**：`cmd/erasure-object.go`
  - `renameData(...)`：把 `.minio.sys/tmp/<tmpID>/<dataDir>/part.N` 轉到 `<bucket>/<object>/<dataDir>/part.N`
  - `commitRenameDataDir(...)`：完成 DataDir/version 的切換（對外可見性切換點）

- **Healing（storage layer 逐 disk commit）**：`cmd/erasure-healing.go`
  - `disk.RenameData(...)`：把 `.minio.sys/tmp/<tmpID>/<dstDataDir>/part.N` 逐顆 disk rename 回 `<bucket>/<object>/<dstDataDir>/part.N`

> 實務判讀：
> - 「PutObject 很慢」且卡在最後：優先看 `renameData()` / `commitRenameDataDir()`（大量 rename/fsync）
> - 「Healing 很慢」且 CPU 不高：優先看 `StorageAPI.RenameData()` 的 I/O latency（底層檔案系統/磁碟/metadata lock）

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

# PutObject 的 commit 點
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 50

# Healing 的 commit 點（storage rename）
grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 80
```

---

## 4) 一鍵 grep：在你跑的 MinIO 版本把錨點釘死（避免行號漂移）

> 在 incident/讀碼筆記裡，建議固定記下：`git rev-parse --short HEAD` + 下列 grep 的輸出。

```bash
cd /path/to/minio

git rev-parse --short HEAD

# PutObject handler → object layer
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (p \\*erasureServerPool) PutObject" -n cmd/erasure-server-pool.go
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

---

## 6)（補）把 `canceling remote connection` 也釘進同一張 call chain（grid ping/pong 的 code anchors）

> 目的：在 incident 時把「PutObject/MRF/Healing 造成 I/O 壓力」與「grid 心跳超時斷線」用**可 grep 的 code 錨點**接起來。

- 觸發 log / server 端 watchdog：`minio/internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`：`time.Since(time.Unix(LastPing,0)) > lastPingThreshold` → 印 `canceling remote connection ... not seen for ...` → `m.close()`
- 閾值計算（通常固定 ~60s）：
  - `minio/internal/grid/grid.go`：`clientPingInterval = 15 * time.Second`
  - `minio/internal/grid/muxserver.go`：`lastPingThreshold = 4 * clientPingInterval`
- `LastPing` 更新點（server 收到 ping）：`minio/internal/grid/muxserver.go`
  - `(*muxServer).ping(...)`：`atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

（補）`checkRemoteAlive()` 的啟用條件（為什麼不是每條 request 都會看到它？）
- `muxserver.go` 在建立 streaming mux 時，只有在 `msg.DeadlineMS == 0`（沒有 deadline）或 deadline 太長（> `lastPingThreshold`）才會另外起 goroutine 跑 `m.checkRemoteAlive()`。
- 所以你在現場看到這條 log，通常代表：那條 grid mux 承載的是「長時間/串流」類型的 peer RPC（常見在 healing/scanner/rebalance/trace 這些背景流量被放大時）。

一鍵釘死（把「DeadlineMS 判斷」釘到你線上跑的版本；避免 master/RELEASE 差異）：
```bash
cd /path/to/minio

# 直接找出 DeadlineMS 的判斷點（通常就在建立 streaming mux/handler 附近）
grep -RIn "DeadlineMS" -n internal/grid/muxserver.go | head -n 80

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go internal/grid/grid.go | head -n 80
```

### 6.1（補）client 端也有 watchdog：30s 沒看到 pong 會先斷（常見伴隨 ErrDisconnected）

很多現場會先看到 client 端（發起端）報 `ErrDisconnected`，但 server 端稍後才印出 `canceling remote connection ... not seen for ~60s`。原因是：
- **client 端**通常在 `~30s`（`clientPingInterval*2`）沒收到 `LastPong` 更新就會主動斷線
- **server 端**在 `~60s`（`lastPingThreshold = 4*clientPingInterval`）沒看到 `LastPing` 更新才會印出這條 log

可釘死的 code anchors（以檔名/函式名為主）：
- `minio/internal/grid/muxclient.go`
  - `(*muxClient).handleOneWayStream()`：若 `time.Since(LastPong) > clientPingInterval*2` → `ErrDisconnected`
  - `(*muxClient).sendPing()` / `(*muxClient).ping()`（不同版本命名略有差）

一鍵 grep：
```bash
cd /path/to/minio

grep -RIn "clientPingInterval" -n internal/grid | head

grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 50
grep -RIn "ErrDisconnected" -n internal/grid/muxclient.go internal/grid/connection.go | head -n 80
```

一鍵 grep（對你線上跑的那個版本把錨點釘死）：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive" -n internal/grid/muxserver.go internal/grid/muxclient.go | head

grep -RIn "clientPingInterval" -n internal/grid | head
grep -RIn "lastPingThreshold" -n internal/grid | head

grep -RIn "LastPing" -n internal/grid/muxserver.go | head
```

> 實務判讀：當同一時間窗 healing/MRF 很忙、或磁碟 latency 飆高時，grid 的 ping handler 也可能因排程/I/O 阻塞而延遲，最後表現成這條 log。
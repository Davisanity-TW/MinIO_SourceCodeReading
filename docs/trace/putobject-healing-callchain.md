# Trace：PutObject / Healing 呼叫鏈速查（含檔案/函式/最短 grep 錨點）

> 目標：把 PutObject（寫入）與 Healing（補洞/重建）用 **最短且可釘死的 call chain** 串起來，方便你在不同 RELEASE tag / fork 之間快速對齊。
>
> 本頁刻意只放「穩定的檔案/函式名」+「可直接 copy 的 grep」，避免行號漂移。

延伸閱讀（更完整的細節/背景/I/O 共振）：
- `docs/trace/putobject-healing.md`
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/canceling-remote-connection-symptom-to-cause.md`（從 symptom → 快速反推最可能原因）
- `docs/troubleshooting/canceling-remote-connection-codepath.md`（把那句 log 釘到 `internal/grid` 的 code anchors）

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

### 2.1.1（補）MRF lifecycle：`healRoutine()` 是什麼時候被啟動的？（避免只看到 enqueue 但 consumer 根本沒起）

> 現場常見誤判：你在 PutObject 端看到 `addPartial()` / `globalMRFState.addPartialOp(...)`，就直覺認為「MRF 一定會開始補洞」；但實務上你要先確認 **MRF 的 consumer goroutine** 在你跑的 mode/版本裡確實有被啟動。
>
> 這節提供一組「不用猜行號」的 grep 錨點：
> - 先釘 `globalMRFState` 的宣告/初始化（queue 大小、型別）
> - 再釘 `healRoutine()` 的啟動點（`go globalMRFState.healRoutine(...)`）

在你線上對應的 MinIO source tree：
```bash
cd /path/to/minio

# 1) globalMRFState 在哪裡宣告/初始化
grep -RIn "globalMRFState" -n cmd | head -n 120

# 2) healRoutine() 何時被 go 起來（啟動點最重要）
grep -RIn "go .*globalMRFState\.healRoutine" -n cmd | head -n 120

# 3) 典型啟動點會跟 bootstrap/init trace 字串靠在一起（依版本可能叫 initHealMRF 或類似名稱）
grep -RIn "initHealMRF|healRoutine\(z \*erasureServerPools\)" -n cmd/erasure-server-pool.go cmd/*.go | head -n 120
```

實務判讀：
- 如果你能在 goroutine dump/pprof 裡看到 `mrfState.healRoutine` 存在，但 queue 一直不消費：偏向 consumer 被 I/O/鎖/排程卡住（或 healSleeper 節流）。
- 如果你完全找不到啟動點：可能是該部署模式/角色根本不跑 MRF（例如 gateway/特殊啟動參數），這時候 partial 可能要靠 scanner/admin heal 才補得回來。

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

### 2.2.2（新增）當 Healing 需要跨節點：Peer REST（grid RPC）常見 handler（背景 heal status / HealBucket）

> 目的：你在現場常看到「某個 node 很忙/很慢」但 heal/status 看起來是從別的節點發起；這時候把 **peer REST（grid RPC）** 的 client/server 錨點釘死，就能更快回答：
> - 這是不是透過 grid 轉發到 peer？
> - peer 端是哪個 handler 在處理？
> - 為什麼會跟 `canceling remote connection`（streaming mux watchdog）同時間出現？

以我 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）目前版本觀察，peer REST 這邊跟 healing 最常直接相關的是：

- **背景 heal 狀態（BgHealState）**
  - client：`cmd/peer-rest-client.go`
    - `func (client *peerRESTClient) BackgroundHealStatus() (madmin.BgHealState, error)`
  - server：`cmd/peer-rest-server.go`
    - `func (s *peerRESTServer) BackgroundHealStatusHandler(_ *grid.MSS) (*grid.JSON[madmin.BgHealState], *grid.RemoteErr)`
    - handler 註冊：`getBackgroundHealStatusRPC.Register(...)`（handler id：`grid.HandlerBackgroundHealStatus`）

- **HealBucket（bucket-level heal 的 peer 端執行）**
  - server：`cmd/peer-rest-server.go`
    - `func (s *peerRESTServer) HealBucketHandler(mss *grid.MSS) (grid.NoPayload, *grid.RemoteErr)`
    - 內部會呼叫：`healBucketLocal(ctx, bucket, madmin.HealOpts{...})`
    - handler 註冊：`healBucketRPC.Register(...)`（handler id：`grid.HandlerHealBucket`）

> 註：不同 RELEASE tag 可能會新增/調整 handler 名稱；但 `peer-rest-client/server.go` + `grid.Handler*` 這組 pattern 跨版本通常很穩。

---



## 2.2.3（補）HealBucket 的 local 落點：`healBucketLocal()` → `HealObject()`（為什麼 bucket-level heal 會放大成大量 object heal）

> 目的：現場常會看到 `mc admin heal -r <bucket>` 或 background heal worker 在跑 **bucket heal**，但你真正要回答的是：
> - bucket heal 最終怎麼變成一個個 `HealObject()`？
> - 它是從哪個 worker/queue 跑出來的？
> - 這些 object heal 很可能透過 peer REST/grid RPC 打到同一批節點，進而跟 `canceling remote connection` 共振。

### A) bucket-level handler（admin/peer）到 local heal 的橋接

- `cmd/peer-rest-server.go`
  - `func (s *peerRESTServer) HealBucketHandler(...)`
    - 常見會呼叫：`healBucketLocal(ctx, bucket, opts)`

- `cmd/admin-handlers.go`
  - `func (a adminAPIHandlers) HealHandler(...)`
    - 解析 heal request 後，可能落到 bucket/prefix heal（不同版本路徑略有差）

一鍵釘死：
```bash
cd /path/to/minio

# local bucket heal 的真正落點
grep -RIn "func healBucketLocal" -n cmd | head -n 50

# peer handler → healBucketLocal
grep -RIn "HealBucketHandler" -n cmd/peer-rest-server.go | head -n 80
grep -RIn "healBucketLocal\(" -n cmd/peer-rest-server.go cmd/*.go | head -n 80

# admin handler（若要對齊 admin heal）
grep -RIn "func \(a adminAPIHandlers\) HealHandler" -n cmd/admin-handlers.go
```

### B) `healBucketLocal()` 內部：列舉 objects → 逐一呼叫 `HealObject()`（觀測/瓶頸在哪）

> 你要的重點通常不是「bucket heal 能不能跑完」，而是：它在列舉時吃掉多少 metadata I/O，並且在 heal phase 造成多少 `HealObject` RPC/本地 I/O。

因版本不同，bucket heal 可能會透過：
- metacache / scanner 結果
- 或直接 list bucket/prefix

但幾乎都會出現這類模式：
- `for item in <object list>` → `o.HealObject(ctx, bucket, object, versionID, healOpts)`

一鍵釘死（先從 call site 反推）：
```bash
cd /path/to/minio

# 找出 healBucketLocal 的定義與所在檔案
grep -RIn "func healBucketLocal" -n cmd | head -n 80

# 再從 healBucketLocal 所在檔案/同檔追 HealObject 呼叫（用檔名縮小範圍會更準）
grep -RIn "HealObject\(" -n cmd | grep -E "healBucketLocal|HealBucket" || true
```

### C) background heal worker（自動/排程）是怎麼觸發 bucket heal 的？

> 目的：把「背景任務」釘到實際 worker/queue，方便跟 CPU/I/O/`canceling remote connection` 的時間窗做關聯。

常見線索：
- `cmd/background-heal-ops.go`：背景 heal task/worker 的 switch（HealFormat/HealBucket/HealObject）
- `cmd/global-heal.go`：`healErasureSet()` / bucket heal 的排程與 fan-out

一鍵 grep：
```bash
cd /path/to/minio

ls cmd/background-heal-ops.go cmd/global-heal.go 2>/dev/null

# worker switch：task 類型（bucket/object）
grep -RIn "type healTask|case .*HealBucket|case .*HealObject" -n cmd/background-heal-ops.go cmd/*.go | head -n 120

# 排程點（不同版本可能叫 healErasureSet / initBackgroundHealing）
grep -RIn "healErasureSet\(|initBackgroundHealing|initAutoHeal" -n cmd/global-heal.go cmd/*.go | head -n 120
```

> 實務判讀：如果你在同一時間窗看到大量 bucket/object heal（MRF + scanner + admin/background 混在一起），peer REST/grid streaming mux 的長連線數量會上升，`canceling remote connection` 很容易成為「結果」而被放大。

## 2.3 HealObject() 的「落地」：ObjectLayer.HealObject → erasureObjects.healObject → RS rebuild + RenameData

> 目的：把 `HealObject(...)` 這個「看起來很高階」的 API，一路釘到真正吃 I/O 的地方（RS rebuild、寫回、rename/fsync）。
>
> 你在排查 healing 跟 PutObject latency / `canceling remote connection` 共振時，最常需要回答兩件事：
> 1) **到底是誰在呼叫 HealObject**（MRF / scanner / admin heal）
> 2) **HealObject 裡面最重的 I/O 在哪**（通常是 `Erasure.Heal` + `RenameData` + metadata fan-out）

### 2.3.1 入口：ObjectLayer.HealObject（multi-pool → sets → objects）

常見錨點（不同版本可能會在 `cmd/erasure-server-pool.go` / `cmd/erasure-sets.go` / `cmd/erasure-healing.go` 之間調整，但 receiver 名稱通常很穩）：

```bash
cd /path/to/minio

# 從 interface 呼叫端往下追
grep -RIn "HealObject(ctx" -n cmd | head -n 40

# ObjectLayer 實作（multi-pool / pool / sets）
grep -RIn "func (z \*erasureServerPools) HealObject" -n cmd | head -n 40
grep -RIn "func (p \*erasureServerPool) HealObject" -n cmd | head -n 40
grep -RIn "func (s \*erasureSets) HealObject" -n cmd | head -n 40
```

### 2.3.2 真正的 heavy path：`erasureObjects.healObject`（metadata + RS + writeback/rename）

```bash
cd /path/to/minio

# healing 主檔通常在這
grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go

# metadata fan-out / quorum（讀各 disk 的 FileInfo）
grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40

# RS rebuild（decode/encode）
grep -RIn "func (e Erasure) Heal" -n cmd/erasure-decode.go

# 寫回/commit（tmp → 正式）
grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 120
```

你要寫 incident note 的時候，這樣描述最不會被挑戰：
- `HealObject` 最終會進 `erasureObjects.healObject()`，它會做「讀 metadata → 判斷缺片/版本 → RS rebuild → 對缺的 disks 寫回 → RenameData/commit」。
- 其中 `RenameData()`（底層會走 rename/fsync 等）常是高 latency 的放大器；在 healing 放大時很容易把整個 node 的 tail latency 拉起來。

一鍵釘死（對你跑的版本）：
```bash
cd /path/to/minio

ls cmd/peer-rest-*.go

# 背景 heal status
grep -RIn "BackgroundHealStatus" -n cmd/peer-rest-client.go cmd/peer-rest-server.go | head -n 80

# HealBucket peer handler
grep -RIn "HealBucket" -n cmd/peer-rest-server.go | head -n 120

# handler id（grid）
grep -RIn "HandlerBackgroundHealStatus|HandlerHealBucket" -n internal/grid cmd/peer-rest-*.go | head -n 120

# 若要把 peer REST 壓力跟 grid 心跳超時對起來：
grep -RIn "canceling remote connection" -n internal/grid | head
```

> 實務判讀：當 healing/scanner/MRF 活躍時，peer REST RPC（特別是 status/調度類）容易放大 grid streaming mux 的壓力；`canceling remote connection` 往往是「結果」（心跳/handler 排隊/網路丟包），不是根因。

### 2.3 HealObject 的正式 ObjectLayer call chain（pool → sets → objects → healObject）

- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
  - `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

快速釘死（避免你在多版本/多 fork 間跳來跳去）：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
```

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
  - **實作位置（可釘死）**：`cmd/erasure-decode.go` → `func (e Erasure) Heal(ctx context.Context, writers []io.Writer, readers []io.ReaderAt, totalLength int64, prefer []bool) (derr error)`

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

# Erasure.Heal() 的實作（RS rebuild）
grep -RIn "func (e Erasure) Heal" -n cmd/erasure-decode.go

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

### 3.1（新增）RenameData 在 OS/FS 層通常會做哪些 syscall？（為什麼它會放大 tail latency）

> 目的：當你在現場看到 healing / PutObject 最後一段卡住、`iostat await` 飆高、甚至開始共振出 `canceling remote connection`，很多時候不是 RS 計算本身，而是 **rename/fsync/metadata ops** 被檔案系統或磁碟 latency 放大。

在大多數 Linux + ext4/xfs 的情境下，`(*xlStorage).RenameData()` 這段常會觸發（實作細節依版本而異，但概念穩定）：
- `mkdir` / `mkdirat`：建立目標 dataDir（或其上層目錄）
- `renameat` / `renameat2`：把 tmp 的 `part.N` 原子搬到正式路徑
- `fsync` / `fdatasync`：確保資料與 metadata 落盤（版本不同，可能對檔案或目錄做）
- 例外：若 src/dst 不在同一個 filesystem/device（理論上 MinIO 會盡量避免），rename 可能退化成 **copy + fsync + unlink**，I/O 會被放大

你要把「卡在 RenameData」釘到 syscall 層時，最省事的做法通常是：
- 用 `pprof` / goroutine dump 先確認堆疊停在 `xlStorage.RenameData`
- 再用 `strace -fp <minio-pid> -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,unlink,openat` 在短時間窗內觀察 syscall latency

> 實務提醒：如果你看到 `RenameData` 的 syscall latency 跟 `iostat` 的 `await/%util` 同時間尖峰，`canceling remote connection` 通常更像是「對端忙到 ping handler 排不到」的結果，而不是網路先壞。

### 3.0（補）把 PutObject 的 `renameData()` 也釘到「每顆 disk 的 RenameData」呼叫點

> 目的：很多讀碼筆記只記到「PutObject 會 renameData → commitRenameDataDir」，但你在現場要判斷 I/O 壓力時，更需要知道：
> - `renameData()` 內部其實也是「逐顆 disk 做 RenameData」
> - 所以 PutObject 的 tail latency 很常跟 storage 層 rename/fsync/metadata lock 直接相關

在多數版本的 MinIO（erasure backend）裡：
- `cmd/erasure-object.go: renameData(...)` 會對 `onlineDisks[]` 逐顆呼叫 `disk.RenameData(...)`
- 換句話說：PutObject 的「tmp → 正式」最後也會落到同一個 storage 介面 `StorageAPI.RenameData()`

### 3.0.1（補）PutObject 的 `renameData()`：`RenameData(src=.minio.sys/tmp, dst=<bucket>/<object>)` 的參數語意

> 目的：在看 iostat/latency 時，能把「是哪一段 Rename」對回 code 的 **src/dst 路徑**。
>
> PutObject 這段 rename 主要是在把 tmp object（`.minio.sys/tmp`）底下的 shards 與 `xl.meta` **原子切換**到正式 bucket/object 路徑。

典型 pattern（不同版本變動多在參數/回傳值，核心語意大致一致）：

- src：`minioMetaTmpBucket`（`.minio.sys/tmp`）
  - `srcEntry` 常見是 `tmpID` 或 `pathJoin(tmpID, <dataDir>)`
- dst：真正的 `bucket` / `object`
  - `dstEntry` 常見是 `object`（內含 `<dataDir>/part.N` 或由 storage layer 依 `FileInfo` 組出）
- metadata：`FileInfo`（包含 `DataDir` / `Erasure.Index` / parts / checksums）

你要在 source tree 釘死這段（最短 grep）：
```bash
cd /path/to/minio

# renameData() 本體
grep -n "^func renameData" cmd/erasure-object.go

# renameData() 內部逐 disk 的 RenameData 參數（看 src/dst bucket/entry）
grep -n "\.RenameData(ctx" cmd/erasure-object.go | head -n 80

# RenameData 的介面與實作（最後會走到檔案系統 rename/fsync）
grep -n "RenameData(ctx" cmd/storage-interface.go
grep -n "func (s \\*xlStorage) RenameData" cmd/xl-storage.go
```

實務判讀：
- 如果 PutObject tail latency 的 spike 同時伴隨 `.minio.sys/tmp` 寫入量大，常見是卡在 **tmp → 正式** 的 rename/commit（metadata-heavy）。
- 與 Healing 的差異：healing 的 commit 通常直接在 `erasure-healing.go` 逐 disk 呼叫 `RenameData()`（同一個 storage 層 commit 點，但呼叫者不同）。

#### （補）`renameData()` / `commitRenameDataDir()` 的「精準函式錨點」
如果你在不同 RELEASE tag 間跳轉，最常卡住的是「rename/commit 的 receiver/檔案名有沒有變」。建議在筆記裡固定記兩個 signature（用來 grep）：
- `cmd/erasure-object.go`：`func renameData(`（回傳值/參數可能改動，但函式名很穩）
- `cmd/erasure-object.go`：`commitRenameDataDir`（receiver 可能是 `erasureObjects` 或 `*erasureObjects`）

可釘死的 grep 錨點（在你跑的版本）：
```bash
cd /path/to/minio

# PutObject 的 renameData() 定義與主要呼叫點
grep -n "^func renameData" cmd/erasure-object.go
grep -n "renameData(ctx" cmd/erasure-object.go | head -n 40

# commitRenameDataDir 的定義與呼叫點
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 120

# renameData() 內部逐 disk 的 storage rename
grep -n "\\.RenameData(ctx" cmd/erasure-object.go | head -n 80

# StorageAPI 介面與 xlStorage 實作
grep -n "RenameData(ctx" cmd/storage-interface.go
grep -n "func (s \\*xlStorage) RenameData" cmd/xl-storage.go
```

> 實務判讀：
> - PutObject 尾端卡住：常直接對應到 `xlStorage.RenameData()` 的 metadata ops（mkdir/rename/fsync）或底層磁碟 latency。
> - Healing 尾端卡住：同樣是 `RenameData()`，但呼叫點通常在 `cmd/erasure-healing.go`（逐 disk commit）。

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
---

## 2.4（補齊）HealObject() → healObject() → 修補寫回：常用的「真正動到 disk」呼叫錨點

> 你在 incident 現場最常需要的不是「HealObject 這個 API 名字」，而是：
> - Heal 會不會真的做 RS rebuild？
> - 最後到底有沒有把資料 **寫回缺片 disk**？
> - 卡住時卡在哪一層（grid RPC / object layer / erasure layer / rename commit）？
>
> 這節把常用的「可跨版本存活」錨點集中在一起，避免你每次都從 `HealObject` 一路翻到最底。

### 2.4.0 先釘「入口」：ObjectLayer.HealObject 的實作落在哪個 receiver

常見（multi-pool + sets + erasureObjects）的入口會長得像：
- `cmd/erasure-server-pool.go`：`(z *erasureServerPools) HealObject(...)`
- `cmd/erasure-server-pool.go`：`(p *erasureServerPool) HealObject(...)`
- `cmd/erasure-sets.go`：`(s *erasureSets) HealObject(...)`
- `cmd/erasure-healing.go`（或依版本拆分）：`(er erasureObjects) HealObject(...)` / `healObject(...)`

快速對齊（在你跑的版本）：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 20
grep -RIn "func (p \\*erasureServerPool) HealObject" -n cmd | head -n 20
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head -n 20

grep -RIn "func (er erasureObjects) HealObject" -n cmd | head -n 20
grep -RIn "func (er erasureObjects) healObject" -n cmd | head -n 20
```

### 2.4.1 釘「真正 rebuild」：RS decode/reconstruct 相關字串 + function 名

不同版本 RS 實作會略有差，但通常你可以用以下關鍵字快速定位到：
- 需要讀 quorum / missing parts 的地方
- 呼叫 Reed-Solomon 重建的地方

建議先用「語意關鍵字」抓住主要函式，再往上追 caller：
```bash
cd /path/to/minio

# 常見：heal / reconstruct / read quorum / missing parts
grep -RIn "healObject" -n cmd | head -n 120
grep -RIn "reconstruct" -n cmd | head -n 120
grep -RIn "missing" -n cmd/erasure-* | head -n 120

# RS：依版本可能在 internal/ 或 cmd/ 下
grep -RIn "reedsolomon" -n . | head -n 120
grep -RIn "New.*Reed" -n . | head -n 120
```

> 實務 tip：
> - 如果你在 stackdump/pprof 看到大量 goroutine 卡在 `grid` / `xnet` / `quic` 之類，通常還沒到 RS rebuild。
> - 如果已經進到 `erasureObjects.healObject`（或等價函式）且 CPU/IO 飆高，才比較像在 rebuild。

### 2.4.2 釘「寫回缺片 disk」：bitrot writer / writeAll / rename commit 的錨點

Healing 的最後一哩路，通常會出現這幾種「非常好釘」的動作：
- 建立 writer（bitrot / healing writer）
- 把缺片 part 寫到 `.minio.sys/tmp/...` 或直接寫到 dataDir
- 透過 rename/commit 把 tmp 轉正

你可以先用這些錨點：
```bash
cd /path/to/minio

# 1) writer 建立點（與 PutObject 類似的 bitrot writer）
grep -RIn "newBitrotWriter" -n cmd | head -n 120

# 2) Healing 端常見會出現的 rename/commit（名稱跨版本最穩）
grep -RIn "renameData" -n cmd | head -n 120
grep -RIn "commitRenameDataDir" -n cmd | head -n 120

# 3) 如果版本有分 heal rename helper
grep -RIn "heal.*rename" -n cmd | head -n 120
```

### 2.4.3 常見卡點分類（用 stackdump / pprof 快速判斷你卡在哪一層）

- **卡在 grid peer RPC（還沒進 object layer）**：
  - stack 會出現 `internal/grid` / `gridConn` / `(*Connection).RoundTrip` / `context deadline` 等
  - 通常對應：網路抖動、peer 過載、remote goroutine 全被 I/O/GC 卡住

- **卡在 ObjectLayer（進了 HealObject 但還沒到 erasure）**：
  - 會看到 `erasureServerPools.HealObject` / `erasureSets.HealObject`
  - 常見：鎖（namespace lock）、版本/metadata 掃描、要先列出 parts/disks 狀態

- **卡在 erasure heal/rebuild（真正重建）**：
  - 會看到 `erasureObjects.healObject`（或等價）以及 RS / decode / readQuorum 相關函式
  - 常見：磁碟讀慢、單 disk 壞道、IOPS 打滿

- **卡在 rename/commit（最後落地/切換）**：
  - stack 會出現 `renameData` / `commitRenameDataDir`
  - 常見：fsync/rename 慢、同目錄大量小檔、底層 FS/raid cache 問題

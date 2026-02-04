# PutObject 路徑追蹤（router → handler → ObjectLayer → erasure）

> 目標：把「S3 PutObject」從 HTTP 入口一路追到最底層 erasure 寫入的主要呼叫鏈，方便後續做效能/一致性/故障注入分析。
>
> 本頁以 **MinIO master (GitHub)** 的程式碼結構/檔名做索引；你實際線上版本（RELEASE tag）可能有差異，但「入口檔案/概念分層」大多一致。

---

## 0. Router：PutObject 會被註冊在哪？

### 0.1 入口：`registerAPIRouter()`
- 檔案：`cmd/api-router.go`
- `registerAPIRouter(router *mux.Router)` 會建立 `objectAPIHandlers` 並註冊 S3 routes。

關鍵：
- 先建立 `api := objectAPIHandlers{ ObjectAPI: newObjectLayerFn }`
- 再建立 `apiRouter := router.PathPrefix("/").Subrouter()`
- 依 domain/path-style 建立一組 `routers`（bucket DNS-style vs path-style）

### 0.2 PutObject 的 route matcher（實際 code）
在 `cmd/api-router.go` 內，**PutObject** 其實有多個分流（headers / query）在 PutObject 之前先匹配：

```go
// CopyObject
router.Methods(http.MethodPut).Path("/{object:.+}").
    HeadersRegexp(xhttp.AmzCopySource, ".*?(\\/|%2F).*?").
    HandlerFunc(s3APIMiddleware(api.CopyObjectHandler))

// PutObject with auto-extract support for zip
router.Methods(http.MethodPut).Path("/{object:.+}").
    HeadersRegexp(xhttp.AmzSnowballExtract, "true").
    HandlerFunc(s3APIMiddleware(api.PutObjectExtractHandler, traceHdrsS3HFlag))

// AppendObject to be rejected
router.Methods(http.MethodPut).Path("/{object:.+}").
    HeadersRegexp(xhttp.AmzWriteOffsetBytes, "").
    HandlerFunc(s3APIMiddleware(errorResponseHandler))

// PutObject (normal)
router.Methods(http.MethodPut).Path("/{object:.+}").
    HandlerFunc(s3APIMiddleware(api.PutObjectHandler, traceHdrsS3HFlag))
```

補充：multipart 的 PutObjectPart 也是 `PUT /{object:.+}`，但會靠 query params 分流：

```go
// PutObjectPart
router.Methods(http.MethodPut).Path("/{object:.+}").
    HandlerFunc(s3APIMiddleware(api.PutObjectPartHandler, traceHdrsS3HFlag)).
    Queries("partNumber", "{partNumber:.*}", "uploadId", "{uploadId:.*}")
```

> 重點：你在 trace PutObject 時，要先確認你看到的是哪一條（Copy、Extract、Multipart part、Normal PutObject）。

---

## 1. Handler：HTTP → S3 API handler

- 檔案（主要）：`cmd/object-handlers.go`
- handler：`func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

在 handler 內通常會做（概念拆解，實際細節請以你的版本對照）：
1) 解析 `bucket/object`：`vars := mux.Vars(r)`、`object := unescapePath(vars["object"])`
2) 鑑權/授權：SigV4、policy action（PutObjectAction）、anonymous 行為差異
3) 解析 headers：`Content-Length`、checksum、`x-amz-meta-*`、tagging、storage-class、object-lock、SSE
4) 建立 reader pipeline：hashing/etag、encryption、compression（可能）
5) quota / lifecycle / replication（視設定而定）
6) 呼叫 ObjectLayer 的 `PutObject` / `PutObjectTags` / 相關 API

### 1.1 以本機 source tree 精準對照（/home/ubuntu/clawd/minio）
以目前 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準：
- 檔案：`cmd/object-handlers.go`
- handler：`func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

你在 handler 內會看到一條非常「可追 code」的 pipeline（摘出關鍵函式名，方便你 grep）：
- 路徑與前置檢查：
  - `mux.Vars(r)` → `unescapePath(vars["object"])`
  - `extractMetadataFromReq(ctx, r)`
  - `isPutActionAllowed(..., policy.PutObjectAction)`
  - `enforceBucketQuotaHard(ctx, bucket, size)`
- SSE / Auto-encryption：
  - `globalBucketSSEConfigSys.Get(bucket)`
  - `sseConfig.Apply(r.Header, sse.ApplyOptions{ AutoEncrypt: globalAutoEncryption })`
- 讀取/驗證管線（hash/etag/checksum）：
  - chunked streaming：`newSignV4ChunkedReader(...)` / `newUnsignedV4ChunkedReader(...)`
  - compression（s2）：`newS2CompressReader(...)`（若可壓縮且 size > minCompressibleSize）
  - hash reader：`hash.NewReaderWithOpts(...)` + `hashReader.AddChecksum(...)`
  - put reader：`pReader := NewPutObjReader(hashReader)`
- ObjectOptions 組裝：
  - `opts, err = putOptsFromReq(ctx, r, bucket, object, metadata)`
  - `opts.IndexCB = idxCb`（壓縮索引 callback）
- 最終落到 object layer：
  - `objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

### 1.2 PutObjectHandler：實際 code 片段定位（含關鍵函式）
以下以 workspace 的 MinIO source 為準（`/home/ubuntu/clawd/minio`）：
- 檔案：`cmd/object-handlers.go`
- 入口：`func (api objectAPIHandlers) PutObjectHandler(...)`（約在 `:1987`）

你要追「PutObject 的核心讀取/驗證/壓縮/opts 組裝/落盤分界」時，可以直接對照這些段落：
- 解析 bucket/object：`mux.Vars(r)` → `unescapePath(vars["object"])`
- content length + auth 類型分支：`getRequestAuthType(r)` + `newSignV4ChunkedReader()` / `newUnsignedV4ChunkedReader()`
- bucket quota：`enforceBucketQuotaHard(ctx, bucket, size)`
- SSE auto-encrypt：
  - `globalBucketSSEConfigSys.Get(bucket)`
  - `sseConfig.Apply(r.Header, sse.ApplyOptions{AutoEncrypt: globalAutoEncryption})`
- 壓縮（s2）分支（可壓縮且 size > minCompressibleSize）：
  - `isCompressible(r.Header, object)`
  - `hash.NewReader(...)`（用來計算 actual-size/etag/checksum）
  - `newS2CompressReader(actualReader, actualSize, wantEncryption)` → `idxCb`
  - `reader = etag.Wrap(s2c, actualReader)` + `size = -1`（compressed size 不可預期）
- hash/etag/checksum 最終 reader：
  - `hash.NewReaderWithOpts(ctx, reader, hash.Options{...})`
  - `hashReader.AddChecksum(r, size < 0)`
  - `pReader := NewPutObjReader(hashReader)`
- ObjectOptions 組裝：`opts, err = putOptsFromReq(ctx, r, bucket, object, metadata)` + `opts.IndexCB = idxCb`

> 你如果要做更細的 trace/metric 插桿點：`NewPutObjReader()`、`putOptsFromReq()`、`objectAPI.PutObject()` 這三段通常最有價值（reader、opts、底層寫入分界）。

---

## 2. ObjectLayer：handler 取得 objectAPI 的方式

- 檔案：`cmd/api-router.go`
  - `newObjectLayerFn() ObjectLayer`：回傳 `globalObjectAPI`

概念上（在 handler 裡）：
- `objectAPI := api.ObjectAPI()`
- `objInfo, err := objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

- interface 定義（索引用）：`cmd/object-api-interface.go`
  - `type ObjectLayer interface { PutObject(...) ... }`

> 這一層是「S3 語意」與「底層儲存實作」分界：
> - 你要插 tracing/metrics
> - 你要做 fault injection
> - 你要找「S3 層」跟「Erasure 層」誰在做什麼
> 都很適合以 ObjectLayer 為切點。

---

## 3. 實作：`newObjectLayer` → `erasureServerPools`

在 erasure 模式下（分散式/多盤）：
- `globalObjectAPI` 實作通常是 `*erasureServerPools`
- PutObject 常見會落到：
  - `(*erasureServerPools).PutObject(...)`

這層典型負責：
- bucket placement / pool & set 選擇
- namespace lock（避免 concurrent update）
- write quorum 決策（依 erasure layout）
- replication / site replication（若有）
- 轉派到某個 set 的 `erasureObjects` 實作

### 3.1 本機 source tree 對照：pool / set 選擇與 lock
以 `/home/ubuntu/clawd/minio` 為準：
- `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) PutObject(...)`
  - `z.NewNSLock(bucket, object)`（若 `!opts.NoLock`）
  - `idx, err := z.getPoolIdxNoLock(ctx, bucket, object, data.Size())`（多 pool 情況下決定 pool）
  - `return z.serverPools[idx].PutObject(...)`（把寫入導向特定 pool）

> 補充：`z.serverPools[idx].PutObject` 在單 pool 情境會一路落到 set/object：`erasureSets.PutObject` → `erasureObjects.PutObject`。

---

## 4. `erasureObjects`：拆 data/parity 並寫入

核心概念：
- object data → chunking → erasure coding（k data + m parity）
- 以並行方式寫到多顆 disk
- 最後寫 metadata（`xl.meta`）+ rename/commit（避免 partial write 被讀到）

常見（概念）呼叫鏈：
- `(*erasureObjects).PutObject(...)`
  - 建立 `hash.Reader` / `PutObjReader`
  - 準備 temp object（避免覆蓋舊版本）
  - erasure encode + write shards
  - 寫入 `xl.meta` / commit rename

### 4.1 本機 source tree 對照：set → erasureObjects
以 `/home/ubuntu/clawd/minio` 為準：
- `cmd/erasure-sets.go`：`func (s *erasureSets) PutObject(...)`
  - `set := s.getHashedSet(object)`
  - `return set.PutObject(ctx, bucket, object, data, opts)`
- `cmd/erasure-object.go`：
  - `func (er erasureObjects) PutObject(...) { return er.putObject(...) }`
  - `func (er erasureObjects) putObject(...)` 裡面可以看到真正的寫入組裝：
    - parity 計算：`globalStorageClass.GetParityForSC(...)`
    - 計算 `dataDrives/parityDrives/writeQuorum`
    - `fi := newFileInfo(pathJoin(bucket, object), dataDrives, parityDrives)` + `fi.DataDir = mustGetUUID()`
    - `onlineDisks, partsMetadata = shuffleDisksAndPartsMetadata(...)`
    - `erasure, err := NewErasure(ctx, dataBlocks, parityBlocks, blockSize)`
    - 後續會做 shard write + `xl.meta` 更新/commit（同檔案後段可繼續往下追）

> 你要找「最底層寫檔」通常會一路追到 `xlStorage`（`cmd/xl-storage.go`）的 write/rename 與 `xl.meta` 操作。

### 4.2 `putObject()` 內部再往下追：temp object / quorum / 清理點
以下以 `/home/ubuntu/clawd/minio` 的 `cmd/erasure-object.go`（`func (er erasureObjects) putObject(...)`）為準，列出一些「很值得下斷點/插 trace」的實際點：

- **Precondition 與 lock（避免 race）**
  - 若 `opts.CheckPrecondFn != nil`：會先 `er.NewNSLock(bucket, object)` 拿鎖，再 `er.getObjectInfo()` 取得舊物件做 precondition。

- **parity/data/quorum 決策點（storage class + online disks）**
  - `storageDisks := er.getDisks()`
  - `parityDrives := globalStorageClass.GetParityForSC(userDefined[xhttp.AmzStorageClass])`
  - availability optimized：會依 offline disks 動態調高 parity（並寫入 `userDefined[minIOErasureUpgraded]`）
  - `writeQuorum := dataDrives`（若 data==parity 則 `writeQuorum++`）

- **本次寫入的 DataDir / temp object（避免 partial 覆蓋）**
  - `fi := newFileInfo(pathJoin(bucket, object), dataDrives, parityDrives)`
  - `fi.DataDir = mustGetUUID()`（每次寫入的新 DataDir）
  - `uniqueID := mustGetUUID()` + `tempObj := uniqueID`
  - `tempErasureObj := pathJoin(uniqueID, fi.DataDir, "part.1")`
  - `defer er.deleteAll(context.Background(), minioMetaTmpBucket, tempObj)`（發生 error 時的清理點）

- **disks 排序與 erasure encoder 建立**
  - `onlineDisks, partsMetadata = shuffleDisksAndPartsMetadata(storageDisks, partsMetadata, fi)`
  - `erasure, err := NewErasure(ctx, fi.Erasure.DataBlocks, fi.Erasure.ParityBlocks, fi.Erasure.BlockSize)`

> 上面這些點（尤其是 `fi.DataDir`、`tempObj`、`writeQuorum`、`deleteAll`）在排查「寫入失敗後留下 temp」「某些盤 offline 導致 parity 升級」「為什麼 quorum 算這樣」時非常好用。

---

## 4.2.1 `erasureObjects.putObject()` 內部：Encode → tmp → rename/commit（精準到函式名）
以下以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準（`cmd/erasure-object.go:1247` 起）。這段是 PutObject 真正把資料寫進 disks、再「原子性 commit」到正式路徑的核心。

### A) shard writer：bitrot writer 寫到 `.minio.sys/tmp`
- 檔案：`cmd/erasure-object.go`
- 先組 `writers[]`，每個 online disk 一個 writer：
  - **非 inline data**：
    - `newBitrotWriter(disk, bucket, minioMetaTmpBucket, tempErasureObj, shardFileSize, DefaultBitrotAlgorithm, erasure.ShardSize())`
  - **inline data（小物件）**：
    - `newStreamingBitrotWriterBuffer(...)` → 最後把 bytes 塞到 `partsMetadata[i].Data`

其中 tmp 寫入路徑組合：
- `uniqueID := mustGetUUID()`
- `fi.DataDir = mustGetUUID()`（每次寫入的新 datadir）
- `tempObj := uniqueID`
- `tempErasureObj := pathJoin(uniqueID, fi.DataDir, "part.1")`

### B) encode & write quorum：`erasure.Encode(...)`
- 檔案：`cmd/erasure-object.go`
- 核心寫入：
  - `n, erasureErr := erasure.Encode(ctx, toEncode, writers, buffer, writeQuorum)`
  - `closeBitrotWriters(writers)`
- 若 `n < data.Size()`：回 `IncompleteBody{}`（代表 client 提早斷/內容不足）

### C) 把 tmp object rename 到正式 bucket/object：`renameData(...)`
- 檔案：`cmd/erasure-object.go`
- 入口呼叫（重要）：
  - `onlineDisks, versions, oldDataDir, err := renameData(ctx, onlineDisks, minioMetaTmpBucket, tempObj, partsMetadata, bucket, object, writeQuorum)`

直覺語意：
- `.minio.sys/tmp/<uniqueID>/<dataDir>/part.1` → `<bucket>/<object>/<dataDir>/part.1`
- 並同時處理 `xl.meta`（依版本/inline/版本化狀態寫入對應 metadata）

### D) commit rename（版本/DataDir 的最終切換）：`commitRenameDataDir(...)`
- 檔案：`cmd/erasure-object.go`
- 呼叫：`er.commitRenameDataDir(ctx, bucket, object, oldDataDir, onlineDisks)`

> 這個步驟對應「把新版本/新 DataDir 變成對外可見的最新狀態」；排查 partial write/版本不一致時很關鍵。

### E) offline disks / MRF（後續補洞）
若不是 speedtest object，且本次寫入過程中有 disk offline：
- `er.addPartial(bucket, object, fi.VersionID)`
或版本差異時：
- `globalMRFState.addPartialOp(partialOperation{...})`

> MRF（most recently failed）這段是你在「寫入成功但某些 disks 當下離線，之後會背景補齊」時，很重要的追查線索。

---

## 4.3 PutObject 精準呼叫鏈（含檔案/receiver）
以下以 workspace 的 MinIO source（`/home/ubuntu/clawd/minio`）為準，列出「從 handler 到最底層 putObject」的 **常見**呼叫鏈（不同版本可能在中間多一層 wrapper，但 receiver/概念大致一致）：

1) `cmd/object-handlers.go`
- `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`
  - `objectAPI := api.ObjectAPI()`
  - `objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

2) `cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`
  - `idx, err := z.getPoolIdxNoLock(ctx, bucket, object, data.Size())`
  - `return z.serverPools[idx].PutObject(ctx, bucket, object, data, opts)`

3) `cmd/erasure-server-pool.go` / `cmd/erasure-sets.go`（視版本/拆檔）
- `func (p *erasureServerPool) PutObject(...)`
  - `return p.sets.PutObject(ctx, bucket, object, data, opts)`

4) `cmd/erasure-sets.go`
- `func (s *erasureSets) PutObject(...) (ObjectInfo, error)`
  - `set := s.getHashedSet(object)`
  - `return set.PutObject(ctx, bucket, object, data, opts)`

5) `cmd/erasure-object.go`
- `func (er erasureObjects) PutObject(...) (ObjectInfo, error)`
  - `return er.putObject(ctx, bucket, object, data, opts)`

6) `cmd/erasure-object.go`
- `func (er erasureObjects) putObject(...) (ObjectInfo, error)`
  - temp object / erasure encode / write shards / `xl.meta` / commit rename

> 建議：如果你要做 profiling 或插 trace，通常把觀察點放在「handler → ObjectLayer」與「`erasureObjects.putObject` 內部 temp/quorum/write」這兩段，收斂最快。

## 5. 讀碼「下一步」清單
- [ ] `cmd/api-router.go`：確認你的 RELEASE tag 版本 PutObject route 是否同樣有 Copy/Extract/Append reject 的分流
- [ ] `cmd/object-handlers.go`：把 `PutObjectHandler` 內部關鍵步驟拆小節：auth、hash、SSE、metadata、etag、通知事件
- [ ] `cmd/object-api-interface.go`：確認 PutObject signature（opts/headers）與不同 path（normal/multipart/copy）共用的部分
- [ ] `cmd/erasure-server-pool*.go`：確認 PutObject 如何選 set / lock / quorum
- [ ] `cmd/erasure-object*.go`：確認最終寫入流程（temp + rename + xl.meta）

---

## 6. 本輪進度
- 補齊 `cmd/api-router.go` 內 PutObject 的實際 route matcher（含 Copy/Extract/Append reject/multipart part 分流）
- 把 ObjectLayer 的取得方式與 handler 呼叫鏈整理成可對照的索引

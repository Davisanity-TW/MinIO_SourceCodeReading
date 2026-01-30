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

> TODO（下一輪精準化）：對照你線上用的 MinIO RELEASE tag，把 `PutObjectHandler` 內每一段對應到具體 helper function（例如：metadata 抽取、SSE apply、hash.NewReader、NewPutObjReader、opts 組裝）。

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

> TODO：把你的版本中 `erasureServerPools.PutObject` 的「選 set 規則」補成可直接追 code 的條列（含：bucket 分配、set 內 drive selection、容量/負載判斷）。

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

> TODO：補齊你版本中的實際檔案/函式名稱（多半在 `cmd/erasure-object*.go` / `cmd/xl-storage*.go` / `cmd/xl-storage-format*.go` 一帶）。

---

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

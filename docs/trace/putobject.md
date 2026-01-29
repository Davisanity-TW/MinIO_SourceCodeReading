# PutObject 路徑追蹤（router → handler → ObjectLayer → erasure）

> 目標：把「S3 PutObject」從 HTTP 入口一路追到最底層 erasure 寫入的主要呼叫鏈，方便後續做效能/一致性/故障注入分析。
>
> 本頁以 **MinIO RELEASE.2024-05-07**（知識庫標題版本）為假設版本；實際檔名/函式如有差異，以當前 checkout 的 MinIO source 為準（下方留了 TODO 方便逐條對照）。

## 0. Router：PutObject 會被註冊在哪？
- 入口：`cmd/routers.go`
  - `configureServerHandler(...)` 會建立 router，並呼叫 `registerAPIRouter(router)`
- S3 API router：`cmd/api-router.go`
  - `registerAPIRouter(router)` 會集中註冊各種 S3 endpoints
  - PutObject（概念上）對應到：
    - Path style：`PUT /{bucket}/{object...}`
    - Virtual-host style：`PUT /{object...}` + Host header 解析 bucket

> TODO（對照）：在 `cmd/api-router.go` 搜 `PutObject` / `putObjectHandler` / `PutObjectHandler`，把實際 route matcher 條件（query params、headers、content-md5、copy source…）補齊。

## 1. Handler：HTTP → S3 API handler
常見的 handler 位置（待逐條確認）：
- `cmd/object-handlers.go`
  - `PutObjectHandler(w, r)`：一般 `PUT Object`
  - `CopyObjectHandler(w, r)`：`x-amz-copy-source`（server-side copy）
  - `NewMultipartUploadHandler` / `PutObjectPartHandler`：multipart 另一路

在 handler 內通常會做：
1) 解析 bucket/object、query params（例如 `?partNumber=`、`?uploadId=` 會分流到 multipart）
2) 鑑權（SigV4 / Policy / IAM）
3) 解析 headers（`Content-MD5`, `Content-Length`, `x-amz-meta-*`, SSE headers…）
4) 建立/包裝 Reader pipeline（hashing、encryption、compression、tee）
5) 呼叫 ObjectLayer

> TODO：把「PutObject handler 內部」拆成小節：auth、hash、SSE、metadata、etag、event notification。

## 2. ObjectLayer：handler 取得 objectAPI 的方式
- `cmd/api-router.go`
  - `newObjectLayerFn()`：從 global 取得 `globalObjectAPI`
- `cmd/object-api-interface.go`
  - `type ObjectLayer interface { PutObject(...) ... }`

呼叫（概念上）：
- `objectAPI := newObjectLayerFn()`
- `objInfo, err := objectAPI.PutObject(ctx, bucket, object, reader, opts)`

> 這一層是「S3 語意」與「底層儲存實作」分界，日後要插桿（metrics/tracing/fault injection）最適合從這裡切。

## 3. 實作：newObjectLayer → erasure server pools
- `cmd/server-main.go`
  - `newObjectLayer(...)` → `newErasureServerPools(...)`

因此 PutObject 常見會落到：
- `erasureServerPools.PutObject(...)`
  - 負責：選 pool / namespace lock / site replication（若有）/ object metadata 協調
  - 最終會委派到某個 set 的 `erasureObjects`

> TODO：把 `erasureServerPools.PutObject` 的「pool/set 選擇規則」補上（包含：bucket placement、drives/sets layout、負載/容量）。

## 4. erasureObjects：把 object 拆成 data/parity 並寫入
核心概念：
- object data → chunking → erasure coding（k data + m parity）
- 寫入到多顆磁碟（不同 disk path）
- 最後寫入 metadata（xl.meta）並完成 commit（避免 partial write 被讀到）

常見的下層呼叫鏈（概念）：
- `erasureObjects.PutObject(...)`
  - `putObject(...)`（內部 helper）
    - 建立 `putObjReader` / `hash.Reader`
    - `erasure.Encode(...)` + parallel write
    - 寫 `xl.meta` / rename temp object 到 final

> TODO：補齊實際函式名稱與檔案：通常在 `cmd/erasure-object.go` / `cmd/erasure-object-common.go` / `cmd/xl-storage*.go` 一帶。

## 5. 讀碼「下一步」清單（今天先把洞挖好）
- [ ] `cmd/api-router.go`：定位 PutObject 的 route 宣告，貼上實際 code 片段（含 matcher）
- [ ] `cmd/object-handlers.go`：把 `PutObjectHandler` 內部關鍵步驟列出（含 SSE / checksum / metadata / object lock）
- [ ] `cmd/object-api-interface.go`：確認 PutObject signature（opts/headers）
- [ ] `cmd/erasure-server-pool.go`：確認 PutObject 是如何選 set / lock / write quorum
- [ ] `cmd/erasure-object.go`：確認最終寫入流程（temp + rename + xl.meta）

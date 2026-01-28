# HTTP Routing（Router → APIs）

## Router 組裝總入口
- `cmd/routers.go`
  - `configureServerHandler(endpointServerPools)`
  - 建 `mux.NewRouter().SkipClean(true).UseEncodedPath()`

## 一定會註冊的 routers
- Admin：`registerAdminRouter(router, true)`
- Health：`registerHealthCheckRouter(router)`
- Metrics：`registerMetricsRouter(router)`
- STS：`registerSTSRouter(router)`
- KMS：`registerKMSRouter(router)`
- S3 API：`registerAPIRouter(router)`

## Distributed（分散式 erasure）才有的 routers
- `registerDistErasureRouters()`：storage / peer / bootstrap / lock + grid

## S3 API 路由
- `cmd/api-router.go`
  - `registerAPIRouter(router)`
  - 會同時支援：
    - Virtual-host style：`{bucket}.<domain>`
    - Path style：`/{bucket}/...`
  - 各種 S3 endpoint route 都集中在這支檔案（很長）

閱讀小技巧：
- 先找你在意的 API（GetObject/PutObject/Multipart）
- 看它對應的 handler
- 再從 handler 往 `ObjectLayer` 追

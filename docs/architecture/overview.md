# 系統總覽（RELEASE.2024-05-07T06-41-25Z）

> 目標：先建立「Startup → Router → Handler → ObjectLayer」的心智模型。

## 高階架構地圖

```mermaid
flowchart LR
  A[main.go
main()] --> B[cmd/main.go
Main(args)]
  B --> C[cmd/server-main.go
serverMain()]
  C --> D[configureServerHandler()
cmd/routers.go]
  D --> E[S3/Admin/STS/KMS/Metrics/Health routers]
  E --> F[Handlers
cmd/api-router.go + handlers]
  F --> G[ObjectLayer interface
cmd/object-api-interface.go]
  G --> H[Erasure Server Pools
cmd/erasure-server-pool.go]
  H --> I[Erasure Sets
cmd/erasure-sets.go]
  I --> J[erasureObjects
(cmd/erasure-*.go)]

  C --> K[IAM Init
cmd/iam.go]
  K --> L[Store: object or etcd
cmd/iam-object-store.go]
```

## 你最常會追的「一條路」
- 一個 S3 request 進來
- router 對到某個 API handler（例如 `GetObjectHandler`）
- handler 透過 `globalObjectAPI` 拿到 `ObjectLayer`
- 最終落到 `erasureServerPools/erasureSets/erasureObjects` 完成 I/O

下一步建議看：
- [啟動流程](/architecture/startup)
- [HTTP 路由與 API](/architecture/http-routing)
- [ObjectLayer 抽象](/architecture/object-layer)
- [Erasure 分層](/architecture/erasure)
- [IAM 初始化與儲存](/architecture/iam)

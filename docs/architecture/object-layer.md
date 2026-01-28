# ObjectLayer（抽象介面與注入點）

## ObjectLayer 介面
- `cmd/object-api-interface.go`
  - `type ObjectLayer interface { ... }`
  - 包含：Bucket ops / Object ops / Multipart / Healing / StorageInfo ...

## global 注入點（Handler 怎麼拿到 ObjectLayer）
- `cmd/api-router.go`
  - `newObjectLayerFn()`：從 global 取 `globalObjectAPI`
  - `setObjectLayer(o ObjectLayer)`：設定 `globalObjectAPI`

## 這個版本主要的實作
- `cmd/server-main.go`
  - `newObjectLayer(...)` → `newErasureServerPools(...)`

> 後續如果你想對某個 API 做性能/一致性分析，ObjectLayer 是最好的切入層：它把「S3 语义」跟底層儲存拆開。

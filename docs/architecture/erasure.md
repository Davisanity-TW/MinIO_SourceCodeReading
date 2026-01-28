# Erasure（ServerPools → Sets → Objects）

## 分層概念
- `erasureServerPools`：多個 pool 的聚合（ObjectLayer 的主要實作）
- `erasureSets`：單一 pool 內的多個 set
- `erasureObjects`：單一 set 的實際 object I/O、encode/decode、metadata、heal

## 關鍵檔案
- `cmd/erasure-server-pool.go`
  - `type erasureServerPools struct { serverPools []*erasureSets ... }`
  - `newErasureServerPools(ctx, endpointServerPools)`
- `cmd/erasure-sets.go`
  - `type erasureSets struct { sets []*erasureObjects ... }`
  - `newErasureSets(...)`

## 背景例行（在 sets 初始化時常見）
- stale multipart 清理
- deleted objects 清理
- endpoints 監控/連線

> 讀碼建議：
> 1) 先理解 pool/set/drive 的 mapping 怎麼決定
> 2) 再挑一條 API（例如 PutObject）追到 `erasureObjects` 的實作

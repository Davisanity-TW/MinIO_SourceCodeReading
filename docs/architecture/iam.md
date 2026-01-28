# IAM（身份/授權系統）

## 啟動點
- `cmd/server-main.go`
  - `globalIAMSys.Init(ctx, newObject, globalEtcdClient, globalRefreshIAMInterval)`（背景 goroutine）

## 核心
- `cmd/iam.go`
  - `type IAMSys struct { ... }`
  - `func (sys *IAMSys) Init(...)`
    - 初始化 OpenID / LDAP / STS TLS / AuthN plugin / AuthZ plugin / OPA 等
    - `sys.initStore(objAPI, etcdClient)` 決定持久層
    - `sys.Load(..., firstTime=true)` 載入 users/policies/mappings
    - `sys.periodicRoutines(...)` 週期性刷新

## Object-based store（把 IAM 存進 MinIO 自己的 metadata）
- `cmd/iam-object-store.go`
  - `IAMObjectStore` 透過 `ObjectLayer` 存取
  - 典型會落在 `.minio.sys/...` 類似路徑

> 你如果公司環境是「無 etcd」：建議優先讀 object store 路徑與格式，通常跟你排查權限/同步問題最直接相關。

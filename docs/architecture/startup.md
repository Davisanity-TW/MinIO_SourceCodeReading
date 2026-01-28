# 啟動流程（Startup）

## 入口呼叫鏈
- `main.go`
  - `func main()` → `minio.Main(os.Args)`
- `cmd/main.go`
  - `Main(args)`：建立 CLI app，註冊 `serverCmd`
- `cmd/server-main.go`
  - `serverCmd`：`minio server ...`
  - `serverMain(ctx)`：主啟動流程（最重要的入口）

## serverMain() 做了什麼（高層次）
- 解析/驗證 endpoints 與 layout
- 初始化 subsystems（KMS/console 等）
- 建立 HTTP handler（`configureServerHandler()`）
- 建 `xhttp.Server` 並 listen/serve
- 建立 `ObjectLayer`（`newObjectLayer()` → Erasure pools）
- `globalIAMSys.Init(...)` 背景啟動（權限/身份）

> 建議讀碼方式：先把 `serverMain()` 當作「總索引」，遇到不熟的 subsystem 先記路徑，不要一開始就鑽到底。
> 

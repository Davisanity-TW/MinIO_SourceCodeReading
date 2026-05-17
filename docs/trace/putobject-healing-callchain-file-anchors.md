# Trace：PutObject / Healing（實際函式/檔案/呼叫鏈定位）

> 目的：把「PutObject 進入 healing/修復流程」這段，整理成可以**直接跳到實際 Go 檔案/函式**的索引頁，方便後續讀碼與排障（例如 `canceling remote connection`）。
>
> 說明：MinIO 版本/commit 不同時檔名與函式可能微調；這頁偏向「讀碼時要找什麼」的地圖。

## 讀碼最常見的兩條路徑

### A) S3 API：`PutObject`（一般上傳路徑）

- HTTP Handler（S3）
  - 入口通常在 `cmd/` 底下的 object handler 檔案（常見：`object-handlers.go` 一類）
  - 典型節點：
    - `PutObjectHandler()`：處理 request/驗證/headers
    - 解析 object name/bucket/etag/metadata 等

- ObjectLayer：`ObjectAPI`/`ObjectLayer` 介面
  - `PutObject()` 會被分派到對應後端（FS/Erasure/…）

- Erasure backend（多數 production）
  - 常見型態：`erasureObjects`（在 `cmd/erasure-*.go`）
  - 典型節點：
    - `(*erasureObjects).PutObject()`：進入 erasure putobject
    - 過程中會有：temp file、rename、fsync/close、寫入 metadata（xl.meta）等

### B) Healing：背景/主動修復（或 PutObject 觸發的修復子路徑）

- Heal 入口（admin/API/背景掃描）
  - `cmd/admin-heal-*.go`、`cmd/background-heal-*.go`（檔名可能不同）
  - 典型節點：
    - `HealObject()` / `healObject()` / `HealBucket()`
    - `healObject()` 會走到讀取/比較各 disk 的 xl.meta + parts

- Peer REST / Grid（跨節點拉資料/協作）
  - `cmd/peer-rest-*.go`、`cmd/grid-*.go`
  - 典型節點：
    - peer/client 呼叫：在 healing 中向其他節點「要資料/要 meta」
    - server handler：對應的 REST endpoint handler

## PutObject →（可能的）Healing 交會點（你要找的關鍵）

> PutObject 本身不是 healing，但在一些情境下會「觸發/依賴修復相關邏輯」或呼叫到與修復同一套底層讀寫（例如 xl.meta、rename/fdatasync、讀取 parts）。

常見交會點類型：

1. **讀寫 xl.meta / parts**：PutObject 寫入的新版本 vs 既有版本、inline data、checksum
2. **rename + fsync**：最容易跟卡住/timeout/取消連線相關（見 troubleshooting）
3. **跨節點讀取/寫入**：分散式下需要 peer/grpc/grid 抓資料

## 實際檔案/函式定位：建議用 grep 的「固定關鍵字」

在 repo（MinIO 原始碼）中建議先用這些關鍵字定位（比死背檔名可靠）：

- Handler：
  - `func (.*) PutObjectHandler` / `PutObjectHandler(`
  - `objectAPI.PutObject(`

- Erasure putobject：
  - `type erasureObjects struct` / `func (.*erasureObjects) PutObject(`
  - `renamePart` / `renameData` / `fsync` / `Fdatasync` / `O_DSYNC`

- xl.meta：
  - `xl.meta`（常見常數/檔名）
  - `xlMetaV` / `xlMeta` / `readXLMeta` / `writeXLMeta`

- Healing：
  - `HealObject` / `healObject` / `healObjectVersion`
  - `backgroundHeal` / `globalBackgroundHeal`

- Peer / Grid：
  - `peerREST` / `peerRESTClient` / `grid` / `gridConn`
  - `canceling remote connection`（排查用，見 troubleshooting）

## 建議你下一步補齊的「可點 anchor」（TODO）

> 這些 TODO 是為了把本頁從「索引」變成「可直接點檔案行號」的閱讀入口。

- [ ] 以某個固定 commit（例如你正在追的 production 版本）為基準，補：
  - Handler 檔案路徑 + `PutObjectHandler()` 行號
  - `(*erasureObjects).PutObject()` 檔案 + 行號
  - rename/fdatasync 的實作檔案 + 行號
- [ ] 補一張簡圖（callchain）：Handler → ObjectLayer → Erasure PutObject → rename/fsync → (peer/grid?)
- [ ] 補 PutObject/Healing 共用的底層：xl.meta encode/decode 的入口

## 相關頁面

- PutObject 主頁：`docs/trace/putobject.md`
- PutObject→Erasure：`docs/trace/putobject-handler-to-erasure-putobject.md`
- Healing 主頁：`docs/trace/healing.md`
- PutObject/Healing callchain（已整理多篇）：`docs/trace/putobject-healing-*.md`
- `canceling remote connection`：`docs/troubleshooting/canceling-remote-connection-one-page-playbook.md`

# Trace：admin heal（server handler / JSON 欄位對照）

> 目標：把 `mc admin heal --json` / `POST /minio/admin/v3/heal/` 的輸出欄位，對回 MinIO server 端是哪個 struct/哪段程式碼組出來的。

## 0) API 入口

- Route：`POST /minio/admin/v3/heal/`
- Handler：`cmd/admin-handlers.go` → `func (a adminAPIHandlers) HealHandler(w http.ResponseWriter, r *http.Request)`

### 0.1 請求參數（Start/Continue/Stop）
`HealHandler` 會先呼叫：
- `extractHealInitParams(mux.Vars(r), r.Form, r.Body)`

其邏輯重點：
- bucket/prefix 來自 path vars：`mgmtBucket` / `mgmtPrefix`
- query string：
  - `clientToken`（有 token → 代表「繼續拿進度」）
  - `forceStart` / `forceStop`
- body（JSON）會 decode 成：`madmin.HealOpts`（只有在 clientToken == "" 時才會讀 body）

> 同一個 endpoint 同時承擔「開始 heal」「拉取進度」「停止 heal」三種語意。

## 1) Response：Start success（回傳 clientToken）
在 `HealHandler` 內：
- 若 clientToken 未提供，但該 path 已有 heal 正在跑，會回傳目前的 token（讓 client 續接）。
- 回傳型別：`madmin.HealStartSuccess`
  - 產生位置：`cmd/admin-handlers.go`（`json.Marshal(madmin.HealStartSuccess{...})`）

欄位來源（server side）：
- `ClientToken`：`nh.clientToken`（distributed mode 可能加上 `:<proxyIndex>`）
- `ClientAddress`：`nh.clientAddress`
- `StartTime`：`nh.startTime`

## 2) Response：Status（JSON / Items）
當 clientToken 已提供且非 forceStart/forceStop：
- `globalAllHealState.PopHealStatusJSON(healPath, hip.clientToken)`

全域 heal state 定義在：
- `cmd/admin-heal-ops.go` → `type allHealState struct { healSeqMap ... }`

### 2.1 healSequenceStatus（整體狀態 JSON）
`cmd/admin-heal-ops.go`：
- `type healSequenceStatus struct { ... }`

重點欄位：
- `Summary`：not started / running / stopped / finished
- `Detail`：失敗原因（若有）
- `StartTime`
- `Settings`：`madmin.HealOpts`
- `Items`：`[]madmin.HealResultItem`

> `Items` 就是 `mc admin heal --json` 最常用來「列出目前處理到哪些 objects」的地方。

## 3) Background heal status（disk 層級 / .healing.bin 對應）
除了「手動 admin heal」，還有背景 healing 的狀態彙總：
- handler：`cmd/admin-handlers.go` → `BackgroundHealStatusHandler`
- 會呼叫：`getAggregatedBackgroundHealState()`
- 其 disk 狀態來源會由 `.healing.bin`（healingTracker）更新（詳見 healing.md）

## 4) 欄位對照表（第一版：先對到 server structs）

| JSON 區塊 | 欄位 | server 端來源（檔案/struct） | 說明 |
|---|---|---|---|
| StartSuccess | ClientToken | `cmd/admin-handlers.go` / `madmin.HealStartSuccess` | 用來續接拉取 Items |
| StartSuccess | ClientAddress | 同上 | client IP |
| StartSuccess | StartTime | 同上 | heal 開始時間 |
| Status | Summary | `cmd/admin-heal-ops.go` / `healSequenceStatus` | running/finished... |
| Status | Detail | 同上 | 失敗細節（若有） |
| Status | StartTime | 同上 | 狀態區塊的開始時間 |
| Status | Settings | 同上（`madmin.HealOpts`） | heal 設定（scan mode 等） |
| Status | Items | 同上（`[]madmin.HealResultItem`） | 每個 item 對應 bucket/object 的 heal 結果 |

> TODO（下一版要補）：
> 1) `madmin.HealResultItem` 的欄位（Bucket/Object/Type/Detail/Result...）在 server 端「哪裡被 append」
> 2) `mc admin heal --json`（client side）實際輸出欄位與 server JSON 是否 1:1

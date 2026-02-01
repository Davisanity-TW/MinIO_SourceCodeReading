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


## 5) Items（madmin.HealResultItem）是在哪裡被產生/塞進 Items[]？

### 5.1 Items[] 的 push 點（server memory queue）
在 `cmd/admin-heal-ops.go`：
- `func (h *healSequence) pushHealResultItem(r madmin.HealResultItem) error`
  - 會把 `r` append 到 `h.currentStatus.Items`
  - 並會設定 `r.ResultIndex`（遞增序號）
  - **上限：`maxUnconsumedHealResultItems = 1000`**
    - 如果 client 沒有繼續用 `clientToken` 拉進度，Items 堆到 1000 之後，heal traversal 會卡住等待（最多 24h，之後 abort）。

> 這也是為什麼「要拿 heal 的 object 清單」最務實的方式是：用 `mc admin heal --json` 持續消費事件流，順便把 JSON 落盤。

### 5.2 單一 object 的 heal result 是在哪裡組出來？
在 `cmd/erasure-healing.go`：
- `func (er *erasureObjects) healObject(...)(result madmin.HealResultItem, err error)`

它會初始化（至少）這些欄位：
- `Type = madmin.HealItemObject`
- `Bucket / Object / VersionID`
- `DiskCount`
- 後續計算/填入：`DataBlocks / ParityBlocks`、以及 Before/After 的 disk 狀態（視版本/路徑）

### 5.3 healSequence 怎麼把每個 object 的結果塞進 Items[]？
在 `cmd/admin-heal-ops.go`：
- `func (h *healSequence) queueHealTask(...)`
  - task 完成後拿到 `healResult`：
    - `res.result.Type = healType`
    - `res.result.Detail = res.err.Error()`（若有）
    - `return h.pushHealResultItem(res.result)`

## 6) 你要的兩個問題：

### 6.1 我怎麼拿到「heal 的檔案清單」？（建議 SOP）
**重點：MinIO 不會把完整清單永久落在某個檔案；要靠 `Items[]` 事件流。**

建議：用 `mc admin heal --json` 把事件流存下來，再自己 parse 成清單。

（範例，實際欄位依版本可能略不同）
```bash
mc admin heal ALIAS/my-bucket/my/prefix/ --recursive --json > heal.jsonl

# 抽出 bucket/object
jq -r 'select(.Items?) | .Items[]? | [.Bucket,.Object,.VersionID,.Type,.Detail] | @tsv' heal.jsonl
```

### 6.2 我怎麼 trigger heal 某些檔案？
最常用/最安全的方法是 **用 bucket/prefix 限縮範圍**：
- `mc admin heal ALIAS/my-bucket/path/to/prefix/ --recursive`

如果你要更「強力」的掃描（較慢）：
- `--scan deep`

> 底層 server 其實有 `ObjectLayer.HealObject(bucket, object, versionID, opts)` 這種精準接口（見 `cmd/object-api-interface.go`），但 CLI 主要是以 bucket/prefix 的方式讓你觸發一批 objects。

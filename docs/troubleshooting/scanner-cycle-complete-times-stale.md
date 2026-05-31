# `cycle_complete_times` 停在舊日期：語意與排查

> 針對 `mc admin scanner status myminio -n 1 --json` 裡的 `cycle_complete_times`。

## TL;DR

`cycle_complete_times` 不是「目前 scanner 還活著」的 heartbeat，也不是 mc client 自己算出來的欄位。

它是 MinIO server 端 data scanner **成功跑完整個 namespace scanner cycle** 後，append 進 metrics 的完成時間歷史。換句話說：

- 有新值：至少有一個 scanner cycle 成功完整結束。
- 沒新值：代表最近沒有新的 scanner cycle 成功完整結束，或你看到的是舊 leader / 舊 metrics / 舊狀態。
- 停在去年的某一天：高度可疑，應先往「scanner 沒再成功完成 cycle」排查，而不是先懷疑 `mc` 的 JSON 顯示壞掉。

## 2026-05-31 追加結論

我又用本機 `minio` / `mc` checkout 比對了一次 upstream `origin/master`（MinIO `7aac2a2`、mc `77f82e1`），目前這條邏輯仍然成立：

- `cycle_complete_times` 只來自 server 端 `cycleInfo.cycleCompleted`。
- `cycleInfo.cycleCompleted` 只在 `objAPI.NSScanner(...)` 回傳 `err == nil` 後 append。
- MinIO 只保留最近 `dataUsageUpdateDirCycles = 16` 筆完成時間；它不是完整歷史，也不是每分鐘更新的狀態欄位。
- `mc` JSON 模式沒有重算或補值；它只是把 admin metrics API 回傳的 scanner metrics 印出來。

所以現場如果長期停在去年的日期，最強假設仍是：**scanner 自那之後沒有成功完成過新的 full namespace cycle**。接下來要分辨的是「還在超長 cycle 裡慢慢跑」、「每次跑到某處失敗」、「leader / node / metrics 看到舊狀態」，或「`.minio.sys` 裡的 scanner cycle state / usage cache 寫入有問題」。

## 原始碼結論

以本機 MinIO checkout `7aac2a2`（已 fetch upstream `origin/master`）為基準：

### 1. scanner cycle 由 server 端 `runDataScanner()` 推進

`cmd/data-scanner.go`：

```go
func runDataScanner(ctx context.Context, objAPI ObjectLayer) {
    ctx, cancel := globalLeaderLock.GetLock(ctx)
    defer cancel()
    ...
    case <-scannerTimer.C:
        scannerTimer.Reset(scannerCycle.Load())
        ...
        cycleInfo.current = cycleInfo.next
        cycleInfo.started = time.Now()
        globalScannerMetrics.setCycle(&cycleInfo)
        ...
        err := objAPI.NSScanner(ctx, results, uint32(cycleInfo.current), scanMode)
        ...
        if err == nil {
            cycleInfo.next++
            cycleInfo.current = 0
            cycleInfo.cycleCompleted = append(cycleInfo.cycleCompleted, time.Now())
            ...
            globalScannerMetrics.setCycle(&cycleInfo)
            ...
            err = saveConfig(ctx, objAPI, dataUsageBloomNamePath, tmp)
        }
    }
}
```

關鍵點：

- MinIO 用 `globalLeaderLock.GetLock(ctx)` 確保 cluster 內「應該只有一個 scanner runner」。
- cycle 開始時會設定 `current` 與 `started`。
- 只有 `objAPI.NSScanner(...)` 回傳 `err == nil` 時，才會：
  - `cycleInfo.next++`
  - `cycleInfo.current = 0`
  - `cycleInfo.cycleCompleted = append(..., time.Now())`
  - 更新 `globalScannerMetrics`
  - 寫回 `.minio.sys/buckets/.bloomcycle.bin`

所以 `cycle_complete_times` 的新增條件很嚴格：**整個 NSScanner cycle 要成功完成**。

另一個容易忽略的點是 `dataUsageUpdateDirCycles = 16`：

```go
dataUsageUpdateDirCycles = 16 // Visit all folders every n cycles.
...
cycleInfo.cycleCompleted = append(cycleInfo.cycleCompleted, time.Now())
if len(cycleInfo.cycleCompleted) > dataUsageUpdateDirCycles {
    cycleInfo.cycleCompleted = cycleInfo.cycleCompleted[len(cycleInfo.cycleCompleted)-dataUsageUpdateDirCycles:]
}
```

因此 `cycle_complete_times` 最多反映最近 16 次成功完成時間。若最後一筆是去年，代表不是「歷史太短所以沒看到」，而是最近 16 次裡也沒有任何更新；也就是最近沒有成功完成的新 cycle。

### 2. metrics report 只是把這份歷史轉出去

`cmd/data-scanner-metric.go`：

```go
func (p *scannerMetrics) report() madmin.ScannerMetrics {
    var m madmin.ScannerMetrics
    cycle := p.getCycle()
    if cycle != nil {
        m.CurrentCycle = cycle.current
        m.CyclesCompletedAt = cycle.cycleCompleted
        m.CurrentStarted = cycle.started
    }
    ...
}
```

`CyclesCompletedAt` 對應 madmin-go 的 JSON tag：

```go
CyclesCompletedAt []time.Time `json:"cycle_complete_times"`
```

因此 `mc admin scanner status --json` 看到的 `cycle_complete_times` 是 server 回傳的 scanner metrics 欄位。

### 3. mc client 不會自己更新這個欄位

`mc` 的 `cmd/admin-scanner-status.go` 只做兩件事：

- 呼叫 admin metrics API：`client.Metrics(..., Type: madmin.MetricsScanner, N: ctx.Int("n"))`
- JSON 模式下直接 `printMsg(metricsMessage{RealtimeMetrics: metrics})`

UI 模式裡 `mc` 會用 `CyclesCompletedAt` 估算 full scan time，但 `mc` 沒有任何邏輯會自行產生或修正 `cycle_complete_times`。

補充：UI 模式會先把 `CyclesCompletedAt` 依時間排序，再用最近完成時間差估算 full scan time；這會影響人類可讀的「Last full scan time / Est. full scan time」，但不會改變 JSON 裡的 `cycle_complete_times`。

## 為何它會停在去年某一天？

依照上面的 code，最直接的判斷是：

> 從那一天之後，沒有新的 scanner cycle 成功完整跑完並寫入 metrics/cache。

常見原因分幾類。

## A. scanner cycle 還在跑，但跑超久

`scannerCycle` 是「兩次啟動 cycle 的 timer」，不是保證多久完成一次 full scan。MinIO 的 config 文件也明講 data usage scanner 會依系統速度調整，系統有 load 時會 pause；delay/speed 越保守，反映更新越慢。

如果 namespace 很大、版本數很多、prefix 很深、磁碟很慢，或同時有 healing / lifecycle / replication / rebalance 壓力，一個 cycle 可能非常久。此時 `current_cycle` / `current_started` 可能會有值，但 `cycle_complete_times` 不會新增，直到該 cycle 完整完成。

先看：

```sh
mc admin scanner status myminio -n 1 --json
```

重點欄位：

- `current_cycle`
- `current_started`
- `cycle_complete_times`
- `active`
- `life_time_ops`
- `last_minute`

判讀：

- `current_cycle > 0` 且 `current_started` 很舊：scanner 可能卡在某個超長 cycle。
- `active` 長期固定在同一批 path：可能卡在特定 bucket/prefix/object/version。
- `last_minute.actions` 幾乎沒變：可能 scanner 幾乎沒進展，或 metrics 沒從真正 scanner leader 回來。
- `current_cycle == 0` 且 `current_started` 是 zero / 空值，但 `cycle_complete_times` 很舊：可能 scanner runner 沒有進入新 cycle，先查 leader lock、server restart、scanner config、節點健康與 logs。
- `current_cycle > 0`、`current_started` 是近期、`active`/`last_minute` 有變：比較像只是目前 cycle 還沒完成；此時不要期待 `cycle_complete_times` 每分鐘變。

## B. scanner cycle 失敗，所以不 append 完成時間

原始碼只有 `err == nil` 才 append `cycleCompleted`。如果 `NSScanner` 每次都遇到 error，`cycle_complete_times` 不會更新。

現場要找 data scanner 相關錯誤：

```sh
# systemd / bare metal
journalctl -u minio --since "24 hours ago" \
  | egrep -i 'data-scanner|scanner|NSScanner|bloomcycle|usage-cache|heal|drive.*offline|disk.*offline|timeout|context deadline'

# Kubernetes
kubectl logs -n <ns> <pod> --since=24h \
  | egrep -i 'data-scanner|scanner|NSScanner|bloomcycle|usage-cache|heal|drive.*offline|disk.*offline|timeout|context deadline'
```

特別注意：

- drive / disk offline
- read/write quorum 問題
- `.minio.sys` / config save 失敗
- metadata / xl.meta 讀取錯誤
- healing / scanner 同時間大量 timeout

判讀上要特別抓 `data-scanner` log 裡的 cycle error。`runDataScanner()` 即使 `NSScanner` 回 error，也會呼叫 `scannerLogIf(ctx, err)` 並在 scan-cycle metric 裡記錄 `error`；但因為 append 完成時間的分支不會進去，`cycle_complete_times` 會停住。

## C. scanner leader / 節點狀態異常

`runDataScanner()` 先拿 `globalLeaderLock`。如果 leader 卡住、頻繁切換、或你查到的 aggregated metrics 沒含到真正 scanner runner，可能看到舊的完成時間。

建議同時查：

```sh
mc admin scanner status myminio --nodes all -n 1 --json
mc admin info myminio --json
mc admin heal status myminio --json
```

看每個 node 是否一致：

- 哪些 node 有 `current_cycle` / `current_started`
- 哪些 node 的 `active` 有掃描 path
- 是否有 offline drives / healing backlog
- cluster 是否近期有 leader / pod restart / drive replacement

## D. scanner 被設定得太慢，或實際上長期 pause

新版 scanner config 有 `scanner speed`，舊版也有 deprecated 的 `delay/max_wait/cycle`。重點不是只看 `cycle`，而是 scanner 每個 operation 會被 delay/speed 調節。

檢查：

```sh
mc admin config get myminio scanner
mc admin config get myminio heal
```

如果看到 scanner speed 很慢、delay 很大，或 heal / scanner 同時保守，`cycle_complete_times` 可能很久才更新。但「停在去年」通常已經超出正常慢速範圍，應該回到 A/B/C 查是否卡住或失敗。

## E. `.bloomcycle.bin` / usage cache 狀態舊或寫不進去

MinIO 會從 `.minio.sys/buckets/.bloomcycle.bin` 載入 cycle state，完成後也會寫回同一路徑。若 `.minio.sys` 相關 object / backend 寫入失敗，或某次遷移/還原留下舊狀態，可能造成你看到的歷史停在舊時間。

不要直接手改或刪 `.minio.sys`。先收證：

```sh
mc admin scanner status myminio -n 1 --json > scanner-status.json
mc admin info myminio --json > admin-info.json
mc admin heal status myminio --json > heal-status.json
```

再用 server log 對照 `.bloomcycle.bin` / usage-cache 相關錯誤。

## F. 版本 / fork / 回滾造成 state 與 code 認知不一致

如果 cluster 曾經升級、降版、切換 image tag、還原 `.minio.sys` 或替換 drive，`cycle_complete_times` 看到的是 server 當下讀到的 persisted cycle state，而不是 `mc` 根據目前時間推導出來的結果。

建議把以下資訊一起收進 incident note：

```sh
mc admin info myminio --json > admin-info.json
mc admin scanner status myminio --nodes all -n 1 --json > scanner-status-all-nodes.json
mc admin config get myminio scanner > scanner-config.txt
mc admin config get myminio heal > heal-config.txt
```

如果不同 node 回報的 `current_started` / `cycle_complete_times` 不一致，先不要只看 aggregated 結果；直接對照 `--nodes all`，找出真正有 active path 或 current cycle 的節點。

## 最短排查順序

1. 先保存 `mc admin scanner status myminio -n 1 --json`，確認 `current_cycle/current_started/active/last_minute/cycle_complete_times`。
2. 用 `--nodes all` 看是不是只有某些 node 有進展，或 metrics 聚合看到舊 leader。
3. 查 MinIO server log：`data-scanner|scanner|NSScanner|bloomcycle|usage-cache|drive offline|timeout|quorum`。
4. 查 `mc admin info` / `mc admin heal status`，看是否有 offline drive、healing backlog、quorum / I/O 壓力。
5. 查 scanner/heal config。若只是慢，會有 active path / ops 緩慢變化；若停在去年，多半不是單純 config 慢。
6. 若 `--nodes all` 顯示不同節點狀態不一致，優先查 leader / pod restart / node clock / metrics 聚合來源。
7. 若 log 出現 `.bloomcycle.bin` 或 usage-cache save/read 錯誤，先保留證據，不要直接手動刪 `.minio.sys` 物件。

## 可以寫進 incident note 的判斷句

> `cycle_complete_times` 來自 MinIO server 端 scanner metrics 的 `CyclesCompletedAt`，只有 `runDataScanner()` 內 `objAPI.NSScanner(...)` 成功回傳 `err == nil` 後才 append。現場值停在 `<date>`，代表自該時間後沒有觀測到成功完成的新 scanner cycle；下一步應查 `current_cycle/current_started/active` 是否卡住、server log 是否有 scanner/usage-cache/quorum 錯誤，以及 scanner leader / drive / healing 狀態，而不是先判定 mc client 顯示異常。

## Source anchors

- MinIO `7aac2a2`（本機 checkout；已確認 upstream `origin/master` 同 commit）
  - `cmd/data-scanner.go:51`：`dataUsageUpdateDirCycles = 16`
  - `cmd/data-scanner.go:158`：`runDataScanner(...)`
  - `cmd/data-scanner.go:208`：`objAPI.NSScanner(...)`
  - `cmd/data-scanner.go:215-229`：只有 `err == nil` 才 append `cycleCompleted` 並寫回 `.bloomcycle.bin`
  - `cmd/data-scanner-metric.go:293-295`：`report()` 把 `cycle.cycleCompleted` 放進 `madmin.ScannerMetrics`
  - `cmd/data-usage.go:36-37`：`dataUsageBloomNamePath = .minio.sys/buckets/.bloomcycle.bin`
- madmin-go `v3.0.51`
  - `metrics.go:227`：`type ScannerMetrics`
  - `metrics.go:235`：`CyclesCompletedAt []time.Time json:"cycle_complete_times"`
- mc `77f82e1`（本機 checkout；已確認 upstream `origin/master` 同 commit）
  - `cmd/admin-scanner-status.go:261`：呼叫 `client.Metrics(... Type: madmin.MetricsScanner ...)`
  - `cmd/admin-scanner-status.go:416-435`：UI 使用 `CyclesCompletedAt` 估算 full scan time

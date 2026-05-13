# Troubleshooting：為什麼同樣的 peer 流量，有時會看到 `canceling remote connection`，有時完全不會？（DeadlineMS / streaming mux 條件）

> 目標：把這句 log 的「出現條件」釘到 MinIO `internal/grid` 的程式碼判斷，避免現場誤判：
> - 看到 log → 以為一定是網路壞
> - 沒看到 log → 就以為 grid/peer RPC 沒問題

相關頁：
- `docs/troubleshooting/canceling-remote-connection-root-causes.md`（root cause buckets）
- `docs/trace/putobject-healing-callchain.md`（PutObject ↔ MRF ↔ Healing ↔ peer REST/grid）

---

## 1) 這句 log 的位置（server 端）

在 MinIO source tree（上游 repo）裡，`canceling remote connection` 這句最常見的出處是：

- `internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`

語意：server 端的 streaming mux 會定期檢查「多久沒看到 remote 的 ping」，超過閾值就把連線關掉，並印出：

- `canceling remote connection` + `not seen for ...`

---

## 2) 為什麼不是每條 grid/peer RPC 都會啟動 `checkRemoteAlive()`？

`checkRemoteAlive()` 通常只會對「看起來會跑很久」的 streaming mux 啟動（也就是：沒有短 deadline，或 deadline 遠大於 watchdog 閾值）。

### 2.1 你要釘死的判斷點：`DeadlineMS`

在 `internal/grid/muxserver.go` 裡（不同 RELEASE tag 可能有小幅改名/搬動），你會看到類似下面的條件：
- `msg.DeadlineMS == 0`（沒有 deadline）
- 或者 `msg.DeadlineMS` 很大（大於 `lastPingThreshold`）

滿足條件才會額外啟 goroutine 去跑 `checkRemoteAlive()`。

這就是為什麼：
- 同樣的 handler/同樣的 peer，某些情境（deadline 短、request 很快結束）不會看到這句 log
- 但在 healing/scanner/rebalance/trace 這類「長時間背景流量」放大時，很容易看到（因為 mux 壽命長，且可能沒有短 deadline）

---

## 3) watchdog 閾值為什麼常見是 ~60s？（clientPingInterval × 4）

常見 code anchors：
- `internal/grid/grid.go`：`clientPingInterval = 15 * time.Second`
- `internal/grid/muxserver.go`：`lastPingThreshold = 4 * clientPingInterval`（因此約 60s）

所以你在 log 上常見 `not seen for 1m0s` 左右的數字。

---

## 4) 一組最短 grep（在你線上跑的 MinIO 版本把條件釘死）

```bash
cd /path/to/minio

# 1) 找 log
grep -RIn "canceling remote connection" -n internal/grid | head

# 2) 釘 checkRemoteAlive 與 lastPingThreshold
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80
grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go internal/grid/grid.go | head -n 120

# 3) 釘 DeadlineMS 條件（決定是否啟 watchdog）
grep -RIn "DeadlineMS" -n internal/grid/muxserver.go | head -n 120
```

---

## 5) 現場解讀：看到/沒看到這句 log，各代表什麼？

- **看到 `canceling remote connection`**：
  - 代表 server 端在某條 streaming mux 上，超過門檻時間沒看到 ping（或 ping handler 排不到）
  - 下一步應回到 root cause buckets（磁碟 tail latency / CPU throttling / 網路 drops/conntrack / 對端重啟）去找 upstream

- **沒看到 `canceling remote connection`**：
  - 不代表沒問題；可能只是這批 request 都有短 deadline、或很快結束，watchdog 沒被啟動/來不及觸發
  - 若 client 端仍看到 timeout / `ErrDisconnected` / `context deadline exceeded`，仍應對齊兩端時間窗查 disk/cpu/network

# Troubleshooting：`canceling remote connection`（grid ping/pong 閾值與時間軸）

> 目的：把你在現場看到的 `canceling remote connection ... not seen for ~60s` / `ErrDisconnected` 這類訊息，直接對回 **MinIO internal/grid 的 ping/pong 時間閾值**。
>
> 你要回答的通常不是「網路是不是壞了」這種籠統問題，而是：
> - **到底是哪一端先決定斷線？**（client vs server）
> - **它在等什麼事件？**（ping / pong）
> - **為什麼會是 30s / 60s 這種數字？**
> - 跟 healing / scanner / rebalance 等背景流量尖峰如何關聯？


## TL;DR（你最常用的判讀）

- **client 端**常見在「約 30s 沒看到 pong」就先斷：比較常在 log/trace 先出現 `ErrDisconnected`。
- **server 端**常見在「約 60s 沒看到 ping」才印：`canceling remote connection ... not seen for ...`。
- 兩者同時出現時，常見時間軸是：
  1) client 端先斷（30s 沒 pong）
  2) server 端稍後才發現（60s 沒 ping）並印出 `canceling remote connection`

> 現場解釋模板：**這通常不是「server 主動砍線」為主因，而是某端（或雙端）在那段時間窗內忙到 ping/pong handler 沒被排程/回覆，最後被 watchdog 視為 dead。**


## 1) 相關檔案與關鍵常數（跨版本最穩的錨點）

在 MinIO source tree（不同 tag 可能有小幅調整，但 pattern 很穩）：

- `internal/grid/grid.go`
  - `clientPingInterval = 15 * time.Second`（常見值）

- `internal/grid/muxserver.go`
  - `lastPingThreshold = 4 * clientPingInterval` → **約 60s**
  - `(*muxServer).checkRemoteAlive()`：超過 threshold → log `canceling remote connection ...` → close

- `internal/grid/muxclient.go`
  - `LastPong` watchdog：常見是 `clientPingInterval*2` → **約 30s**
  - 超過阈值通常會回 `ErrDisconnected`（或 close stream）

一鍵釘死（不用猜行號）：
```bash
cd /path/to/minio

# 1) 先釘 ping interval
grep -RIn "clientPingInterval" -n internal/grid | head -n 40

# 2) server 端閾值 + cancel log
grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go internal/grid/grid.go | head -n 80
grep -RIn "canceling remote connection" -n internal/grid/muxserver.go | head -n 80
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

# 3) client 端 pong watchdog
grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 120
grep -RIn "ErrDisconnected" -n internal/grid/muxclient.go internal/grid/connection.go | head -n 120
```


## 2) 時間軸：30s / 60s 是怎麼來的？

以預設常數 `clientPingInterval = 15s` 為例：

- **client watchdog（pong）**：`2 * 15s = 30s`
  - client 端會定期送 ping，並期待收到 pong（或某種回覆/更新 LastPong 的訊號）
  - 若 30s 內都沒看到 pong 更新，client 會視為 peer 失聯 → 先斷線

- **server watchdog（ping）**：`4 * 15s = 60s`
  - server 端主要看的是「有沒有收到 client 的 ping」
  - 若 60s 都沒看到 ping，server 才會印 `canceling remote connection ... not seen for ~60s`

> 所以你看到 server log 的 `~60s` 時，很多時候 client 其實早在 `~30s` 就已經先斷了。


## 3) `DeadlineMS` 與「為什麼這條 watchdog 只在某些 RPC 出現？」

`muxserver` 在建立 streaming mux / stream handler 時，通常會根據 `msg.DeadlineMS`（是否有 deadline、deadline 是否太長）決定要不要起 `checkRemoteAlive()`。

常見語意（版本略有差異，但概念一致）：
- **短 deadline** 的 request：用 deadline 本身就足夠，不一定需要額外 watchdog。
- **沒有 deadline** 或 deadline 太長的 streaming：會起 watchdog，避免卡死的長連線永遠掛著。

一鍵釘死：
```bash
cd /path/to/minio

grep -RIn "DeadlineMS" -n internal/grid/muxserver.go | head -n 120
```


## 4) 跟 Healing / Scanner / Rebalance 的關聯（你要寫 incident note 的那句話）

當你同時間看到：
- healing/MRF/scanner 大量活躍
- 磁碟 latency 飆高（`iostat await`/`%util` 高）
- 或 goroutine dump 顯示很多 I/O/鎖等待

此時 grid 的 ping/pong handler 可能因為：
- peer goroutine 排隊（CPU 忙 / GC / goroutine 量爆）
- I/O latency 放大（rename/fsync/metadata ops）
- 網路抖動（但不是唯一可能）

而「沒有在時間窗內回 ping/pong」，最後被 watchdog 判定為 dead。

建議在 incident note 用這句：
> `canceling remote connection` 多半是「背景 I/O/排程壓力造成 ping/pong 延遲」的結果訊號；要確認根因，需把同時間窗的 healing/scanner 任務量、磁碟 latency、以及 grid stream 數量一起對齊。


## 5) 下一步：現場快速驗證清單（最省時間）

1) 抓同一時間窗的 goroutine dump（或 pprof）
   - 確認是否大量卡在 `xlStorage.RenameData` / `renameData` / `healObject` / `grid`。
2) 同步看 `iostat -x 1` / `pidstat -d 1`（若可）
   - 看 await/%util 是否尖峰對齊 disconnect。
3) 若要確認 syscall latency：短時間 `strace -fp <pid> -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,unlink,openat`。

（如果你的環境有多網卡/overlay/MTU 變更，也要把 MTU/丟包/重傳一起排查，但別一開始就把它當成唯一解釋。）

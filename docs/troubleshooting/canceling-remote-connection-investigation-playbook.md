# Troubleshooting：`canceling remote connection` 調查 Playbook（把錯誤訊息補成可排查筆記）

> 目標：當你在 MinIO log 看到 `canceling remote connection ... not seen for ...`（或相關 `grid: ErrDisconnected` / peer REST timeout）時，能用一個固定流程快速判斷：
> - 這是「網路先壞」？還是「節點忙到 ping handler 排不到」？
> - 跟 PutObject / Healing / scanner / rebalance 的 I/O 尖峰是否同一時間窗？
> - 需要收哪些證據，才能在 postmortem 裡把根因講清楚？

本頁搭配：
- `docs/trace/putobject-healing-callchain.md`
- `docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`
- `docs/troubleshooting/canceling-remote-connection.md`（總覽）
- `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`

---

## 0) 先定義「這句 log」的精準位置（避免語意漂移）

你要先釘死它不是泛用的 net/http error，而是 internal/grid 的 mux watchdog。

在本 workspace 版本（MinIO `b413ff9fd`）：
- `internal/grid/muxserver.go:checkRemoteAlive()` 會印：
  - `canceling remote connection %s not seen for %v`
- ping interval：`internal/grid/grid.go: clientPingInterval = 15s`
- server threshold：`internal/grid/muxserver.go: lastPingThreshold = 4 * clientPingInterval`（~60s）

快速自證：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "clientPingInterval" -n internal/grid/grid.go

grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go
```

---

## 1) 快速分類：看「先出現的是哪個症狀」

### A. 先看到 server 端 `canceling remote connection ... not seen for ~60s`
典型代表：server 覺得「remote 沒 ping 過來」。

最常見的兩大類：
1) **remote 真的掛/網路不通**（NIC/交換器/路由/MTU/封包丟失）
2) **remote 太忙**，ping goroutine 跑不動（I/O tail latency、GC、CPU steal、mutex/namespace lock 卡住）

### B. 先看到 client 端 `ErrDisconnected` / timeout / peer RPC fail
典型代表：client 端覺得「pong 沒回來」或 connection 被 reset。

這種情況要特別小心：
- 很多現場會先在 caller 看到 `ErrDisconnected`，過一會兒才在 server 看到 `canceling remote connection`。
- 這不代表 server 是根因；可能只是兩端 watchdog 的時序不同。

---

## 2) 立刻做的三件事（同一時間窗的證據）

> 你只要固定抓到這三組證據，後續幾乎都能把故事講完整。

### 2.1 對齊時間窗：log 取樣（前後各 5–10 分鐘）

- 把出現 `canceling remote connection` 的時間點記下來（精準到秒）。
- 同時抓：
  - healing/scanner/MRF 相關 log（有沒有爆量）
  - PutObject latency（p95/p99）/ 4xx/5xx spike

### 2.2 立即抓 goroutine dump（SIGQUIT）

目的：判斷當下卡在哪一層（grid / object layer / storage rename/fsync）。

建議手法：見 `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`。

你在 dump 裡最想看到的關鍵字：
- `internal/grid`（ping/pong/handler backlog）
- `(*erasureObjects).putObject` / `renameData` / `(*xlStorage).RenameData`
- `(*erasureObjects).healObject` / `readAllFileInfo`

### 2.3 抓 I/O 與排程證據（最省事的一組）

在出事時間窗：
- `iostat -x 1`（看 await/%util）
- `pidstat -dru 1 -p <pid>`（看 I/O、CPU、context switch）
- （容器/VM）看 CPU steal / throttling

判讀重點：
- 如果磁碟 await 飆高、%util 長時間 100%，同時間出現 grid 斷線：更像「I/O 壓力 → ping handler 延遲 → watchdog 斷線」。
- 如果 I/O 很正常但大量斷線：才更像網路層優先。

---

## 3) 最常見的「共振場景」：PutObject + Healing 壓力窗

現場最常見的故事線其實是：
1) PutObject（或 rename/fsync）尾端變慢（metadata ops / disk tail latency）
2) 同時間 MRF/scanner/heal 放大（補洞/重建）
3) peer REST/grid streaming mux 長連線變多、handler 排隊
4) grid watchdog 判定 ping/pong 太久沒更新 → `canceling remote connection`

把 call chain 貼進 incident note 時，建議用：
- `docs/trace/putobject-healing-callchain.md`
- `docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`

---

## 4) 停損：什麼時候你該停止追「grid 本身」？

如果你已經拿到以下證據，就應該把重心移到「I/O/rename/fsync/掃描任務」而不是繼續抓網路：
- goroutine dump 顯示大量卡在 `RenameData` / `fsync` / `write` / `readAllFileInfo`
- iostat 顯示磁碟 await 飆高或 %util 打滿
- healing/MRF 的速率在同時間窗異常上升

反之，若：
- iostat 正常、CPU 正常
- 但同時多節點互斷、且集中在特定網段/交換器

才更像網路/基礎設施層要先查。

---

## 5) 事件筆記模板（你可以直接貼到 postmortem）

- **Symptom**：`canceling remote connection <peer> not seen for ~60s`（頻率、影響範圍）
- **Time window**：YYYY-MM-DD HH:MM:SS ± 10m
- **Co-occurring signals**：
  - PutObject p99：
  - Healing/MRF/scanner rate：
  - Disk iostat await/%util：
- **Evidence**：
  - goroutine dump：主要 stack top-N（是否卡在 RenameData/healObject/grid handler）
  - （可選）pprof goroutine/profile：
- **Most likely root cause**（先寫假設，標註信心）：
  - Hypothesis A：I/O tail latency → ping handler 延遲 → grid watchdog disconnect
  - Hypothesis B：network packet loss/MTU → ping/pong 丟包
- **Next actions**：
  - 降低 healing concurrency / 排程錯峰
  - 針對 rename/fsync 做檔案系統/磁碟調校或升級
  - 若疑似網路：抓 tcpdump / switch counters

---

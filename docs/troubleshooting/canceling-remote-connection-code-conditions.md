# Troubleshooting：`canceling remote connection`（從錯誤訊息精準對回 code 判斷條件）

> 目的：不要只停在「network/IO/CPU 可能有問題」這種泛論；把 `canceling remote connection` 這句 log **對回 internal/grid 的哪段 watchdog**，並整理出你要驗證的「時間條件/欄位」與現場可觀測指標。
>
> 適用情境：
> - PutObject 尖峰（尤其 rename/fsync tail latency）
> - Healing/MRF/scanner 併發升高
> - 節點 CPU starvation / GC pause / syscalls 卡住
> - inter-node RTT 偶發飆高（但更常見是 *本機忙到 ping/pong handler 沒被排程*）

相關頁：
- Trace：PutObject/Healing 呼叫鏈（對齊 rename/fsync 熱點）：`docs/trace/putobject-healing-actual-callchain-map.md`
- Troubleshooting：快速 triage：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- Trace：grid 方向的 anchors：`docs/trace/grid-canceling-remote-connection.md`

---

## 1) 先把 log 釘到「是哪個檔案、哪個 goroutine 在 cancel」

在不同 MinIO 版本裡，log 的位置可能會在：
- `internal/grid/muxserver.go`
- `internal/grid/muxclient.go`

最短定位：
```bash
cd /path/to/minio
rg -n "canceling remote connection" internal/grid
```

你要看的不是 log 本身，而是 **同一個函式的上游判斷**：
- interval / deadline / timeout 設定
- alive 判斷用到的欄位（lastPing/lastPong/lastRead/lastWrite/lastMsg…）
- 觸發 cancel 的動作：`Close()` / `cancel()` / `context.CancelFunc` / stream teardown

建議同檔案連續追：
```bash
cd /path/to/minio
rg -n "checkRemoteAlive|keepalive|heartbeat|ping|pong|deadline|timeout" internal/grid/muxserver.go internal/grid/muxclient.go
rg -n "last(Ping|Pong|Read|Write|Msg)|time\.Since\(|time\.Now\(\)" internal/grid/muxserver.go internal/grid/muxclient.go
rg -n "Cancel\(|cancel\(|Close\(|close\(" internal/grid/muxserver.go internal/grid/muxclient.go
```

---

## 2) 典型觸發模型（你在 code 會看到的「時間條件」）

### A) ping/pong（或 keepalive）逾時
常見形式（概念上）：
- `time.Since(lastPong) > deadline` → 判定 remote 不健康 → cancel

你要回答的核心問題：
- `lastPong`（或等價欄位）是由哪個 handler 更新？
- 該 handler 是否可能因為 CPU starvation / goroutine 無法排程而延遲？

現場對應觀測：
- 節點 `loadavg`、`run queue`、`GOMAXPROCS` 是否過小、是否在 GC/alloc 壓力
- `pprof/goroutine` 是否大量卡在：`fsync`/`renameat2`/`pwrite`/`futex`/`epoll_wait`

### B) 長時間沒有任何讀寫（lastRead/lastWrite/lastMsg 逾時）
常見形式（概念上）：
- `time.Since(lastRead)` 或 `time.Since(lastWrite)` 超過門檻

你要回答的核心問題：
- 這個 last* 是在 *conn-level* 更新，還是 *stream-level* 更新？
- 是真的 network 斷了，還是「程式忙到沒機會 read/write」？

現場對應觀測：
- node 的 `iostat -x`（await/util）、fsync/rename tail
- NIC 丟包/重傳（但在很多案例其實是 local stall）

---

## 3) 為什麼它常跟 PutObject / Healing 一起出現（不是巧合）

這句 log 很常是 *症狀放大器*：
- PutObject：`rename/fsync/commit` tail latency → goroutine 堆積 → ping/pong handler 排程延遲 → grid watchdog 誤判連線不健康
- Healing：同樣會造成大量 disk I/O + CPU（reconstruct/encode）→ tail latency 放大 → keepalive 逾時

快速把「PutObject/Healing 是否為根因」釘死：
```bash
# 看到 canceling remote connection 的同一時間窗，去看：
# - rename/fsync 是否爆量
# - healing/MRF 併發是否上升
# - iowait 是否飆高
# - pprof 是否卡在 erasure put/heal 的 I/O 段
```

---

## 4) 實務排查：用 3 個問題逼近根因

1) **是 server cancel 還是 client cancel？**
   - 用 `rg` 定位 log 在 muxserver/muxclient，先判定是哪一邊先做 teardown。

2) **它看的健康條件是哪一個 last*？**
   - 把判斷式中的欄位找出來（lastPong/lastRead/lastWrite/…）。
   - 再往下追：這個欄位在哪裡被更新？是否依賴某個 goroutine 的排程？

3) **是 network 問題，還是 local stall 造成 keepalive 不動？**
   - 如果同時間 iowait/rename/fsync tail 上升 → 多半是 local stall。
   - 如果 local 都正常但 RTT/重傳明顯上升 → 再回頭查 network。

---

## 5) 你可以把這頁當成「補齊筆記的模板」

每次遇到新版本/新 fork：
1) 把 `internal/grid/*` 內對應 log 的「函式名」填進來
2) 把 alive 判斷用到的欄位列出來
3) 把 interval/deadline 的來源（常數/設定值/環境變數）記下來
4) 追加你當次 incident 的觀測：iostat/pprof/strace/metrics

這樣下一次再看到同一句 log，你就能 3 分鐘內把問題收斂到「特定 watchdog + 具體時間條件 + 可能被什麼 stall 影響」。

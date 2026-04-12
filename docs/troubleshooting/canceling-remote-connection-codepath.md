# Troubleshooting：`canceling remote connection` 對應到 MinIO `internal/grid` 的哪條 code path？

> 目的：把你在 log 裡看到的 `canceling remote connection ... not seen for ...` 這句，直接釘到 MinIO source 的 **檔案/函式/變數**，並整理出「你要怎麼在現場證明是哪一端沒更新 ping/pong」。
>
> 這頁刻意偏「讀碼錨點 + 現場驗證」；更完整的事件處置流程請看：
> - `docs/troubleshooting/canceling-remote-connection.md`

---

## 1) 這句 log 通常是 **server 端 mux watchdog** 印的

你在 server log 看到類似：

- `canceling remote connection <node> not seen for 1m0s`

多數版本是 `internal/grid/muxserver.go` 內的 watchdog（函式名常見是 `checkRemoteAlive` 或類似）判斷：
- `time.Since(lastPing) > lastPingThreshold` → 關閉 mux/connection → 印 log。

### 一鍵 grep（不要靠行號）

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 80
```

---

## 2) `~60s` 是怎麼來的？（`clientPingInterval` × N）

常見版本的計算邏輯是：
- `clientPingInterval = 15s`
- server 判斷門檻：`lastPingThreshold = 4 * clientPingInterval`（≈ 60s）

```bash
cd /path/to/minio

grep -RIn "clientPingInterval" -n internal/grid | head -n 50

grep -RIn "lastPingThreshold" -n internal/grid | head -n 80
```

> 實務判讀：當你看到「很像固定 60s」的斷線，很常是 **mux watchdog**，不是應用層 request deadline。

---

## 3) `LastPing` / `LastPong`：你要分清楚是哪個沒有更新

### 3.1 server 端：`LastPing`（server 收到 client ping 才會更新）

```bash
cd /path/to/minio

grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 120

grep -RIn "ping\(" -n internal/grid/muxserver.go | head -n 120
```

若 server 忙到 ping handler 跑不動（排程/GC/I/O 卡住），`LastPing` 也會延遲更新 → 最終觸發 `canceling remote connection`。

### 3.2 client 端：`LastPong`（client 收到 server pong 才會更新）

很多現場會先看到 client 端報 `ErrDisconnected`，然後 server 端才印 `canceling remote connection`。常見原因是：
- client 的容忍時間通常較短（例如 `clientPingInterval*2` ≈ 30s）
- server 要到 `lastPingThreshold`（≈ 60s）才會印這句

```bash
cd /path/to/minio

grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 120

grep -RIn "ErrDisconnected" -n internal/grid/muxclient.go internal/grid/connection.go | head -n 120
```

---

## 4) 為什麼你會在 healing/scanner 很忙的同一時間窗看到它？

`internal/grid` 這層通常承載 peer RPC（Peer REST / background tasks）。當 healing/scanner/MRF/rebalance 放大時，兩個常見路徑會讓 mux 更容易被 watchdog 打到：

1) **CPU/排程壓力**：ping handler 沒被排到（goroutine 長時間搶不到時間片）
2) **I/O/鎖壓力**：peer handler 在做大量 metadata / rename / fsync，導致整體延遲擴散

你可以用這幾個方向去「證明」不是純網路：
- 同時間 `PutObject` latency 拉長、或磁碟 latency 飆高
- healing/MRF/scanner 指標/trace 明顯變活躍
- pprof 看得到大量時間在 syscall / fsync / rename / mutex contention

（PutObject ↔ MRF ↔ HealObject 的呼叫鏈，見：`docs/trace/putobject-healing-callchain.md`。）

---

## 5) 現場快速結論模板（寫 incident note 用）

> 我們看到 `canceling remote connection`，對應到 MinIO `internal/grid` 的 mux watchdog（server 端基於 `LastPing` 超過 `lastPingThreshold` 斷線，常見為 `15s*4≈60s`）。
> 同時間窗 PutObject/MRF/Healing 活躍與 I/O 壓力上升，推測主要是資源壓力（排程/I/O）造成 ping handler 延遲，而非單純網路斷線；後續以網路 counters + pprof + disk latency 交叉驗證。

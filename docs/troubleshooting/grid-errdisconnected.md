# Error: grid ErrDisconnected（MinIO internal/grid 斷線：語意、來源、排查）

> 這頁整理 MinIO `internal/grid` 常見的 **`ErrDisconnected`**（或 log/trace 裡的 disconnected 類訊息）如何出現、代表什麼、以及你在 incident 當下最省時間的排查順序。
>
> 這個錯誤通常不是 S3 client 的錯誤本體，而是 **MinIO node-to-node（grid）內部 RPC/streaming mux** 的自我保護：偵測到心跳/回應超時後，主動關閉該 mux 或 connection。

---

## 1) 語意（你應該怎麼翻譯它）

當你看到 `ErrDisconnected`（或等價的 disconnected/connection closed 訊息）時，可以先把它翻譯成：

- 「這條 grid 的 streaming mux / connection 在一定時間內收不到對端回應（pong / ping），因此主動斷線。」

它常見的兩種根因大方向：
1) **網路層**：丟包、retrans/RTO、conntrack/NAT/MTU、或中間設備 idle timeout
2) **對端忙/卡住**：I/O latency、CPU 飽和、GC/排程延遲、背景任務（healing/scanner/rebalance/MRF）把 handler 壓到跑不動

---

## 2) Source code anchors（把「誰在判定超時」釘死）

> 以 upstream `master` 檔名/函式名做索引（行號會飄）。

### 2.1 client 端：多久沒收到 pong 會回 `ErrDisconnected`？（常見：~30s）

- 檔案：`minio/internal/grid/muxclient.go`
- 邏輯：client 端會週期性送 ping；若 `LastPong` 在一定時間內沒有更新，會回 `ErrDisconnected` 並關閉該 mux。

常見關鍵常數：
- `clientPingInterval = 15 * time.Second`（`minio/internal/grid/grid.go`）
- client 端常見判定：`clientPingInterval*2`（約 30s）沒 pong → disconnect

快速定位（在你的 MinIO source tree）：
```bash
cd /path/to/minio

grep -RIn "clientPingInterval" internal/grid/grid.go internal/grid/*.go

grep -RIn "LastPong" internal/grid/muxclient.go

grep -RIn "ErrDisconnected" internal/grid
```

> 實務判讀：你可能會先看到 client 端 `ErrDisconnected`，但 server 端未必同時印 `canceling remote connection`（server watchdog 常見 threshold ~60s）。兩邊是不同的自我保護。

### 2.2 server 端：多久沒看到 ping 會印 `canceling remote connection`？（常見：~60s）

- 檔案：`minio/internal/grid/muxserver.go`
- `lastPingThreshold = 4 * clientPingInterval`（約 60s）
- `(*muxServer).checkRemoteAlive()` 會用 `LastPing` 判定是否該 `close()`

對照筆記：
- `ErrDisconnected`（client 自己放棄）常見 ~30s
- `canceling remote connection`（server watchdog）常見 ~60s

建議你把兩邊 anchor 都釘死（避免版本差異）：
```bash
cd /path/to/minio

grep -RIn "ErrDisconnected" -n internal/grid | head
grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive" -n internal/grid/muxserver.go
grep -RIn "clientPingInterval" -n internal/grid/grid.go internal/grid/*.go
```

延伸閱讀（同 repo）：
- `docs/troubleshooting/canceling-remote-connection.md`（server 端 watchdog：60s 沒看到 ping 會 cancel）

---

## 3) 10 分鐘排查 SOP（最省時間的順序）

> 目標：快速判斷偏「網路」還是偏「對端忙/資源壓力」。

### Step A：固定關聯鍵（同一時間窗 T±5m）
- `local->remote`（哪一對 endpoints）
- `duration`（大概多久沒 pong/ping）
- 是否同時伴隨：healing/scanner/rebalance/MRF、PutObject latency 變差

### Step B：先做 TCP 層 sanity（偏網路）
在出問題的節點上：
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
nstat -az | egrep 'TcpRetransSegs|TcpTimeouts' || true
```
判讀：retrans/RTO 明顯上升 → 優先查網路/MTU/conntrack。

### Step C：看遠端 I/O latency（偏對端忙）
在 remote 節點：
```bash
iostat -x 1 3
```
判讀：`await/%util` 高 → 很常是 I/O 壓力把 grid handler 拖慢。

### Step D：對齊 MinIO 背景任務（最常見共犯）
如果同時間窗看到 healing/scanner/rebalance/MRF 明顯活躍：
- 把 disconnected 視為「資源壓力的結果」
- 優先把瓶頸切到：
  - Healing：`readAllFileInfo()` / `erasure.Heal()` / `disk.RenameData()`
  - PutObject：`erasure.Encode()` / `renameData()` / `commitRenameDataDir()`

延伸閱讀（同 repo）：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/trace/healing.md`
- `docs/trace/putobject-healing.md`

---

## 4) incident note 建議模板（直接可貼）

```
Symptom: grid ErrDisconnected
Time window: T±5m
local->remote: A:9000 -> B:9000
Observed duration: ~30s (client) / ~60s (server watchdog)
Co-occurrence: [healing/scanner/rebalance/MRF?] [disk await/util?] [tcp retrans/rto?]
```

> 用意：讓後續你要關聯 log/trace/metrics 時，不會卡在「到底是哪一對 node 在斷」。

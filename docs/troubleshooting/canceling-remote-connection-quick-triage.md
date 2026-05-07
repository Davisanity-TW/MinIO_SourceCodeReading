# canceling remote connection：快速分流（網路 vs I/O/背景任務）

> 用途：你在現場只看到這句 log：
>
> `WARNING: canceling remote connection A:9000->B:9000 not seen for 1m2.3s`
>
> 想在 **10–15 分鐘內**先把方向分成「偏網路」或「偏對端忙（I/O/背景任務/GC）」。
>
> 更完整背景與 code anchors：
> - `docs/troubleshooting/canceling-remote-connection.md`
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`
>
> （補）若同時間窗也有 PutObject latency 變差、或 healing/scanner/MRF 明顯活躍，建議直接一起對照：`docs/trace/putobject-healing.md`（PutObject partial → MRF → HealObject → `RenameData()` 的 I/O 共振鏈）。

---

## 0) 先固定三個欄位（每次 incident 都照抄）
- **time window**：`T ± 5m`
- **local->remote**：`A:9000 -> B:9000`（A = 印 log 的節點；B = 被 cancel 的對端）
- **not seen for**：`~60s`（多數版本是 `lastPingThreshold = 4 * clientPingInterval = 4 * 15s`）

> 若 `not seen for` 明顯不是 ~60s：優先把 **時鐘/NTP 跳動** 納入排查（`time.Since(time.Unix(LastPing,0))` 會受系統時間回撥/校時影響）。

### 0.1（補）你看到的可能不只一種「斷線訊息」：先分清 client vs server

- **server log** 常見：`canceling remote connection ... not seen for ...`
  - 代表 server 端 watchdog 覺得 **LastPing** 沒更新（多數版本 ~60s）
- **client log/stack** 常見：`ErrDisconnected` / `context deadline exceeded` / `peer down`
  - 代表 client 端較短的容忍（常見 ~30s）先放棄

現場最省時間的作法：同一個時間窗在兩邊各 grep 一次，確認哪邊先發生：
```bash
# server 端（印 canceling 的那台）
grep -R "canceling remote connection" /var/log/minio* 2>/dev/null | tail -n 50

# client 端（發起 peer RPC 的那台；可能先看到 ErrDisconnected）
grep -R "ErrDisconnected" /var/log/minio* 2>/dev/null | tail -n 50
```

> 讀碼錨點請看：`docs/troubleshooting/canceling-remote-connection-codepath.md`（LastPing/LastPong/threshold）。

---

## 1) 10 分鐘三件套（最省時間、最常有效）

### 1.1 local 節點：看 TCP retrans/RTO（偏網路）
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```
- `retrans` / `rto` 明顯上升：偏 **網路/CNI/conntrack/MTU**

### 1.2 remote 節點：看磁碟 latency（偏 I/O/資源）
```bash
iostat -x 1 3
```
- `await` 高、`%util` 高：偏 **I/O 壓力**（常見共振：healing/scanner/MRF/rebalance）

### 1.2.1（新增）如果同一組 `A->B` 幾乎「每分鐘」都被 cancel：優先驗證是不是 ping handler 跑不動（而不是真掉包）
現場常見誤判是：看到 `not seen for ~60s` 就直覺當成網路問題。但其實 server 端的 LastPing 更新點在：
- `internal/grid/connection.go`：`case OpPing` → `handlePing(...)`
- `internal/grid/muxserver.go`：`(*muxServer).ping()` → `atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

如果 remote 節點在同時間窗有：
- healing/scanner/MRF 大量跑
- `iostat` await/%util 尖峰
- 或 CPU throttling / goroutine 爆量

那更可能是 **remote 忙到 ping handler 排不到**（LastPing 沒更新）→ watchdog 觸發 `checkRemoteAlive()`。

特別常見的「共振訊號」（有看到就把 I/O 排在網路前面查）：
- 同窗出現 `slow disk` / `iowait` 尖峰
- PutObject latency 變長、甚至開始堆 MRF/healing
- stack/pprof 看到大量 goroutine 卡在 `RenameData()`、`fsync`、`renameat2`、`readAllFileInfo()` 這類 I/O 端點

最便宜的「快速佐證」：對 remote 節點抓一次 goroutine dump（SIGQUIT），看是否大量卡在 `RenameData()`/`fsync`/`readAllFileInfo()`/`erasure.Heal()` 這類路徑（詳見：`canceling-remote-connection-sigquit-stackdump.md`）。

### 1.3 任一節點：看 MinIO internal trace 的 grid 熱點（偏「誰把 grid 拖慢」）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```
- `grid.*` duration 明顯拉長：偏 **對端忙/handler 排隊**（不是單純 TCP 立刻斷）

---

## 2) 判讀小抄（粗但很好用）
- **retrans/RTO 明顯**、但 remote I/O 不高 → 先查：MTU、CNI drop、conntrack、LB/中間設備 idle timeout
- **retrans 不高**，但 remote I/O 高、且同窗有 healing/scanner/MRF → 先查：healing 的 I/O 點（`erasure.Heal` / `RenameData`）、scanner、MRF queue
- 三個都不明顯 → 把 **NTP/時鐘跳動** 放回優先序（同窗是否有 chrony step/slew）

---

## 3) 最短「因果鏈」模板（incident note 可直接貼）
> 同時間窗（T±5m）觀察到：healing/scanner/MRF 活躍 + disk await/%util 尖峰；推測 I/O/排程壓力導致 grid streaming mux 心跳（LastPing）更新延遲，觸發 `checkRemoteAlive()` 印出 `canceling remote connection ... not seen for ~60s`。

對照讀碼：
- `internal/grid/muxserver.go: (*muxServer).checkRemoteAlive()`
- `cmd/erasure-healing.go: (*erasureObjects).healObject()`（`erasure.Heal` + `RenameData`）
- `cmd/mrf.go: (*mrfState).healRoutine()`（若是 PutObject partial → MRF）

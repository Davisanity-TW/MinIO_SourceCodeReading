# Error: canceling remote connection（可能原因與排查方向）

> 這個訊息不是 S3 client 端的錯誤本體，而是 **MinIO server 內部的 inter-node RPC（grid）** 在判定「對端連線不健康」時，主動切斷遠端連線的 log。

## 0.5) 常見 log 長相（先把 local/remote 看懂）
你通常會看到類似：
```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```
- `10.0.0.10:9000` 是 **local（印 log 的這台）**
- `10.0.0.11:9000` 是 **remote（被判定看不到 ping 的對端）**

因此排查時請先把「哪一對 node」固定下來（local/remote），再去對照同時間窗 remote 的 I/O/CPU/GC/healing/rebalance/scanner 狀態。

---

## 1) 這個錯誤在哪裡出現？（Source code）
在你目前的 MinIO source tree（workspace：`/home/ubuntu/clawd/minio`）中，字串出現在：

- `minio/internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`（本機 workspace commit `b413ff9fd`：`muxserver.go:236`）
  - log 字串本體：`muxserver.go:246`

對應邏輯（節錄）：
```go
last := time.Since(time.Unix(atomic.LoadInt64(&m.LastPing), 0))
if last > lastPingThreshold {
    gridLogIf(m.ctx, fmt.Errorf("canceling remote connection %s not seen for %v", m.parent, last))
    m.close()
    return
}
```

其中：
- `clientPingInterval = 15s`（`minio/internal/grid/grid.go:58`）
- `lastPingThreshold = 4 * clientPingInterval`（`minio/internal/grid/muxserver.go:31`）
  - 也就是 **~60 秒沒看到 ping**，server 端就會判定 remote 不健康並取消。

補充：這條 log 出現在 `muxserver.go`，代表它是針對 **streaming mux（MuxID != 0）** 的存活檢查（而不是單純整條 Connection 的 MuxID=0 ping/pong）。因此你在現場看到它大量出現時，常常不是「所有 RPC 都斷」而是「某些 streaming/長連線類的 grid traffic 心跳跟不上」。
- `defaultSingleRequestTimeout = time.Minute`（`minio/internal/grid/grid.go`）
  - 非 streaming 的單次 request（MuxID=0）如果 context 沒 deadline，會以這個 timeout 當預設。

> 備註：這些 interval/threshold 目前是 code 常數（不是 config 參數）。因此看到 `~60s not seen` 更應該把它當作「網路/資源讓心跳停掉」的症狀，而不是先想調參。

### 1.0.1（補）同時間窗若你也看到 Healing/MRF 很忙：先用行號把修復路徑定位起來
這個 grid log 本身不會說「上層是哪個功能在用這條 streaming mux」，但在現場最常見的共振來源是：**Healing / scanner / rebalance / MRF 補洞把 I/O/排程壓力拉高**，導致 ping handler 更新 `LastPing` 來不及。

以本 workspace 的 MinIO source tree（`/home/ubuntu/clawd/minio`）當下 checkout 直接 grep 到的入口位置（行號會隨版本漂移）：
- `cmd/erasure-server-pool.go:2319`：`(*erasureServerPools).HealObject(...)`
- `cmd/erasure-healing.go:242`：`(*erasureObjects).healObject(...)`（真正 RS rebuild + `RenameData()` 寫回）

快速重抓定位：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head
```

### 1.1 這條 log 是誰在檢查？（check loop）
同一個檔案 `minio/internal/grid/muxserver.go` 內，會有 `checkRemoteAlive()` 的週期性檢查邏輯：
- 讀 `muxServer.LastPing`
- 若超過 `lastPingThreshold` 就 `m.close()`（你看到的 log 就在這裡印出來）

### 1.2 `LastPing` 是什麼時候更新的？（你要知道「60 秒沒 ping」是卡在哪一邊）
`LastPing` 通常會在 grid 收到對端的 ping/pong 訊息時更新（也就是：**訊息有到、而且能被對端程式處理到更新 timestamp**）。

因此這條 log 的根因，常見不是「TCP 斷了」而是：
- 封包/訊息沒有到（網路、丟包、重傳、conntrack/NAT、中間設備 idle timeout）
- 或訊息到了，但對端 Go runtime / handler 被卡住（CPU 飽和、GC、I/O 延遲、背景任務把 goroutine 壓到排隊）

因此看到這條訊息時，你可以把它直覺翻譯成：
> 「server 端已經 ~60 秒沒收到（或沒能處理到）對端 ping，所以主動把這條 remote connection 砍掉」

---

## 2) 這代表什麼狀況？（語意）
**server 端「看不到對端的 ping」**。

這通常意味著：
- TCP 連線還沒立刻被 OS 回收（所以你看到的是「我主動 cancel」而不是 socket 立刻斷）
- 但應用層心跳已經停止（或心跳封包/訊息處理卡住）

---

## 2.5) 快速排查 SOP（先用 10 分鐘把方向定出來）
目標：判斷是 **(A) 網路/連線品質** 還是 **(B) 對端忙到心跳處理卡住**。

1) **確認錯誤發生的對端（remote）是誰**
- log 內 `%s` 是 `m.parent`（Connection 的字串化）。在目前版本：
  - `minio/internal/grid/connection.go`：
    - `func (c *Connection) String() string { return fmt.Sprintf("%s->%s", c.Local, c.Remote) }`
- 也就是你會看到類似：`10.0.0.10:9000->10.0.0.11:9000`。
  - 左邊是 **local**，右邊是 **remote**。

2) **看同時期是否有「資源壓力」跡象**（先挑最便宜的指標）
- CPU：load / steal（虛擬化環境很關鍵）
- Memory：是否頻繁 GC / OOM killer
- Disk：latency 飆高、queue depth 很高（metadata-heavy 時很常見）

3) **看 TCP 重傳/丟包（網路方向最直觀）**
- `ss -ti` 看該連線是否大量 retransmit / rto
- `mtr` 或 switch/host 的 error counter（如果你能看得到）

4) **對照當下是否有背景任務在跑**（容易造成 "對端忙"）
- healing / scanner / rebalance / replication
- 尤其是「大 bucket + 很多小檔」+ 「磁碟 latency 飆」時，grid ping 很容易受影響

> 經驗法則：如果同一時間也看到 request latency 變長、iowait 飆高、或 healing/rebalance 在跑，通常比「純網路抖動」更常見。

### 2.6) 建議你在事件/工單裡先記下的「最小資訊」（方便快速關聯）
- `local->remote` 的那一對 endpoint（直接從 log 抄）：例如 `10.0.0.10:9000->10.0.0.11:9000`
- 發生時間窗（至少 ±5 分鐘）
- 當下是否正在跑：healing / scanner / rebalance / replication（有的話附上 job/phase）
- 當下三個最便宜的系統指標：
  - `iostat -x 1 5`（await、util、queue depth）
  - `top`/`uptime`（load、CPU steal）
  - `ss -ti '( sport = :9000 or dport = :9000 )'`（retrans/rto）

這樣你後續要判斷是「網路」還是「對端忙到心跳處理不了」會快很多。

### 2.7) 如果你有 Prometheus：建議同步截圖/記錄的 metrics（超省時間）
`canceling remote connection` 很常是「資源壓力 → grid 心跳處理延遲」的結果；若你有 Prometheus，建議在同一時間窗把這幾類指標拉出來一起看：

- **Go runtime（判斷 GC/排程壓力）**
  - `go_gc_duration_seconds`（或 `go_gc_duration_seconds_sum/count`）
  - `go_goroutines`
  - `process_cpu_seconds_total`

- **MinIO healing / scanner / rebalance（判斷是否背景工作把 I/O 打滿）**
  - healing / scanner / rebalance 相關 counter/gauge（依你版本/暴露的 metrics 名稱不同）
  - 若你有 Loki/ELK，直接用 log 關聯 healing/scanner 的 phase 也可以

- **Node / disk I/O（判斷是否磁碟 latency 飆高）**
  - node exporter：`node_disk_io_time_seconds_total`、`node_disk_read_time_seconds_total`、`node_disk_write_time_seconds_total`、`node_disk_io_time_weighted_seconds_total`
  - `node_load1` / `node_cpu_seconds_total{mode="iowait"}`

> 重點不是 metric 名字要一模一樣，而是同時間窗能不能看到「GC/CPU」或「disk latency」的明顯尖峰；一旦對上了，通常就能把問題從『grid 斷線』快速收斂到『網路』或『資源/背景任務』。

---

## 2.8) 快速把這條 log 跟「MinIO 內部在忙什麼」對起來（更像筆記頁的用法）

這條 `canceling remote connection ... not seen for ...` 本身沒有印出「是哪個上層功能/哪個 subroute」在用這條 streaming mux，所以排查時更有效的作法是：

1) **先把 remote 節點固定下來**（從 log 的 `local->remote`），然後在同一時間窗（±5 分鐘）看 remote 節點是否正在跑這些容易把 I/O 打滿的背景工作：
- healing（含 MRF 補洞）
- scanner（data scanner / metacache scan）
- rebalance

2) **用「最短 call chain」把背景工作對回 source code**（方便你在腦中把現象跟實作連起來）：
- PutObject（寫入達 quorum 但有 disk offline）→ `erasureObjects.addPartial()` → `globalMRFState.addPartialOp(...)`（`cmd/erasure-object.go`）
- MRF 消費端補洞 → `mrfState.healRoutine()`（`cmd/mrf.go`）
- 真正 repair 會落到：`erasureServerPools.HealObject` → `erasureSets.HealObject` → `erasureObjects.healObject`（`cmd/erasure-healing.go`）

3) **若你同時間看到 healing/scanner 很忙**，通常要把瓶頸對準到「最可能造成 ping handler 排隊」的點，而不是只盯 grid：
- Healing：`readAllFileInfo(...)` / `erasure.Heal(...)` / `disk.RenameData(...)`（`cmd/erasure-healing.go`）
- PutObject：`erasure.Encode(...)` / `renameData(...)` / `commitRenameDataDir(...)`（`cmd/erasure-object.go`）

延伸閱讀（同 repo）：
- Trace：PutObject vs Healing：`docs/trace/putobject-healing.md`
- Healing 路徑追蹤：`docs/trace/healing.md`

---

## 2.9) 進階：如何用 pprof/trace 判斷「ping 沒更新」是卡在 CPU/GC 還是卡在 I/O

當你已經從同時間窗的指標懷疑是「對端忙到 ping handler 跑不動」，下一步最有效的是直接用 Go runtime 的觀察來驗證：

### A) goroutine profile：找大量卡在 disk / rename / metadata fan-out 的堆疊
在 remote 節點抓 goroutine profile（或用你現有的 profiling/diagnostics 流程），常見會看到堆疊集中在：
- Healing：`cmd/erasure-healing.go`
  - `readAllFileInfo(...)`（大量 fan-out 讀 `xl.meta`）
  - `erasure.Heal(...)`（重建階段，reader/writer 都可能被 I/O latency 卡住）
  - `disk.RenameData(...)` → `cmd/xl-storage.go`（寫回/rename）
- PutObject：`cmd/erasure-object.go`
  - `erasure.Encode(...)`（寫 `.minio.sys/tmp`）
  - `renameData(...)` / `commitRenameDataDir(...)`（切換新 DataDir）

如果 goroutine 大量堆在上述幾個點，同時間又出現 `canceling remote connection ... not seen for ...`，通常就能把根因更確定地歸因到「I/O 壓力 → runtime 排程延遲 → ping/pong 更新不及」。

### B) heap/GC：確認是不是 GC stop-the-world 造成心跳延遲
若同時間看到：
- `go_gc_duration_seconds` 尖峰
- `go_goroutines` 暴增
- 或 heap 快速膨脹

就要把 `canceling remote connection` 當成「GC/排程壓力的側寫」來看，而不是先怪網路。

> 提醒：這條 log 的判定依據是 `muxServer.LastPing`（`minio/internal/grid/muxserver.go`），所以只要 ping 訊息「沒進到更新 timestamp 的那行」就會中槍；原因可以是封包沒到，也可以是 handler 排隊太久。

## 3) 最常見原因（按發生機率排序）

### A) 網路抖動 / 封包丟失 / 連線不穩
- Node 之間的延遲/丟包導致 ping/pong 無法在 ~60 秒內到達。
- 常見於：跨 AZ/跨機房、overlay network（VXLAN）、iptables/conntrack 壓力、MTU 不一致。

**排查：**
- node-to-node latency（ICMP 只能初步）
- TCP 層：`mtr`、`ss -ti` 看 retransmits
- K8s：檢查 CNI/MTU（Calico/Cilium/Flannel）

### B) 對端忙到「處理不了 ping」：GC stop-the-world、CPU 飽和、I/O 卡住
即使網路正常，只要對端 goroutine/事件迴圈被卡住，`LastPing` 也不會更新。

**典型觸發：**
- 背景任務（healing、rebalance、scanner）
- 大量小檔/高 metadata 壓力
- 單一節點磁碟 latency 飆高導致整體 handler 卡住

**排查：**
- 節點 CPU steal、load、GC（Go runtime 指標）
- 磁碟延遲：iostat / nvme smart / dmesg
- MinIO trace/pprof（若你有開）

### C) 時鐘跳動（NTP 漂移 / 時間回撥）
`time.Since(time.Unix(LastPing, 0))` 會受系統時間影響。
如果節點時間被大幅調整，可能造成「突然看起來很久沒 ping」。

**排查：**
- chrony/ntpd 狀態
- `timedatectl` / `chronyc tracking`

### D) Inter-node connection 被中間設備重置/閒置回收
例如 LB、NAT、Firewall 對 idle connection 的 timeout 比 MinIO 的 ping 機制更短/更奇怪。

**排查：**
- 中間設備 idle timeout
- conntrack 表是否滿

---

## 4) 你可以怎麼把問題「落到具體模組」？
這個 log 只告訴你「remote connection 被 cancel」，但沒有直接告訴你是哪個上層功能在用 grid。

落地方式通常是：
- 先靠 `local->remote` 把「哪兩個節點」定位出來
- 再對照同一時間點：該 remote 節點是否正在做 healing/scanner/rebalance/replication
- 必要時用 debug/trace/pprof 佐證「是網路」還是「是對端忙」

補充：grid 本身有 "subroute" 機制（`internal/grid/handlers.go`: `setSubroute()` / `GetSubroute()`），但目前這條 `canceling remote connection ...` log **沒有把 subroute 印出來**，所以只能從外部線索推回去。

### 4.1) 讓排查更快的「落地技巧」：同時 grep remote 相關 log
因為這條 log 本身資訊有限，實務上我會用 `local->remote` 的 **remote IP:port**，在同一時間窗做二次過濾：

- 在 remote 節點找：
  - 是否同時間有 disk error / I/O timeout / rebalance/healing/scanner 相關 log
  - 是否有 Go runtime/GC 壓力跡象（例如突然大量 `gc` / heap 變化，或 OOM）
- 在 local 節點找：
  - 是否同時間有同一個 remote 的 `grid` 相關 error（例如 connect retry / timeout）

如果你有集中式 log（Loki/ELK），這招通常比只盯著單一訊息快很多。

### 4.2) 版本差異提醒：不同 RELEASE tag 字串/閾值可能不同
本頁以你 workspace 的 source tree（`/home/ubuntu/clawd/minio`）為準；若你要對照線上 `RELEASE.*` 版本：
- 先用 `grep -RIn "canceling remote connection" internal/grid`
- 再確認 `clientPingInterval` 與 `lastPingThreshold` 的定義位置與數值

> 目的：避免你在 master 看到 ~60s，但線上版本其實是不同倍數/不同 interval，導致誤判。

---

## 5) 實務建議（你要的是：如何降低發生率）
- 先把問題當成 **60 秒沒有心跳** → 90% 是「網路/資源」問題，而不是 PutObject 本身。
- 在 K8s 環境：先把 CNI/MTU/conntrack/節點 CPU steal/磁碟延遲做健康盤點。
- 若你有觀察到「某些時段（healing/rebalance）特別容易出現」：優先把那段背景任務的 I/O 與 CPU 限制做節流。

---

## 6) 快速把「grid 斷線」跟 PutObject/Healing 補洞串起來（MRF/HealObject 交叉驗證）

你如果同時在排：
- `canceling remote connection ... not seen for ...`
- PutObject latency 突然變差、或某些物件寫完後又被背景修復

通常可以用下面這個「最短鏈路」把現象串起來：

1) **先判斷是不是有「寫入成功但有洞」→ MRF 背景補洞**
- PutObject 端：`cmd/erasure-object.go`
  - `erasureObjects.putObject()` 後段可能呼叫 `er.addPartial(bucket, object, versionID)`
  - `addPartial()` 會把 `partialOperation` 丟進 `globalMRFState` queue
- MRF 消費端：`cmd/mrf.go: (*mrfState).healRoutine()`
  - 會對 bucket/object 呼叫 `healObject(...)`（本質上就是走 `HealObject` 的修復路徑）

2) **再確認 Healing 真的在跑**（你要的是「同時間窗」的證據）
- source chain（最穩）：`erasureServerPools.HealObject` → `erasureSets.HealObject` → `erasureObjects.HealObject` → `(*erasureObjects).healObject`
  - 位置：`cmd/erasure-server-pool.go` / `cmd/erasure-sets.go` / `cmd/erasure-healing.go`
- 若你有 trace：對照 `madmin.TraceHealing`（server 端會在 `cmd/erasure-healing.go` 的 `healTrace()` 產生事件）

3) **把瓶頸切到最有用的 3 個觀察點**（定位「為何 ping 跟不上」）
- PutObject：`erasure.Encode()` / `renameData()` / `commitRenameDataDir()`（`cmd/erasure-object.go`）
- Healing：`readAllFileInfo()` / `erasure.Heal()` / `disk.RenameData()`（`cmd/erasure-healing.go`）

> 這些點若在同一時間窗大量堆積，最常見的結果就是：I/O/GC/排程壓力上來 → grid ping/pong handler 延遲累積 → 最終印出 `canceling remote connection`。

（延伸閱讀：`docs/trace/putobject-healing.md` 把 PutObject ↔ Healing 的資料流/rename 寫回對照整理在一起。）

---

## 7) 對照其他 log/metric：把「這條 grid log」跟實際症狀串起來

因為 `canceling remote connection ... not seen for ...` 本身不會告訴你「是哪個功能在用這條 grid connection」，所以實務上建議用同時間點做關聯：

1) **同時間點是否有 Healing / Rebalance / Scanner 的紀錄**
- healing trace（若有訂閱）：`madmin.TraceHealing`（對應 server 端 `cmd/erasure-healing.go` 的 `healTrace()`）
- background healing：`cmd/background-heal-ops.go` / `cmd/background-newdisks-heal-ops.go`
- scanner：`cmd/data-scanner.go`

2) **同一對節點是否反覆出現（固定 remote）**
- 若固定是某一台 remote：優先懷疑該節點的 I/O 或 CPU/GC 壓力（「對端忙」）
- 若 remote 會漂移但同一個 rack / 同一個 switch：優先懷疑網路層（MTU、錯誤包、鏈路品質）

3) **如果是 K8s**：用 Pod/node 層事件對照
- node network drop / conntrack 壓力
- CNI（Calico/Cilium/Flannel）是否有 MTU mismatch
- 該時間點是否有 node reboot / kubelet hang / CPU steal 飆

> 簡單判斷：如果你同時間看到 S3 request latency 飆高、或者 healing/scanner 正在跑，這條 log 通常是「結果」（心跳跟不上），不是「根因」。

---

## Appendix：快速定位指令
在 MinIO source tree 內（不用 `rg`，用 GNU `grep` 即可）：
```bash
# 找到 log 出處
cd /home/ubuntu/clawd/minio
grep -RIn "canceling remote connection" internal/grid

# 找 ping interval / threshold
grep -RIn "clientPingInterval" internal/grid
grep -RIn "lastPingThreshold" internal/grid

# 看 Connection 的字串長什麼樣（local->remote）
grep -RIn "func (c \\*Connection) String" internal/grid
```

---

## Appendix B：用「系統層訊號」快速判斷是網路還是資源（更實務）

### B.1 先確認是不是 TCP 重傳（偏網路）
在 **local 與 remote 兩邊**都跑一下（抓你 log 中那對 IP/port）：
```bash
# 看是否有大量 retrans / rto
ss -ti '( sport = :9000 or dport = :9000 )' | head -n 80

# 也可以用 nstat 快速看 kernel 層 TCP 重傳統計
nstat -az | egrep 'TcpRetransSegs|TcpExtTCPSynRetrans|TcpTimeouts' || true
```
判讀：
- `retrans` 快速累積、或 RTO 很大 → 網路/封包丟失/MTU/中間設備 idle timeout 方向優先。

### B.2 看是不是 I/O 卡住（偏資源）
```bash
# iowait / queue depth / await
iostat -x 1 5

# 若是 nvme
nvme smart-log /dev/nvme0n1 2>/dev/null | head || true

# kernel 層錯誤
dmesg -T | egrep -i 'nvme|blk|reset|timeout|I/O error' | tail -n 50
```
判讀：
- `await`、`svctm` 飆高、或 dmesg 出現 timeout/reset → 對端可能忙到 ping handler 跑不動。

### B.3 K8s/CNI 環境的常見坑（MTU/conntrack）
```bash
# conntrack 壓力（若節點有裝）
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max 2>/dev/null || true

# 基本 MTU 檢查（實際要依 CNI/overlay）
ip link | egrep 'mtu|vxlan|cali|cilium|flannel' || true
```

> 經驗上：`canceling remote connection ... not seen for ~60s` 在大量 healing/scanner 或磁碟延遲飆高的時段更常發生；若同時看到 TCP retrans 明顯增加才優先懷疑網路。

---

## 6) 更深入：LastPing/LastPong 在哪裡更新？

### 6.1 server 端（muxServer.LastPing）
`canceling remote connection` 看的其實是 **muxServer.LastPing**，這個值是在 server 收到「這條 mux 的 ping」時更新：

- `minio/internal/grid/muxserver.go` → `func (m *muxServer) ping(seq uint32) pongMsg`

節錄：
```go
atomic.StoreInt64(&m.LastPing, time.Now().Unix())
```

對應呼叫鏈是：
- `Connection.handleMsg()` 收到 `OpPing` → `Connection.handlePing()`
- 若 `m.MuxID != 0` 且這是 streaming mux → `c.inStream.Load(m.MuxID)` 找到 mux → 呼叫 `muxServer.ping()`

### 6.2 client 端（muxClient.LastPong / Connection.LastPong）
client 端有兩層時間戳：

1) **Connection.LastPong**（MuxID=0 的 ping/pong，用來維持整條 connection 的健康狀態）
- `minio/internal/grid/connection.go` → `handlePong()`
  - `if m.MuxID == 0 { atomic.StoreInt64(&c.LastPong, time.Now().Unix()) }`

2) **muxClient.LastPong**（MuxID != 0 的 streaming mux 心跳）
- `minio/internal/grid/muxclient.go`
  - 在收到 response/pong 時：`atomic.StoreInt64(&m.LastPong, time.Now().Unix())`
  - 在 timer tick 時：若 `time.Since(LastPong) > clientPingInterval*2` → client 端也會判定 disconnect

> 換句話說：**server 端（~60s 沒看到 ping）**與 **client 端（~30s 沒看到 pong）**各自都有「自行判斷斷線」的邏輯。

---

## 7) 你問的「這條 log 常常跟什麼事情一起出現？」（快速關聯）

在我自己排查經驗裡，這條 `canceling remote connection ... not seen for ...` 很常在這些情境一起出現：

1) **Healing / Scanner / Rebalance / MRF 補洞 高負載時段**
- 這些背景工作會把磁碟 I/O 拉滿，造成 request handler / grid handler 排隊變長。
- 特別是「PutObject 寫入當下有 disk offline，但 write quorum 仍達成」的情境，MinIO 會記錄 partial/MRF，後續由背景補洞機制持續補寫，等於把 I/O 壓力拉長。
  - `cmd/erasure-object.go`：`erasureObjects.addPartial()` → `globalMRFState.addPartialOp(partialOperation{...})`
  - `cmd/mrf.go`：`mrfState.healRoutine()` 消費 queue，對每筆 `partialOperation` 呼叫 `healObject(...)`
- 結果就是：即使網路沒斷，**對端 goroutine 處理 ping 來不及**，最後觸發 ~60s threshold。

你可以用這兩個方向對照：
- 看同時間是否有 healing trace：`madmin.TraceHealing`
- 或直接把「PutObject ↔ Healing」的資料流/rename 寫回理解清楚（見：`/trace/putobject-healing`）

2) **某一台 remote 固定反覆發生**
- 如果 log 幾乎都指向同一台 remote（同一個 `local->remote`），優先懷疑：
  - 該 remote 的磁碟 latency / I/O timeout
  - CPU steal / GC 壓力
  - NIC/driver 層 error counter

3) **K8s + overlay network（MTU/conntrack）**
- 若 remote 漂移但集中在某個 rack/某條 overlay path：優先回頭檢查 MTU mismatch / conntrack 壓力。

> 小技巧：把這條 log 當成「症狀」而不是「根因」。根因 80% 會在同時間窗的 I/O/CPU/GC 或 healing/scanner/rebalance 的 log/metric 裡。

---

## 8) 進一步把 grid connection「對到是哪個上層功能」的實務手法

### 8.0.1 補：為什麼這條 log 常常看起來像「無緣無故斷線」？（streaming mux 的特性）
你看到的訊息是由 `minio/internal/grid/muxserver.go: (*muxServer).checkRemoteAlive()` 印出的，它監控的是 **MuxID != 0 的 streaming mux** 心跳（`muxServer.LastPing`）。

因此它的常見現象是：
- S3 API 可能還能跑（或至少不是同時全掛）
- 但某些「長連線/大量資料流」的內部 RPC（例如 healing/scanner/rebalance 的某些路徑）心跳更新更容易被 I/O/排程壓力拖慢

換句話說：這條 log 更像是「某類 background traffic 的 streaming connection 心跳跟不上」的症狀，而不一定代表整個 cluster 立刻 split-brain。

這條 `canceling remote connection ...` log 本身不會印 subroute / handler，所以只能用「間接證據」把它對回上層功能。下面是兩個最省時的方法：

### 8.0 先做一個「最便宜的」交叉驗證：是不是被 Healing/MRF/scanner 拉爆？

你只要能在同一時間窗（±5 分鐘）找到其中任一條證據，通常就足以把方向從「網路問題」轉成「資源/背景任務壓力」：

- **MRF queue 正在消費**（PutObject 成功但缺片 → 背景補洞）：
  - source chain：`cmd/erasure-object.go: er.addPartial()` → `cmd/mrf.go: (*mrfState).healRoutine()` → `HealObject()`
  - 實務做法：在集中式 log/節點 log 內 grep `mrf` / `partial` / `HealObject`（依你版本 log 文案不同）。

- **scanner 正在觸發 heal**：
  - `cmd/data-scanner.go: (*scannerItem).applyHealing()` 會在掃描到不一致時呼叫 `o.HealObject(...)`

- **background healing 正在跑（尤其新盤/回復事件）**：
  - `cmd/background-newdisks-heal-ops.go: monitorLocalDisksAndHeal()` → `healFreshDisk()`

- **磁碟 latency 指標同時尖峰**：
  - `iostat -x` 的 `await/util`、或 node exporter 的 `node_disk_io_time_weighted_seconds_total` 在同時間窗跳高

> 目的不是一次就找出根因，而是用便宜訊號把大方向定出來：
> - 如果「背景工作 + I/O latency」同時存在，你應該把 `canceling remote connection` 視為 *症狀*。
> - 如果同時間沒有背景工作且 TCP retrans 明顯上升，才優先往網路層追。

### 8.1 從 remote IP:port 反查同時間窗的「背景工作」
同一時間窗（±5 分鐘）在 remote 節點（或集中式 log）做關聯，最常見的三條線：
- **MRF 補洞**：`cmd/mrf.go`（`mrfState.healRoutine()`）
- **background healing**：`cmd/background-heal-ops.go` / `cmd/background-newdisks-heal-ops.go`
- **scanner**：`cmd/data-scanner.go`

只要你能把「remote 是哪台」對出來，通常比硬追 grid subroute 更快找到根因。

### 8.2 需要更精準時：從 source code 看 subroute 機制（但 log 沒直接印）
grid 的 subroute 機制在：
- `minio/internal/grid/handlers.go`：`setSubroute()` / `GetSubroute()`

但因為 `checkRemoteAlive()` 這條 log 沒帶 subroute，所以若你真的要精準到「是哪個功能佔用/卡住 ping」，通常需要：
- 同時間窗對照 **pprof/trace**（如果你有開），或
- 在你自己的 fork/測試環境把 `gridLogIf` 加上 subroute/handler 的額外資訊再重現（production 不建議直接改）。

---

## 2.7) 直接把「哪個功能」用到這條 grid 連線抓出來：用 `mc admin trace --type internal`

因為 `canceling remote connection ...` 只告訴你「某條 inter-node grid streaming mux 的 ping 沒跟上」，**不會告訴你上層是哪個功能在跑**。

在 MinIO 內部，grid 的 request/response 也會走 **internal trace**（`internal/grid/trace.go` 會把 handler 名稱組成 `grid.<HandlerID>` 送到 trace stream）。

你可以用這個方法把「同一時間窗到底是哪類 handler 在狂打」抓出來：

1) 在任一節點跑 trace（建議加時間窗、避免噴太多）：
```bash
# 觀察 60~120 秒就很有價值
mc admin trace --type internal --json <ALIAS> | jq -r 'select(.funcName|startswith("grid.")) | [.time,.nodeName,.funcName,.path,.error] | @tsv'
```

2) 對照 `canceling remote connection local->remote` 的那一對 endpoint：
- trace 事件的 `nodeName` 是 remote（對端）
- `funcName` 會長得像：`grid.<handler>`（例如 storage/peer/lock 相關 handler）

3) 如果你在同一時間窗看到：
- `grid.*` 的某一類 handler 大量出現、而且 duration 拉長
- 同時又有 `canceling remote connection ... not seen for ~60s`

通常可以收斂成兩種方向：
- **網路方向**：trace 的 handler 幾乎沒有進來（或 error 多為連線層），但仍大量 cancel → 更像 ping/pong 本身被丟包/中間設備斷線
- **資源方向（更常見）**：trace 顯示 handler 進來但 duration 飆高、error 少 → 更像對端忙到 handler / ping 更新 `LastPing` 來不及

> 小提醒：如果你看到 duration 尖峰集中在 heal/scanner/mrf 時段，請把它跟 `/trace/putobject-healing` 的 MRF/HealObject call chain 一起看，通常能更快定位「是 heal I/O 把節點拖慢」還是「純網路抖動」。

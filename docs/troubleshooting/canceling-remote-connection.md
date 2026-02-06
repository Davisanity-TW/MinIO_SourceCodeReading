# Error: canceling remote connection（可能原因與排查方向）

> 這個訊息不是 S3 client 端的錯誤本體，而是 **MinIO server 內部的 inter-node RPC（grid）** 在判定「對端連線不健康」時，主動切斷遠端連線的 log。

---

## 1) 這個錯誤在哪裡出現？（Source code）
在你目前的 MinIO source tree（workspace：`/home/ubuntu/clawd/minio`）中，字串出現在：

- `minio/internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`

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
- `clientPingInterval = 15s`（`minio/internal/grid/grid.go`）
- `lastPingThreshold = 4 * clientPingInterval`（`muxserver.go`）
  - 也就是 **~60 秒沒看到 ping**，server 端就會判定 remote 不健康並取消。

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

---

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

## 6) 對照其他 log/metric：把「這條 grid log」跟實際症狀串起來

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

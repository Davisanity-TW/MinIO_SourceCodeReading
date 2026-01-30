# Error: canceling remote connection（可能原因與排查方向）

> 這個訊息不是 S3 client 端的錯誤本體，而是 **MinIO server 內部的 inter-node RPC（grid）** 在判定「對端連線不健康」時，主動切斷遠端連線的 log。

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

## 2) 這代表什麼狀況？（語意）
**server 端「看不到對端的 ping」**。
這通常意味著：
- TCP 連線還沒立刻被 OS 回收（所以你看到的是「我主動 cancel」而不是 socket 立刻斷）
- 但應用層心跳已經停止（或心跳封包/訊息處理卡住）

## 3) 最常見原因（按發生機率排序）

### A) 網路抖動 / 封包丟失 / 連線不穩
- Node 之間的延遲/丟包導致 ping/pong 無法在 ~60 秒內到達。
- 常見於：跨 AZ/跨機房、overlay network（VXLAN）、iptables/conntrack 壓力、MTU 不一致。

**排查：**
- node-to-node ping/latency（ICMP 只能初步）
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

## 4) 你可以怎麼把問題「落到具體模組」？
這個 log 只告訴你「remote connection 被 cancel」，但沒有告訴你是哪個上層功能在用 grid。
下一步要做的是把 `m.parent`（Connection）對應的 remote 節點、subroute/handler 找出來。

建議你在 source 裡追：
- `internal/grid/connection.go`：Connection 建立、ping/pong、LastPing 更新點
- `internal/grid/muxclient.go`：client side ping/pong 與 disconnect 條件
- `setSubroute(ctx, ...)`：哪些服務在走哪條 subroute

> TODO：把「LastPing 是在哪裡被更新」的實際函式貼出來，這樣你就能反推：到底是 client 沒送、還是 server 沒收到/沒處理。

## 5) 實務建議（你要的是：如何降低發生率）
- 先把問題當成 **60 秒沒有心跳** → 90% 是「網路/資源」問題，而不是 PutObject 本身。
- 在 K8s 環境：先把 CNI/MTU/conntrack/節點 CPU steal/磁碟延遲做健康盤點。
- 若你有觀察到「某些時段（healing/rebalance）特別容易出現」：優先把那段背景任務的 I/O 與 CPU 限制做節流。

---

## Appendix：快速定位指令
在 MinIO source tree 內：
```bash
# 找到 log 出處
rg -n "canceling remote connection" internal/grid

# 找 ping interval / threshold
rg -n "clientPingInterval|lastPingThreshold" internal/grid
```


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


## 7) 如何把「哪個上層功能」對應到這條 grid mux？

目前這條 log 只印：`canceling remote connection %s not seen for %v`，其中 `%s` 是 `m.parent`（Connection 的字串化）。

要把它落到具體模組（例如 healing、rebalance、scanner、replication），建議沿著 **subroute/handler** 去追：
- `setSubroute(ctx, ...)`（server 端 newMuxStream 有把 subroute 塞進 ctx）
- 找看有哪些地方註冊 grid handler（通常在 `internal/grid` 的上層服務初始化）

> TODO：下一輪我會把「哪裡建立 grid Connection」與「subroute 值的來源」貼到這篇，這樣你看到 log 就能反推是哪一類 background job。

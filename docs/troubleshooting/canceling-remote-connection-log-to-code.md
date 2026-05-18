# Troubleshooting：`canceling remote connection`（log → code → 可操作排查）

> 目的：把你在 MinIO log 看到的
>
> ```
> canceling remote connection <peer> not seen for <duration>
> ```
>
> 這句話**精準對回程式碼位置**，並整理成一份「現場可操作」的排查 checklist。
>
> 版本基準：本文以 workspace `/home/ubuntu/clawd/minio`（目前 HEAD：`b413ff9fd`）為例；不同 RELEASE tag 檔案/行號可能漂移，但關鍵字穩定。

---

## 1) 這句 log 在哪裡印出來？

在 MinIO 的 **grid**（node-to-node RPC/mux）模組裡：

- 檔案：`internal/grid/muxserver.go`
- 函式：`func (m *muxServer) checkRemoteAlive()`
- 觸發條件：距離上次收到 ping 超過 `lastPingThreshold`

對應 code（關鍵片段）：

```go
last := time.Since(time.Unix(atomic.LoadInt64(&m.LastPing), 0))
if last > lastPingThreshold {
    gridLogIf(m.ctx, fmt.Errorf("canceling remote connection %s not seen for %v", m.parent, last))
    m.close()
    return
}
```

### `lastPingThreshold` 是多少？
同檔案上方常數：

- `const lastPingThreshold = 4 * clientPingInterval`

也就是：**連續 4 個 client ping interval 都沒看到 ping**，就會被視為 remote 不健康並主動斷線。

---

## 2) `LastPing` 什麼時候會更新？

同檔案：

- 函式：`func (m *muxServer) ping(seq uint32) pongMsg`
- 行為：收到 ping 之後會 `atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

關鍵片段：

```go
atomic.StoreInt64(&m.LastPing, time.Now().Unix())
```

直覺語意：
- 你看到 `not seen for ...` 並不是「一定是網路壞」。
- 它的本質是：**這個 mux 的 ping handler 沒能在 threshold 內被執行/更新**。

常見原因包含：
- 真的網路/連線中斷（packet loss、conntrack/NAT、MTU、TLS/keepalive 問題）
- **CPU/Go runtime 排程被壓住**（goroutine backlog、GC、cgroup throttling）
- **磁碟 I/O 壓力把整個 process 拖慢**（PutObject rename/fsync、Healing/MRF 重建與大量 rename）

> 這也解釋了為什麼在 PutObject/Healing 很熱的時段，`canceling remote connection` 往往會一起噴。

---

## 3) 現場排查：先把問題分類成「網路 vs. 負載導致 ping 來不及」

### A. 先看「同時間點」MinIO 在忙什麼
1) PutObject 熱點：client latency 是否同步上升？
2) Healing/MRF：是否同時在跑 background heal / MRF 補洞？
   - 參考：`docs/trace/healing.md`（含 MRF/scanner/admin 入口）
3) Disk 指標：await / util% 是否衝高？（尤其 metadata-heavy 的 rename/fsync）

如果你的觀測是「I/O/CPU 飆高 ↔ 這句 log 爆量」：
- 優先走 **資源瓶頸** 的排查路線（見 §4）。

如果你的觀測是「資源沒滿、但特定 node/特定 link 經常斷」：
- 優先走 **網路/連線** 的排查路線（見 §5）。

---

## 4) 資源瓶頸路線（最常見）：把時間花在最可能的 3 個 code 熱點

把 troubleshooting 釘到實際函式名（方便你做 pprof/trace/strace 對齊）：

1) **PutObject commit rename（tmp → 正式路徑）**
- `cmd/erasure-object.go`：`renameData(...)` / `commitRenameDataDir(...)`
- storage 落地：`cmd/xl-storage.go`：`(*xlStorage).RenameData(...)`

2) **Healing 的 RS 重建 + rename**
- `cmd/erasure-healing.go`：`erasure.Heal(...)` → `disk.RenameData(...)`

3) **Metadata fan-out（heal/讀取時常見）**
- `cmd/erasure-healing.go`：`readAllFileInfo(...)`（以及相關 quorum/pickValidFileInfo）

你要的結論通常是：
- 卡在 RS 重建（CPU/讀吞吐）？
- 還是卡在 rename/fsync（I/O latency、inode/dir lock、檔案系統/磁碟問題）？

---

## 5) 網路/連線路線：把「ping 真的沒到」證實出來

建議同時看：
- node-to-node 連線是否重建頻繁（conn reset / TLS 握手）
- 專注在**同一對 peer** 是否反覆出現（而不是全 mesh 平均出現）

常見檢查（依你的環境選用）：
- MTU / jumbo frame mismatch（跨交換器/overlay 特別常見）
- conntrack 表滿 / NAT timeout（K8s + NodePort/LoadBalancer/iptables 場景常見）
- NIC driver / bonding / dropped packets

> 但就算是網路因素，很多時候也是「高負載讓 keepalive/ping 的 jitter 被放大」，所以務必回頭對照同時間的 I/O/CPU。

---

## 6) 一鍵定位（在你對照的 MinIO source tree 直接 grep）

```bash
cd /home/ubuntu/clawd/minio

git rev-parse --short HEAD

# log 出處
grep -RIn "canceling remote connection" internal/grid/muxserver.go

# threshold 與 ping 更新點
grep -RIn "lastPingThreshold" internal/grid/muxserver.go
grep -RIn "atomic\.StoreInt64\(&m\.LastPing" internal/grid/muxserver.go
```

---

## 7) 本頁重點（你要記住的 1 句話）

`canceling remote connection ... not seen for ...` 是 **grid mux 的 ping 超時斷線**。

它可能是網路斷，但在 PutObject/Healing 熱的時段，更常見是：
> **I/O/CPU 壓力讓 ping handler 來不及更新 `LastPing`。**

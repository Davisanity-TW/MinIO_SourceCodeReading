# Error: canceling remote connection（可能原因與排查方向）

> 這個訊息不是 S3 client 端的錯誤本體，而是 **MinIO server 內部的 inter-node RPC（grid）** 在判定「對端連線不健康」時，主動切斷遠端連線的 log。

## Code anchors（先把「哪裡印的 / 看的是什麼 timestamp」釘死）
以 workspace 的 MinIO source tree（`/home/ubuntu/clawd/minio`）為準，這行 log 的最短關聯鏈是：

- **印 log / 判定超時**：`minio/internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`：`time.Since(time.Unix(LastPing,0)) > lastPingThreshold` → 印 `canceling remote connection ... not seen for ...` → `m.close()`
  - `lastPingThreshold = 4 * clientPingInterval`
- **clientPingInterval 的定義（因此 threshold 幾乎固定 ~60s）**：`minio/internal/grid/grid.go`
  - `clientPingInterval = 15 * time.Second`
  - 所以 `lastPingThreshold = 4 * 15s = 60s`
- **LastPing 更新點（server 收到 ping 時）**：
  - `minio/internal/grid/connection.go`：`(*Connection).handleMsg()` → `handlePing()`（case `OpPing`）
  - `minio/internal/grid/muxserver.go`：`(*muxServer).ping()` → `atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

> 判讀重點：這條 log 的語意是「server 端在 ~60s 內沒看到（或沒能處理到）remote 的 ping」；原因可能是封包沒到（網路）或 handler 跑不動（I/O/CPU/GC/背景任務）。

## TL;DR（10 分鐘內把方向定下來）

1) **先固定那一對節點**：把 log 裡的 `local->remote` 抄下來（誰印 log = local；被斷的是 remote）
2) **把方向先分成兩類**（最省時間）：
   - 看到明顯 TCP retrans/RTO（`ss -ti`）→ 優先懷疑 **網路/MTU/conntrack/中間設備 idle timeout**
   - 同時間 remote 節點 `iostat -x` 的 `await/%util` 飆高、或 healing/scanner/rebalance/MRF 很忙 → 優先懷疑 **資源壓力讓 ping handler 跑不動**
3) **需要落到是哪個 internal handler 在打爆 grid**：抓 60~120 秒 `mc admin trace --type internal`，先把 `grid.*` 事件的熱點列出來

### （新增）把 log 的 `remoteIP:9000` 對到 trace 的 `nodeName`（避免看 trace 看不懂是哪台）
`canceling remote connection` 的 log 會印出 `localIP:9000->remoteIP:9000`，但 `mc admin trace` 通常用的是 `nodeName`（節點名/端點字串），兩邊常常對不起來。

最省事的做法是：先用 `mc admin info --json` 把節點名與 endpoint 列出來，然後用 remote IP 反查。

```bash
# 列出所有節點的 endpoint（IP:PORT）與 node name
mc admin info --json <ALIAS> \
  | jq -r '.servers[] | [.endpoint,.addr,.hostname,.state] | @tsv'

# 你也可以直接 grep remoteIP
REMOTE_IP='10.0.0.11'
mc admin info --json <ALIAS> \
  | jq -r --arg ip "$REMOTE_IP" '.servers[] | select((.endpoint|tostring)|contains($ip) or (.addr|tostring)|contains($ip))
         | [.endpoint,.addr,.hostname,.state] | @tsv'
```

> 有了這張對照表，你在 trace 裡看到 `nodeName` 就能直接回填到 log 的 `local->remote`，關聯會快很多。

> 記得：這條 log 的語意是「server 端 ~60s 沒看到（或沒能處理到）remote 的 ping」，它通常是**結果**（網路或資源），不是根因本身。

### （新增）跟 PutObject/Healing 的常見共振：partial → MRF → HealObject → I/O 壓力 → grid ping 跟不上
如果你同一時間窗也看到：
- PutObject 成功回應（達到 quorum），但當下有部分 disks offline
- 接著 healing/scanner/MRF 明顯變忙（I/O 拉高）
- 然後開始出現 `canceling remote connection ... not seen for ~60s`

那常見因果鏈是：
1) `erasureObjects.putObject()` 在 `commitRenameDataDir()` 後偵測 offline disks → `er.addPartial(...)`
2) `globalMRFState.addPartialOp(...)` 把「待補洞」事件丟進 MRF queue
3) `mrfState.healRoutine()` 消費 queue → `HealObject()` → `(*erasureObjects).healObject()` 真的做 RS rebuild + `RenameData()` 寫回
4) 背景補洞把 I/O/排程壓力拉高，導致 grid streaming mux 的 `LastPing` 更新延遲 → 觸發這條 log

讀碼對照頁（同 repo）：
- `docs/trace/putobject-healing.md`
- `docs/troubleshooting/mrf-queue-drop.md`（MRF queue 滿時會 drop partial op，會影響「有洞是否一定會被補到」）

### （新增）把 log 直接跟「Healing/MRF 是否正在忙」對齊（不靠 Prometheus 也能做）
如果你只有節點 log（沒有 metrics/trace），仍然可以用同一時間窗做最基本的關聯：

- 在 **remote 節點**（被 cancel 的那台）先抓同時間窗是否有 healing/MRF/scanner 關鍵字：
  ```bash
  # systemd/journald
  journalctl -u minio -S "5 min ago" -U "5 min" \
    | egrep -i 'heal|healing|mrf|scanner|rebalance|disk.*offline|drive.*offline' \
    | tail -n 200
  
  # 若你是以 container logs 收集，等價地在你 log backend 以 remote node/pod 為條件查同樣關鍵字
  ```

- 如果同時間窗 **healing/MRF/scanner 明顯活躍**，請先把 `canceling remote connection` 視為「資源/I/O 壓力的結果」，下一步優先查 remote 的：
  - `iostat -x`（await/%util）
  - `dmesg`（I/O timeout/reset）
  - 是否有 `.healing.bin` 更新（auto drive healing）

- 如果同時間窗 **幾乎沒有任何背景任務線索**，但 `ss -ti` 看到 retrans/rto 上升，才更像是「網路/封包丟失/conntrack/MTU」方向。

## （補）把「你遇到的那行錯誤」立刻拆成可排查欄位（最推薦的 incident note 寫法）
把 log 原樣貼上，例如：
```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```
然後在同一段事件筆記裡固定記三個欄位（後面查 log/trace/metrics 都用它）：
- **time window**：`T ± 5m`
- **local->remote**：`10.0.0.10:9000 -> 10.0.0.11:9000`
- **not seen for**：`1m2.3s`（幾乎總是 ~60s，對應 `lastPingThreshold = 4*clientPingInterval`）

> 目的：把「看起來很抽象的一行 log」轉成可直接下指令/抓 trace 的 key（local/remote/time window）。

### （新增）最省事的「三件套」蒐證：網路 / I/O / internal trace（60–120s）
如果你只想用最少時間先把方向定出來，我建議同一時間窗直接拿到這三個資料：

1) local 節點：TCP retrans/RTO（抓是否像網路丟包）
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```

2) remote 節點：磁碟 latency（抓是否像 I/O 壓力把 ping handler 拖慢）
```bash
iostat -x 1 3
```

3) 叢集任一節點：internal trace（抓同時間窗最熱的 `grid.*` handler）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

判讀（很粗但很有效）：
- retrans 明顯上升 → 先偏網路
- retrans 不高，但 remote I/O 高、且 trace 顯示 `grid.*` duration 變長 → 先偏資源/背景任務

---

## （新增）先做 MinIO 內部自查：用 admin 指令確認是否「背景任務/資源壓力」共振

> 目的：這條 log 90% 時候只是「~60s 心跳沒更新」的結果。先用 MinIO 自己的 admin 面板把同時間窗的背景任務釘死，往往比一開始就懷疑網路更快收斂。

在同一時間窗（T±5m）建議至少做其中 1~2 個：

1) **看 healing / scanner / rebalance 是否正在跑**
- `mc admin heal <ALIAS> --json`（看是否有 active heal / 最近的 heal activity）
- `mc admin rebalance status <ALIAS> --json`（若版本支援）
- 若你有 Prometheus：同步看 healing/scanner 相關 metrics 是否在尖峰

2) **用 internal trace 抓 60~120 秒，確認同時間窗最熱的 grid handler**
（把「grid 斷線」落到「哪個模組在狂打/變慢」）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

3) **確認是不是剛好有 disk offline/online / healing tracker 更新**
- 在 remote 節點看 `.healing.bin`（若你正在做 auto drive healing）：`<drivePath>/.minio.sys/buckets/.healing.bin`
- 或從 log/metrics 找「drive offline/online」事件（同時間窗最有參考價值）

> 判讀：如果你在同時間窗看到 healing/scanner/rebalance 活躍 + I/O latency 尖峰（`iostat -x` 的 `await/%util`），那 `canceling remote connection` 幾乎可以先當成「資源壓力造成 ping handler 延遲」的側寫；下一步就該回頭把瓶頸切到 heal/scan 的 I/O 點，而不是只盯 grid。

## 補充：我在現場最常怎麼遇到它（把「錯誤訊息」變成可行動的線索）

這條 log 常見會跟下列訊息/現象一起出現（不一定每次都有，但很值得一起記在事件筆記裡）：
- `not seen for 1m...` 的時間幾乎固定落在 ~60s（= `4 * clientPingInterval`），代表是 **grid streaming mux 的 watchdog** 觸發，而不是 TCP 立刻斷線。
- 同時間 PutObject latency 變長、或 background 看到 healing/scanner/MRF 很忙（I/O/GC/排程壓力上來，ping handler 來不及更新 `LastPing`）。
- 或在 K8s/overlay 環境，偶發搭配 TCP retrans/RTO 上升（conntrack/MTU/中間設備 idle timeout）。

事件記錄建議多抄一行：把完整訊息中 `local->remote` 與 `not seen for ...` 的 duration 原樣貼上，後面做對照會快很多。

## 0.5) 常見 log 長相（先把 local/remote 看懂）
你通常會看到類似：
```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```
- `10.0.0.10:9000` 是 **local（印 log 的這台）**
- `10.0.0.11:9000` 是 **remote（被判定看不到 ping 的對端）**

因此排查時請先把「哪一對 node」固定下來（local/remote），再去對照同時間窗 remote 的 I/O/CPU/GC/healing/rebalance/scanner 狀態。

## 0.6) （補）先用一條命令把「誰跟誰斷」統計出來（縮小範圍）
如果你是用 systemd/journald 跑 MinIO（或有集中式 log），建議先把同一時間窗內最常出現的 `local->remote` 組合抓出來：

```bash
# 範例：抓最近 30 分鐘內的 canceling remote connection，依 endpoint 統計
journalctl -u minio -S "30 min ago" \
  | grep -F "canceling remote connection" \
  | sed -n 's/.*canceling remote connection \([^ ]*\) .*/\1/p' \
  | sort | uniq -c | sort -nr | head
```

目的：先確認是不是「固定某一台 remote」反覆出事（偏資源/I/O），還是「remote 漂移」更像網路/CNI/中間設備問題。

### 0.7) （補）事件筆記建議直接用這個模板（方便後續對齊 log/trace/metrics）
在工單/incident note 先記下：
- 事件時間窗：`T ± 5m`
- `local->remote`：`A:9000->B:9000`（直接從 log 抄）
- 是否同時有背景任務：healing / scanner / rebalance / replication（有就記 phase/job）
- 快速系統訊號（至少其中一個）：
  - `iostat -x 1 3`（await/%util）
  - `ss -ti`（retrans/rto）
  - Prometheus：`go_gc_duration_seconds` / `go_goroutines` / node disk latency

> 這 4 行資訊通常就足以把方向分到「網路」或「對端忙/I/O/GC」。

---

## 0.8)（補）如果你跑在 Kubernetes：優先檢查這些「會讓 60s ping 斷掉」的常見點

這條 log 很常在 K8s 環境被放大，原因是多了一層 overlay/CNI/iptables/conntrack。

建議在你鎖定 `local->remote` 之後，優先確認：
- **Pod/Node 連線是否經過 NAT/conntrack**：大量連線（S3 client + internal grid）時，conntrack table 滿/衝突會造成短暫黑洞。
  - Node 上看：`conntrack -S` / `cat /proc/sys/net/netfilter/nf_conntrack_max`
- **CNI/overlay 健康度**：Flannel/Calico/Cilium 的 datapath 若遇到 drop 或 policy 變更，也會造成 ping/pong 停擺。
  - 先看 CNI daemonset 的 logs（同時間窗）是否有重啟、BPF map error、iptables update 等。
- **MTU/MSS 問題**：overlay + jumbo frame 常見「大包會碎/被丟」，導致看起來像偶發 timeout。
  - 快速驗證：在 node 間做 `ping -M do -s <size>`（或 `tracepath`）找 path MTU。
- **kube-proxy/iptables 規則 churn**：規則大量變更時，可能造成短瞬間 conn reset/timeout（尤其是 NodePort/ExternalTrafficPolicy 交錯）。

如果你同時間也看到 healing/scanner/rebalance，請把它當成「資源壓力」的放大器：
- healing 讀寫 I/O → node CPU softirq/IOwait 上升 → grid handler 排隊 → `LastPing` 更新延遲

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

### 1.0)（補）把「server 端 60s 沒看到 ping」對到 client 端：ping loop 在哪裡送？
你在排查時常會卡在一個點：
- log 是 **server 端**印的（`checkRemoteAlive()` 看 `LastPing`）
- 但真正要釐清的是：**remote 端到底有沒有送 ping？送了但丟包？還是送了但 server 端忙到收不到/處理不到？**

建議你在同一份 source tree 直接把「ping 的送出端」也釘死（函式簽名/檔案），這樣你做 pprof/trace 或加 debug log 才知道該插哪裡：

```bash
cd /home/ubuntu/clawd/minio

# 先把 internal/grid 裡所有 ping 相關點列出來（不同版本命名可能略有差）
grep -RIn "Ping" minio/internal/grid | head -n 80

grep -RIn "clientPingInterval" minio/internal/grid | head -n 80

grep -RIn "LastPing" minio/internal/grid | head -n 120

# 進一步把「ping 送出端 / 接收端」釘到實際函式（命名在不同版本可能不同）
grep -RIn "send.*ping" minio/internal/grid | head -n 80
grep -RIn "handle.*ping" minio/internal/grid | head -n 80
```

> 實務判讀：
> - 如果你發現 client 端 ping goroutine 其實還在跑（而且對端也收得到），但 server 端 `LastPing` 不更新：偏向 server 端忙/排程延遲（I/O/GC/healing/rebalance）
> - 如果 client 端 ping 本身就停了：偏向 remote 端整體掛住（CPU starvation、GC STW、process 被 OOM/kill、或網路 path 問題）

補充：這條 log 出現在 `muxserver.go`，代表它是針對 **streaming mux（MuxID != 0）** 的存活檢查（而不是單純整條 Connection 的 MuxID=0 ping/pong）。因此你在現場看到它大量出現時，常常不是「所有 RPC 都斷」而是「某些 streaming/長連線類的 grid traffic 心跳跟不上」。
- `defaultSingleRequestTimeout = time.Minute`（`minio/internal/grid/grid.go`）
  - 非 streaming 的單次 request（MuxID=0）如果 context 沒 deadline，會以這個 timeout 當預設。

> 備註：這些 interval/threshold 目前是 code 常數（不是 config 參數）。因此看到 `~60s not seen` 更應該把它當作「網路/資源讓心跳停掉」的症狀，而不是先想調參。

### 1.0.1（補）同時間窗若你也看到 Healing/MRF 很忙：先用行號把修復路徑定位起來

另外一個很常見的「同時間窗證據」是：PutObject 在完成 `renameData()` + `commitRenameDataDir()` 之後，若偵測到任何 disk offline，會呼叫 `er.addPartial(...)` 把補洞工作丟進 MRF queue（背景會再走 `HealObject()`）。

所以你如果看到：
- `canceling remote connection ... not seen for ~60s`
- 同時間 PutObject 還在持續進來
- 以及 healing/scanner/MRF 有明顯負載

那很常就是：**寫入達 quorum 但有洞 → MRF/Healing 補洞 → I/O 壓力上升 → grid ping/pong handler 延遲**。

（讀碼對照：`cmd/erasure-object.go: erasureObjects.putObject()` 內 `commitRenameDataDir()` 後段會檢查 `onlineDisks[i].IsOnline()`，不在線就 `addPartial()`。）
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

### 2.6.1) （補）如果同時間有 Auto-heal：把 `.healing.bin` 跟 `local->remote` 關聯起來

當 `canceling remote connection` 出現時，如果你也懷疑是 **auto drive healing / background healing** 把 I/O 壓滿，建議你在事件裡額外記下：

- remote 節點的每顆 disk 上是否存在：`<drivePath>/.minio.sys/buckets/.healing.bin`
- `.healing.bin` 的 `LastUpdate`（是否在同時間窗持續更新）
- `ItemsHealed/ItemsFailed/BytesDone` 是否在短時間內快速增加

原因：auto-heal（新盤/回復）會用 `.healing.bin` 當 tracker；如果它正在快速更新，而 grid 同時大量 cancel remote connection，通常代表 **磁碟 I/O + goroutine 排隊/GC** 壓力很高（ping handler 來不及更新 `LastPing`）。

（對照讀碼頁：`docs/trace/healing.md` 已整理 `.healing.bin` 的 code 位置與實體路徑。）

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


## 4) 現場立即可做的「最小指令集」（把網路 vs 資源壓力分開）

> 目的：你不需要一開始就猜是誰的鍋；先用一組最便宜的資料把問題分到「網路」或「對端忙到 ping handler 跑不動」。

### 4.1 先把 log 裡的 local/remote 變成「你要查的那一條連線」
在出現 log 的節點（local）上，記下：
- local endpoint（印 log 的那台）：`A:9000`
- remote endpoint（被 cancel 的那台）：`B:9000`

接著做：

```bash
# 只看跟 remote B:9000 有關的 TCP 狀態（ESTAB、retrans、rto）
ss -tiH '( sport = :9000 or dport = :9000 )' | grep -F 'B:9000' -n

# 只看 socket 統計（是否有明顯的 retrans / drops）
netstat -s | egrep -i 'retran|timeout|listen|reset' | head -n 50
```

判讀：
- 如果 `ss -ti` 顯示大量 `retrans` / `rto`，先偏向 **網路品質/丟包**。
- 如果幾乎沒 retrans，但 log 還是一直 cancel，常見是 **對端忙/排程延遲**。

### 4.2 10 秒內抓 I/O latency（最常見的共犯）
在 remote 節點（B）上：

```bash
iostat -x 1 3
# 看 await/svctm/util，尤其是 metadata-heavy 時會把 await 拉很高
```

- `await` 很高 + `%util` 逼近 100%：先偏向 **磁碟 latency/queue depth 把整體拖慢**。

### 4.3 看 Go runtime 是否「忙到 ping 跑不動」（goroutine/GC 的側寫）
如果你有 metrics：
- `go_goroutines` 突增、`go_gc_duration_seconds` 尖峰、`process_cpu_seconds_total` 飆高

如果你沒有 metrics，最便宜替代是看同時間 MinIO 的 log 是否出現：
- healing/scanner/rebalance phase 變更、或大量 `MRF`/healing 相關訊息

### 4.4 K8s 特有：先排除 conntrack/NAT/Service 路徑造成的假斷線
如果 MinIO 跑在 Kubernetes：

1) **確保 inter-node 不要走 Service/NAT**（應該要走 Pod IP / hostNetwork / headless service / direct endpoint）
- 如果 node-to-node grid traffic 走 kube-proxy/NAT，很容易被 conntrack 壓力或 idle timeout 影響

2) **看 conntrack 是否接近滿載**（node 上）
```bash
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
# count/max 接近 1 代表非常危險
```

3) **檢查 MTU / CNI**
- VXLAN/overlay 常見 MTU 不一致 → 偶發丟包 → ping/pong 斷

> 小結：只要你能把「同時間窗」的 retrans / iowait / healing 負載對上，`canceling remote connection` 這條 log 往往只是結果，不是原因。

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


## 6.3 （補）把 ping/pong 的完整 call chain 釘死（方便你在 code 上對齊）

你在排 `canceling remote connection` 時，真正要回答的是：

- **client 端是不是按期送出 ping？**（timer tick / write loop 有沒有卡住）
- **server 端是不是有收到並更新 `LastPing`？**（handler / mux lookup / atomic.Store 有沒有跑到）

下面用 *最短可 grep 的路徑* 把 ping/pong 的 flow 串起來（以你 workspace 的 source tree：`/home/ubuntu/clawd/minio` 為準；檔名/行號可能隨版本漂移）。

### A) client → server：Ping 的送出
1) `minio/internal/grid/muxclient.go`
- `(*muxClient).checkRemoteAlive()`（timer）
  - 依 `clientPingInterval` 週期送 ping
- `(*muxClient).ping()`（組 ping message / 送到 connection）

2) `minio/internal/grid/connection.go`
- `(*Connection).writeLoop()` / `(*Connection).send()`
  - 把 `OpPing` 寫進 socket（或對應的 framed stream）

> 你如果懷疑是「對端忙到連 ping 都送不出去」，通常會在這段看到 goroutine 卡在 write 或鎖（例如 write buffer 滿、或 scheduler delay）。

### B) server 收到 Ping：更新 `muxServer.LastPing`
1) `minio/internal/grid/connection.go`
- `(*Connection).readLoop()` → `(*Connection).handleMsg()`
  - 解析 message 後遇到 `OpPing` → `(*Connection).handlePing(ctx, m)`

（以本 workspace `/home/ubuntu/clawd/minio` 當下版本為準，`handleMsg()` 內的 switch 是：`case OpPing: c.handlePing(ctx, m)`）

2) `minio/internal/grid/connection.go`
- `func (c *Connection) handlePing(ctx context.Context, m message)`
  - 若 `m.MuxID == 0`：走 `c.queueMsg(m, &pongMsg{})`（connection-level ping/pong）
  - 若 `m.MuxID != 0`：`v, ok := c.inStream.Load(m.MuxID)`，找到 streaming mux server，然後：`pong := v.ping(m.Seq)`

3) `minio/internal/grid/muxserver.go`
- `(*muxServer).ping(seq uint32) pongMsg`
  - 這裡會更新：`atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

3) `minio/internal/grid/muxserver.go`
- `(*muxServer).checkRemoteAlive()`（server 側的 watchdog）
  - `time.Since(time.Unix(LastPing, 0)) > lastPingThreshold` → 印你看到的 log 並 `m.close()`

### C) 快速自我驗證（現場用 grep 就能對齊）
```bash
cd /home/ubuntu/clawd/minio

# client 端 ping tick + ping sender
grep -RIn "checkRemoteAlive" internal/grid/muxclient.go internal/grid/muxserver.go
grep -RIn "clientPingInterval" internal/grid

# server 端 LastPing 更新點
grep -RIn "LastPing" internal/grid/muxserver.go

# message handler（OpPing/OpPong）
grep -RIn "OpPing" internal/grid
grep -RIn "handlePing" internal/grid || true

# 這條 log 的出處
grep -RIn "canceling remote connection" internal/grid
```

> 實務上：如果你已經從 `ss -ti` 確認 retrans 不高，但仍一直 `canceling remote connection`，很常就是 server 端「收到 ping 的 handler」或「更新 `LastPing` 的那段」被 I/O/GC/排程壓力拖到超過 threshold。

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

在 MinIO 內部，grid 的 request/response 也會走 **internal trace**：
- 位置：`minio/internal/grid/trace.go`
- 典型行為：把 handler 名稱組成 `grid.<HandlerID>`（或相近格式）送到 trace stream，讓 `mc admin trace --type internal` 能看到。

你可以用這個方法把「同一時間窗到底是哪類 handler 在狂打」抓出來：

1) 在任一節點跑 trace（建議加時間窗、避免噴太多）：
```bash
# 觀察 60~120 秒就很有價值
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

2) 把 trace 的 `grid.<handler>` 對回 source code 的「註冊表/路由」

不同版本命名可能略不同，但大方向是：
- handler 會在 `minio/internal/grid` 下被註冊（通常有 handler 列表/對照表）
- `trace` 會把 handler id/name 放進事件

你可以用這幾個 grep 錨點，先把 mapping 找出來：
```bash
cd /home/ubuntu/clawd/minio

# trace 的格式/欄位來源
grep -RIn "type Trace" internal/grid/trace.go internal/grid/*.go | head -n 80
grep -RIn "funcName" internal/grid/trace.go internal/grid/*.go | head -n 80

# handler 註冊表/ID（不同版本檔名不同，先用關鍵字抓）
grep -RIn "type HandlerID" internal/grid | head -n 80
grep -RIn "Register" internal/grid | head -n 80
```

> 用意：你不一定要一次就精準定位到哪個 goroutine 卡住；只要能先回答「同時間窗最熱的是哪一類 grid handler（storage/peer/lock/heal/scanner）」通常就夠把排查方向收斂到正確模組。

2) 對照 `canceling remote connection local->remote` 的那一對 endpoint：
- trace 事件的 `nodeName` 是 remote（對端）
- `funcName` 會長得像：`grid.<handler>`（例如 storage/peer/lock 相關 handler）

3) 如果你在同一時間窗看到：
- `grid.*` 的某一類 handler 大量出現、而且 duration 拉長
- 同時又有 `canceling remote connection ... not seen for ~60s`

通常可以收斂成兩種方向：
- **網路方向**：trace 的 handler 幾乎沒有進來（或 error 多為連線層），但仍大量 cancel → 更像 ping/pong 本身被丟包/中間設備斷線
- **資源方向（更常見）**：trace 顯示 handler 進來但 duration 飆高、error 少 → 更像對端忙到 handler / ping 更新 `LastPing` 來不及

### 2.7.1) 把 `grid.<handler>` 反查回 source code（快速對照是哪個 module）
`mc admin trace --type internal` 看到的 `funcName=grid.<handler>`，`<handler>` 其實是 grid 內部對 handler 的命名（通常對應某個 HandlerID / route）。

在你要把「哪個 handler 在打爆 grid」落到具體程式碼時，可以用 source tree 直接反查：
```bash
cd /home/ubuntu/clawd/minio

# 找 handler 註冊表/映射（不同版本檔名可能略有變，但大多在 internal/grid）
grep -RIn "type HandlerID" -n internal/grid | head
grep -RIn "grid\." -n internal/grid | head

# 用你在 trace 看到的 handler 字串反查
# 例：funcName=grid.storage.ReadFile 之類
HANDLER='grid.<PASTE_FROM_TRACE>'
grep -RIn "${HANDLER#grid.}" -n internal/grid cmd 2>/dev/null | head -n 50
```

> 小提醒：`canceling remote connection` 這條 log 沒印 subroute/handler，所以 trace 是少數能把「哪個功能在用 grid」具體化的方式。當你發現某類 handler 特別集中，再回頭對照同時間窗的 healing/scanner/rebalance，就能很快分辨是「背景任務造成資源壓力」還是「網路層掉包」。

> 小提醒：如果你看到 duration 尖峰集中在 heal/scanner/mrf 時段，請把它跟 `/trace/putobject-healing` 的 MRF/HealObject call chain 一起看，通常能更快定位「是 heal I/O 把節點拖慢」還是「純網路抖動」。

---

## 2.10) （補）用「remote endpoint」把 internal trace 與 log 事件對齊（更省時間）

你在 log 看到的是 `localIP:9000->remoteIP:9000`，但 `mc admin trace` 的輸出通常是 `nodeName`（節點名）而不是 IP。

因此我實務上會用兩步法，盡量把它變成「可被 copy/paste 的 SOP」：

### Step 1：先把 `local->remote` 事件固定成一條 key
在 incident note 先抄這三個欄位（後面所有 grep/trace 都用同一組）：
- `local endpoint`：`<localIP:9000>`
- `remote endpoint`：`<remoteIP:9000>`
- `time window`：`T±5m`

### Step 2：抓 internal trace，找「哪類 grid handler」在同一時間窗暴衝/變慢
在任一節點跑（只抓 60~120 秒就很有價值；時間太長會噴爆）：
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

判讀技巧：
- 若同時間窗 **`grid.*` 事件量很少**，但仍大量 `canceling remote connection`：偏向「網路/中間設備/封包丟失」，internal handler 根本沒進來。
- 若同時間窗 **某些 `grid.*` handler 事件量大 + `duration` 拉長**：偏向「對端忙/I/O 或 GC 壓力」，handler 進來了但跑很慢，連 ping 更新也被拖。

> 若你能從 trace 找出「最熱的 grid handler 名稱」，再回頭用 source tree 搜 handler 註冊/route（`internal/grid`）通常就能把它落到具體模組（storage/peer/lock/heal/scanner）而不是只停在「grid 斷線」。

---

## 9)（補）把「症狀 → 可能的上層模組」做一個超快對照（incident triage cheat-sheet）

> 用途：當你只拿到一行 `canceling remote connection ... not seen for ~60s`，你要在 10 分鐘內先把方向定出來（網路 vs 資源/背景任務）。

### 9.1 若同時間窗有這些現象：優先懷疑「資源壓力（I/O/GC/排程）」
- healing / scanner / rebalance / replication 其中一個正在跑（或剛啟動）
- `PutObject` latency 變差、或 background 出現大量 heal trace
- remote 節點磁碟 `await` / `%util` 明顯飆高（`iostat -x 1 3`）
- remote 節點 `go_gc_duration_seconds` 或 `go_goroutines` 出現尖峰（若有 metrics）

下一步（最短路徑）：
1) 在 remote 節點確認是不是 healing/scanner 在跑（log/trace/metrics）
2) 直接把觀察點釘在最容易把 handler 卡住的 3 個 I/O 點：
   - Healing：`readAllFileInfo(...)` / `erasure.Heal(...)` / `disk.RenameData(...)`
   - PutObject：`erasure.Encode(...)` / `renameData(...)` / `commitRenameDataDir(...)`

### 9.2 若同時間窗看到「TCP retrans/rto 明顯增加」：優先懷疑「網路/中間設備」
- `ss -ti` 看到大量 `retrans`、或 `rto` 拉很大
- remote 漂移、不是固定同一台
- K8s 環境同時間有 CNI/kube-proxy/conntrack 相關告警或重啟

下一步（最短路徑）：
1) 鎖定 `local->remote`（固定那對 endpoint）
2) 同時間窗做：MTU/conntrack/CNI logs（K8s）+ mtr/ethtool counters（裸機）

### 9.3 若只發生在固定某台 remote：優先懷疑「那台的 disk/CPU/GC」
- `local->remote` 幾乎都指向同一個 remote
- 其他 node 互相之間很少斷

下一步（最短路徑）：
1) 在該 remote 上查：`dmesg`（I/O timeout/reset）、`iostat -x`、是否有 `.healing.bin` 更新
2) 若是 K8s：同時間窗看 node 是否有 CPU steal、OOM、kubelet hang


---

## 10)（補）把「我看到的那條 log」變成可重現的排查單位（實戰小抄）

我最近遇到（或最常被貼到工單裡）的原始訊息長得像：

```
WARNING: canceling remote connection <localIP:9000->remoteIP:9000> not seen for 1m0.xxs
```

把它變成「可行動」的最小單位，我會固定做三件事：

1) **先把同時間窗的 background job 記下來（只要一句話）**
- 例如：`healing/scanner/MRF` 是否正在跑、是否剛好有 disk offline/online 事件。

2) **用 internal trace 抓 60~120 秒，確認同時間窗「最熱的 grid handler」是什麼**
- 目的：把「grid 斷線」從抽象變成「哪個模組在狂打/變慢」。

```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.error,.duration] | @tsv'
```

3) **把瓶頸觀察點收斂到 I/O 三件套**（只要抓得到其中一個就很有價值）
- `iostat -x 1 3`（await/%util）
- `ss -ti`（retrans/rto）
- `dmesg -T | egrep -i 'timeout|reset|I/O error'`（是否有 storage 層 reset/timeout）

> 只要「同時間窗」能對上 `healing/scanner/MRF` + `await/%util` 尖峰，這條 grid log 幾乎就可以先當成 *症狀*（ping handler 來不及更新），排查重點應該回到 healing/MRF 的 I/O 與磁碟健康，而不是先鑽 grid 參數。

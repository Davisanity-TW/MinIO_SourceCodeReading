# canceling remote connection：觀測/指標對齊筆記（Prometheus / logs / trace）

> 目的：把 `canceling remote connection A:9000->B:9000 not seen for 1m...` 這類事件，從「單行 log」快速對齊到：
> - 同時間窗的 **I/O/CPU/GC** 壓力
> - **Healing / scanner / MRF / rebalance** 背景任務強度
> - **網路 retrans / packet drop / conntrack** 訊號
>
> 快速分流版請先看：
> - `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
>
> Code anchors（把 ~60s watchdog 釘死到 internal/grid）：
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`

---

## 0) 一律先固定「事件欄位」再看指標（避免對錯時間窗）

每次看到一行 log，先把它抄成三欄：

- time window：`T ± 5m`（建議 10 分鐘窗）
- local->remote：`A:9000 -> B:9000`
- not seen for：通常 `~60s`（server 端 `lastPingThreshold = 4 * clientPingInterval`）

> 小提醒：若 `not seen for` 明顯不是 ~60s，優先排除 **NTP/時鐘跳動**（尤其是 chrony step）。

---

## 1) MinIO 自身：把「背景任務」跟 time window 對齊

### 1.1 internal trace：抓 grid handler 熱點（最實用）

```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.time >= "T0" and .time <= "T1")
           | select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

判讀：
- 若同時間窗 `grid.*` duration 明顯變長，常見是「對端忙」→ handler 排隊/排程飢餓/I/O 卡住。
- 若 `grid.*` 量暴增（事件數暴增），常見是 healing/scanner/rebalance 類背景流量放大。

### 1.2 `mc admin heal` / 背景 heal 狀態（有 alias 的話）

```bash
mc admin heal --json <ALIAS> | jq -r '.time,.node,.status,.summary'
mc admin heal status <ALIAS>
```

判讀：
- 如果同時間窗 heal/scanner/MRF 在跑，`canceling remote connection` 很常是「結果」而非 root-cause（I/O + 排程壓力讓 ping handler 跑不動）。

---

## 2) Prometheus（建議）：把「網路 vs I/O/CPU/GC」快速切開

> 下列 query 以常見 exporter 命名為假設（node-exporter / kubelet cAdvisor / MinIO metrics）。實際 metric 名稱以你環境為準。

### 2.1 網路：先看 retrans / drop（偏網路）

- TCP Retrans（node-exporter 常見）：
  - `rate(node_netstat_Tcp_RetransSegs[5m])`

- 介面 drop（看是哪個 NIC）：
  - `rate(node_network_receive_drop_total[5m])`
  - `rate(node_network_transmit_drop_total[5m])`

判讀：
- retrans/drop 同窗上升，通常優先查：MTU、CNI、conntrack、ToR/交換器、LB idle timeout。

### 2.2 磁碟 I/O：latency/%util（偏 I/O）

- IO time / util（node-exporter）：
  - `rate(node_disk_io_time_seconds_total[5m])`

- 平均 request latency（估算，需 per-device）：
  - `rate(node_disk_read_time_seconds_total[5m]) / rate(node_disk_reads_completed_total[5m])`
  - `rate(node_disk_write_time_seconds_total[5m]) / rate(node_disk_writes_completed_total[5m])`

判讀：
- latency/%util 同窗尖峰，且同時有 healing/scanner/MRF，通常是 I/O 壓力導致 grid handler 延遲。

### 2.3 CPU / throttling（K8s 常見誤判點）

- Pod CPU throttling（cAdvisor 常見）：
  - `rate(container_cpu_cfs_throttled_seconds_total{container!="",pod=~"minio.*"}[5m])`

判讀：
- throttling 明顯：Go runtime 可能出現排程飢餓（某些 goroutine 長時間拿不到 CPU），表現成 ping handler 延遲。

### 2.4 Go runtime（若有暴露）：GC/heap/threads

- GC pause（若有 `go_gc_duration_seconds`）：
  - `rate(go_gc_duration_seconds_sum[5m]) / rate(go_gc_duration_seconds_count[5m])`

判讀：
- GC pause / heap 成長異常同窗上升時，要把「對端忙」的假說納入（不一定是網路）。

---

## 3) 僅有節點 shell 時：最小「蒐證包」

> 跟 quick triage 重疊，但這裡把「要留檔」的輸出項目列成固定格式，方便貼 incident note。

### 3.1 網路
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | sed -n '1,200p'

nstat | egrep -i 'TcpRetransSegs|TcpTimeouts|TcpExtTCPSynRetrans|TcpExtTCPAbortOnTimeout|IpInDiscards|IpOutDiscards'
```

### 3.2 磁碟
```bash
iostat -x 1 3

# 若可以：挑出最慢的 block device / 檔案系統
lsblk

dmesg -T | tail -n 200
```

### 3.3 MinIO process（對端忙假說）
```bash
# 低成本：看 goroutine 是否暴增/CPU 是否打滿
ps -eo pid,ppid,cmd,%cpu,%mem --sort=-%cpu | head

# 如允許：SIGQUIT 抓 goroutine dump（見另一頁）
# docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md
```

---

## 4) 建議寫在 incident note 裡的一句話模板（含觀測欄位）

> 在 `T±5m` 觀察到：`A->B` 出現 `canceling remote connection`；同窗 `grid.*` internal trace duration 上升、磁碟 await/%util 尖峰（或 CPU throttling/GC pause 上升）。推測對端 I/O/排程壓力使 grid ping handler（LastPing 更新）延遲，觸發 server 端 ~60s watchdog。

---

## 5) 延伸閱讀
- `docs/troubleshooting/canceling-remote-connection.md`（根因分類 + 10 分鐘 SOP）
- `docs/troubleshooting/canceling-remote-connection-codepath.md`（internal/grid code anchors）
- `docs/troubleshooting/canceling-remote-connection-pprof-cheatsheet.md`
- `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`

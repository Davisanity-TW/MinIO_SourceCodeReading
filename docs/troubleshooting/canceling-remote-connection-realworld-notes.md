# Real-world note：`canceling remote connection`（一次典型現場觀察怎麼記、怎麼查）

> 目的：把你在值班/追查時「真的看到的 log」跟「能快速驗證的假設」寫成一頁可複用筆記。
>
> 這頁不取代主頁（原因總覽/SOP）：
> - 主要排查頁：`docs/troubleshooting/canceling-remote-connection.md`
> - code path（讀碼錨點）：`docs/troubleshooting/canceling-remote-connection-codepath.md`

---

## 1) 你看到的 log 長什麼樣？（先原封不動抄下來）

典型訊息：

```text
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```

**請務必同時記 3 個欄位**（incident note 最小集）：
- time window：`T ± 5m`
- local->remote：`10.0.0.10:9000 -> 10.0.0.11:9000`
- not seen for：`1m2.3s`（多數版本接近 ~60s）

---

## 2) 最常見的「同時間窗伴隨訊號」（用來快速分類）

### 2.1 同時看到 healing/scanner/MRF 很忙（更像資源壓力，而不是網路）

你可能會在同一個時間窗看到：
- Healing / scanner 事件量明顯上升
- `mc admin trace --type healing|internal` 出現大量 `HealObject` / `RenameData` 相關操作
- 節點 `iostat -x` 顯示 `%util` 高、`await` 飆高

**快速假設**：
- PutObject/Healing 的 rename/fsync/metadata ops 把 I/O 打滿 → goroutine 排程延遲 → grid ping handler 來不及更新 `LastPing` → server 端 watchdog 60s 後斷線。

對照的「最短因果鏈」請見：
- `docs/trace/putobject-healing.md`（PutObject 留 partial → MRF → HealObject）
- `docs/trace/putobject-healing-callchain.md`（把 PutObject / Healing 補到實際檔案/函式/最短 grep 錨點）
- `docs/trace/grid-canceling-remote-connection.md`（mux watchdog 判定 `LastPing` 超時）

（現場建議的「最短釘點」：先把 PutObject 與 Healing 的入口函式都 grep 出來，避免你在不同 tag/patch 間追錯檔案）
```bash
cd /path/to/minio

# PutObject（HTTP handler → erasure putObject）
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# HealObject（MRF/scanner/admin → erasure healObject）
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head
```

### 2.2 同時看到大量 TCP 重傳/RTO（更像網路/CNI/MTU/conntrack）

同時間窗在 local 節點跑：

```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```

如果 retrans/RTO 很明顯，而磁碟/CPU/GC 沒有尖峰，優先轉向：
- MTU 不一致（overlay / VXLAN / Geneve）
- conntrack 表爆掉或 timeout 太短
- 中間設備/LB idle timeout

---

## 3) 一次值班「最小蒐證包」（30 分鐘內可以拿到的證據）

在同一時間窗（T±5m）各取一份：

1) **local**：TCP retrans / RTO
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```

2) **remote**：磁碟 I/O latency（確認是不是 I/O 壓力把 handler 拖慢）
```bash
iostat -x 1 3
```

3) **cluster**：trace（把 grid 斷線對回「哪個 handler/背景工作」）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

---

## 4) 版本無關的 code anchors（把 log 釘到 source）

> 目的：避免「行號漂移」。用字串/函式簽名定位。

```bash
cd /path/to/minio

# log 字串（最穩）
grep -RIn "canceling remote connection" -n internal/grid | head

# watchdog / alive check
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

# threshold 與 ping interval
grep -RIn "lastPingThreshold" -n internal/grid | head
grep -RIn "clientPingInterval" -n internal/grid | head

# LastPing 更新點
grep -RIn "LastPing" -n internal/grid/muxserver.go internal/grid/connection.go | head -n 120
```

---

## 5) （備註）不要忘了查「時鐘/NTP 跳動」

`not seen for` 的計算多半是 `time.Since(time.Unix(LastPing,0))`。如果你在 incident 裡看到：
- `not seen for` 明顯偏離 ~60s
- 或短時間內忽大忽小

請把 NTP/校時納入排查（避免把校時造成的時間跳動誤判成網路/資源問題）。

```bash
timedatectl status
chronyc tracking
chronyc sources -v
```

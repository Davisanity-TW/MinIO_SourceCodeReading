# Troubleshooting：`canceling remote connection`（root cause map + 快速縮小範圍）

> 這個訊息常出現在 healing/scanner/MRF 高壓期，容易被誤判成「網路壞掉」。
> 
> 目標：把它拆成幾個最常見的 root-cause bucket，並給出可操作的檢查順序。

相關頁：
- `docs/troubleshooting/canceling-remote-connection.md`（總覽）
- `docs/troubleshooting/canceling-remote-connection-field-checklist.md`（現場 checklist）
- `docs/troubleshooting/canceling-remote-connection-code-anchors.md`（對應到 code 的 grep 錨點）
- `docs/trace/putobject-healing-callchain.md`（PutObject ↔ Healing ↔ peer rest / grid RPC 的關係）

---

## 0) 先問自己：這是「結果」還是「根因」？

`canceling remote connection` 在 MinIO 的語境裡，多數時候是 **grid / peer REST streaming 連線被 watchdog 主動中止** 的「結果」。

最常見的 upstream 原因不外乎：
1) **handler 排隊/卡住**（CPU 飆高、GOMAXPROCS 不夠、mutex/metadata lock、磁碟延遲）
2) **網路/封包/MTU/conntrack**（尤其是 K8s / overlay / NodePort / NAT）
3) **對端重啟或資源壓力**（OOM、FD 用盡、GC pause、cgroup throttling）

下面的檢查順序就是為了先排「最常見且最容易確認」的那幾個。

---

## 1) 先做 3 個「10 秒內」的 sanity check

### 1.1 同時間點，MinIO 是否正在做 heavy background work？
- Healing（scanner / MRF / admin heal）
- Batch replication / ILM / transition
- 大量 list（walk）

如果有，先把它視為「壓力下的連線中止」：
- 先找 **哪台 node / 哪個 pool/drive** 是瓶頸，而不是只盯著網路。

### 1.2 這個訊息是出現在 *server* 還是 *client*？
- server 端：通常是 **對端太慢 / 連線被回收 / watchdog 觸發**
- client 端：通常是 **dial/keepalive/讀寫超時** 或對端重啟

同一條 log 的前後 30 秒，是否有：
- `context deadline exceeded`
- `i/o timeout`
- `connection reset by peer`

### 1.3 是否只集中在某幾台節點？
- 如果只集中在單一 node：先懷疑 **該 node 的 CPU/磁碟/網路卡**
- 如果全體一起爆：先懷疑 **上游網路（switch/ToR）或共用元件（kube-proxy/conntrack）**

---

## 2) Root-cause buckets（依「最常見」到「較少見」）

### Bucket A：磁碟/檔案系統延遲（最常見）
典型徵兆：
- healing/rename/xl.meta 讀寫變慢
- load average 高，但 CPU 使用率不一定高
- iowait 上升

快速驗證：
- 看 node 的 `iostat -x 1` / `pidstat -d 1`
- 看是不是某顆 disk latency（await）異常

對應 code 區塊（讓你知道為什麼會拖到 grid watchdog）：
- healing：`(*erasureObjects).healObject()` → `readAllFileInfo()` → `Erasure.Heal()` → `StorageAPI.RenameData()`
- putobject：`putObject()` → `renameData()` / `commitRenameDataDir()`

### Bucket B：CPU / goroutine 飽和（handler 排隊）
典型徵兆：
- `GOMAXPROCS` 太小（容器配額）或 throttling
- goroutine 暴增（scanner/heal/list）
- p99 latency 飛

快速驗證：
- `top` / `pidstat -u 1`
- 若可行：`curl /minio/v2/metrics/cluster` 看 scheduler/GC 相關指標

### Bucket C：網路（MTU / conntrack / drops）
典型徵兆：
- 只在跨 AZ / overlay / 特定路徑發生
- `dmesg` / `ethtool -S` 有 drop / rx_missed

快速驗證：
- K8s：確認 CNI MTU（特別是 VXLAN / Geneve）
- node：`ss -s`、`conntrack -S`（若可）

### Bucket D：對端重啟 / OOM / FD 用盡
典型徵兆：
- 同時間點有 pod restart / OOMKilled
- `too many open files`

快速驗證：
- K8s events / systemd journal / container logs

---

## 3) 建議的現場排查順序（最省時間）

1) **先定位「是哪兩台 node 在互相 cancel」**（client ↔ server）
2) **同時間點對照：healing/scanner/MRF 是否活躍**
3) **先查磁碟 latency**（很常就是某顆 disk 或某台 node 慢）
4) 再查 CPU throttling / load / goroutine
5) 最後才深入查網路（MTU/conntrack/drops）

---

## 4) 事件筆記要記什麼（讓下次更快）

建議固定記錄欄位：
- 發生時間（含時區）
- 受影響節點（source/dest）
- 同時間的背景任務（heal/scanner/mrf/admin heal）
- node 的 iostat 摘要（哪顆盤 await 異常）
- 是否有重啟 / OOM / throttling


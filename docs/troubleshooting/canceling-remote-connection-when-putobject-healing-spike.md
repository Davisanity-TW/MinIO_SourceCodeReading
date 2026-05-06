# Troubleshooting：`canceling remote connection`（發生在 PutObject / Healing 壓力尖峰時）

> 目的：把現場常見的一種情境補成「可操作」的排查筆記：
> - 看到 `canceling remote connection`（grid/muxserver）
> - 同時間 PutObject 量大 / Healing（MRF、scanner、admin heal）在跑
> - 直覺懷疑是「網路問題」，但實際常是 **node tail latency / disk stall** 讓 grid 長連線的 keepalive/handler 排不到

相關總頁：`docs/troubleshooting/canceling-remote-connection.md`

---

## 1) 先把這個 log 釘死在 code

`canceling remote connection` 的字串通常在 `internal/grid/muxserver.go` 一帶。

Anchors：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80
grep -RIn "clientPingInterval" -n internal/grid | head -n 80
```

你要確認的重點是：
- 這不是「應用層主動踢人」而已，而是 muxserver 偵測到 remote 不 alive（ping/pong / deadline）後，清掉那條連線。

---

## 2) 為什麼 PutObject/Healing 尖峰會讓 grid 連線被 cancel？（最常見機制）

在 MinIO 現場，`canceling remote connection` 很常不是網路斷線，而是：

1. PutObject 寫入主線把 **rename/metadata/fsync** 拉到高延遲
2. 同時間 partial/MRF 或 scanner 觸發 healing，把 **讀 meta + RS rebuild + writeback/rename** 疊上去
3. node 上 goroutine/CPU 被擠壓，或 disk queue / iowait 飆高
4. grid/muxserver 的 ping/pong、stream handler 無法在 deadline 內被排程 → muxserver 判斷 remote 不 alive → log `canceling remote connection`

### 2.1 PutObject → partial → MRF → healObject 的最短鏈（可 grep 對齊）

（更完整 anchors 參考 `docs/trace/putobject-healing-real-functions.md`）

```bash
cd /path/to/minio

# PutObject 主線
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# partial → MRF enqueue
grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go

# MRF consumer → HealObject
grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 40
```

---

## 3) 現場排查：先證明是「網路」還是「尾延遲/卡住」

### 3.1 同步抓兩件證據（同一個時間窗）

A) `canceling remote connection` 發生的節點（server side）
- 看 log 週期性/爆量（每秒、每分鐘？）
- 有無伴隨 `ErrDisconnected`、peer RPC timeout、healing status 卡住

B) 同時間節點是否出現 **disk stall / iowait / long syscalls**
- Linux：`iostat -x 1`、`pidstat -d 1`、`top` 看 iowait
- 若可重現：對 minio pid 做 `strace -f -tt -T -p <pid>`（短時間）
- `perf top`/`perf sched`（可選）

**判斷邏輯：**
- 如果網路真的斷：通常是雙向、多台 peer 同時斷線，且 OS 層有 link reset / retrans timeout
- 如果是尾延遲：通常是某幾台 node 成為「慢點」，其他 peer 對它的 grid 連線一直被 cancel/reconnect

### 3.2 立即可做的「縮小範圍」檢查

- Healing 有沒有在爆：
  - admin heal / background heal status
  - MRF queue 是否堆積（見 `cmd/mrf.go` 相關 metrics/log）

- PutObject 是否在爆：
  - S3 5xx 是否同時上升（尤其 timeout / slow requests）
  - disk `RenameData`、`WriteMetadata` 相關耗時是否上升

Anchors（找 rename/metadata 熱點）：
```bash
cd /path/to/minio

grep -RIn "RenameData\\(" -n cmd | head -n 80
grep -RIn "WriteMetadata" -n cmd/xl-storage.go | head -n 80
```

---

## 4) 常見處置方向（按風險由低到高）

1. **先減少同時進行的 healing 來源**
   - 避免同時跑 scanner + 大量 admin heal（尤其 heal bucket / deep heal）

2. **把「慢點」節點上的 I/O 壓力降下來**
   - 觀察是否某一台磁碟/raid controller/queue 深度異常
   - 查 SMART / dmesg（有無 reset/timeout）

3. **如果是 PutObject 尖峰觸發 MRF 連鎖**
   - 先查 partial 是否大量產生（PutObject 失敗/timeout）
   - 調整 upstream client 的 timeout/retry/backoff，避免把尾延遲放大成雪崩

---

## 5) 你可以如何把這次事件寫成「可重用」的 incident note（建議欄位）

- 發生時間窗（含時區）
- 哪些 node 是「被 cancel」的 hot spot
- 同時間 PutObject QPS、Healing objects/s、MRF queue 深度
- iowait / disk util / max await（最重要）
- 你最後採取的處置（停 heal / 調整 workload / 換盤等）與效果

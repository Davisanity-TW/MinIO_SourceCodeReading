# Troubleshooting：`canceling remote connection`（事件筆記模板 + 現場對齊點）

> 目的：把我在現場遇到的 `canceling remote connection` 類型問題，整理成 **可重複使用** 的排查筆記。
>
> 這頁偏「事件筆記模板」：你拿到 log / pprof / strace / iostat 的片段時，可以用它快速把問題對齊到 MinIO code path。

相關總覽（先看這些再回來）：
- 快速分流：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- Root causes：`docs/troubleshooting/canceling-remote-connection-root-causes.md`
- PutObject/Healing 共振：`docs/troubleshooting/canceling-remote-connection-with-putobject-healing.md`
- 讀碼 trace（PutObject/Healing）：`docs/trace/putobject-healing-real-functions.md`

---

## 1) 現場第一句要問：這句 log 是「server 端」還是「client 端」？

`canceling remote connection` 通常是 **server** 端（mux/server）判定 peer 連線不健康後主動取消。

### Code 對齊 anchors

> 不同版本檔案可能微調，但 anchor 很穩：字串在 `internal/grid`。

```bash
# 在 minio repo 根目錄

grep -RIn "canceling remote connection" -n internal/grid | head -n 50

# mux server watchdog / liveness check
# 你要找到的通常是：checkRemoteAlive / ping interval / read deadline

grep -RIn "checkRemoteAlive\\(" -n internal/grid | head -n 50

grep -RIn "clientPingInterval|pingInterval|pong" -n internal/grid | head -n 80
```

你要在 log 上補齊：
- 這句出現的 node（哪台？哪個 pool？）
- 同一時間窗口（±60s）其他 node 是否也出現類似訊息
- 是否同時出現：`context deadline exceeded` / `i/o timeout` / `slow disk` / `disk not found` / `rename` 卡住

---

## 2) 現場最常見共振：PutObject / Healing 拉高「rename/fsync/metadata fan-out」尾延遲

> 這是我最常遇到的模式：
> - 不是 network 先壞，而是 storage tail latency 先飆
> - grid 這種長連線 mux 的 ping/pong handler 排不到 → 被判定「不活了」

### 你要抓的 OS 指標（同一時間窗）

- `iostat -x 1`：`await`, `svctm`, `util`（util 接近 100% + await 上升通常是警訊）
- `pidstat -d 1 -p $(pidof minio)`：確認是 minio 在打 IO
- `strace -ff -tt -p <pid> -e trace=fsync,fdatasync,rename,renameat2,openat,unlink,write`（短時間取樣）

### 對應到 MinIO 的寫入階段（PutObject/Healing 都會踩到）

- PutObject：`renameData(...)` → `disk.RenameData(...)` → `(*xlStorage).RenameData(...)`
- Healing writeback：`writeUniqueFileInfo/writeAllDisks` → `WriteMetadata/WriteAll` → `rename/commit`

Anchors（讀碼對齊）：
```bash
# PutObject rename/commit

grep -RIn "^func renameData" -n cmd/erasure-object.go

grep -RIn "RenameData\\(ctx" -n cmd/erasure-object.go cmd/erasure-healing.go | head -n 80

# xlStorage 實作（最後會落到 os.Rename + (f)data sync 類操作）

grep -RIn "func \\(s \\*xlStorage\\) RenameData" -n cmd/xl-storage.go

grep -RIn "os\\.Rename|renameat2" -n cmd/xl-storage.go internal | head -n 80
```

---

## 3) 現場筆記模板（建議直接複製貼上填空）

### 3.1 事件摘要

- 時間區間（含時區）：
- 影響面：PUT latency / GET latency / healing backlog / cluster membership
- 影響桶/路徑（如有）：
- 觸發操作：大量 PutObject / 大量 healing / rebalance / bucket heal / node reboot

### 3.2 日誌關鍵片段（貼 3～10 行就好）

- `canceling remote connection` 前後 30 行：
- 同時間 `slow disk` / `drive` / `rename` / `fsync`：
- 其他 node 是否同時出現：

### 3.3 指標/證據

- iostat（最忙的 device + await/util）：
- pprof（top stacks + 卡住的 syscalls/函式）：
- strace（rename/fsync/寫 metadata 的卡點）：

### 3.4 初步假設（只能列 1～3 個）

- [ ] storage tail latency（rename/fsync/metadata fan-out）
- [ ] network / MTU / packet loss（需證據）
- [ ] Go runtime / GC / CPU saturation（需證據）

### 3.5 下一步（可立即操作，不影響資料安全）

- [ ] 降低 healing/scan concurrency（短期止血）
- [ ] 觀察 MRF queue / healing backlog 是否下降
- [ ] 對最慢 device 做 SMART/firmware/RAID cache 檢查

---

## 4) 交叉參考：PutObject / Healing 的實際呼叫鏈（最短路徑）

這段在讀碼上最常用：

- PutObject：`cmd/object-handlers.go` → `cmd/erasure-object.go`（encode/write/rename/commit）
- Partial/MRF：`cmd/erasure-object.go:addPartial` → `cmd/mrf.go:addPartialOp` → `cmd/mrf.go:healRoutine`
- Healing：`cmd/erasure-server-pool.go:HealObject` → `cmd/erasure-healing.go:healObject`

完整 anchors：見 `docs/trace/putobject-healing-real-functions.md`。

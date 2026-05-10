# Troubleshooting：`canceling remote connection` 與 PutObject/Healing 壓力共振（筆記）

> 目的：把我在現場遇到的 `canceling remote connection` 這句 log，補成「可以直接動手排查」的筆記頁。
>
> 這頁聚焦：當 PutObject（寫入）/Healing（修復、重建）把 **disk rename/fsync/metadata** 打爆，造成 node tail latency 上升，最後讓 grid（peer REST / internal/grid）連線被 watchdog 取消。

相關 Trace（呼叫鏈錨點清單）：
- `docs/trace/putobject-healing-real-functions.md`
- `docs/trace/grid-canceling-remote-connection.md`

---

## 1) 你看到的現象（症狀群）

常見同時出現：
- server log：`canceling remote connection`（通常在 `internal/grid`）
- client side：`context deadline exceeded` / `connection reset by peer` / `ErrDisconnected`（依版本/場景而定）
- pprof / goroutine dump：大量 goroutine 卡在 `rename`、`fdatasync/fsync`、`WriteMetadata`、`ReadFile`、`stat` 這類 syscall 附近
- I/O 指標：
  - latency 尾端（p99/p999）上升
  - util% 長時間偏高
  - queue depth 增加

快速定位 log 在哪：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head
```

---

## 2) 最常見根因模型：grid watchdog 被「disk tail latency」拖死

我目前把它視為一個共振鏈：

1) PutObject/Healing 造成磁碟端寫入與 metadata ops（rename/fsync/write metadata）大量堆積
2) node tail latency 上升，grid mux 的 ping/pong 或某些 handler 無法在 deadline 內被排程/完成
3) server 端判斷 remote 不再 healthy → `canceling remote connection`

對齊到 code 的關鍵錨點：
```bash
cd /path/to/minio

# watchdog / ping 機制（不同版本檔名可能微調，但關鍵字很穩）
grep -RIn "checkRemoteAlive\(" -n internal/grid | head -n 50

grep -RIn "clientPingInterval" -n internal/grid | head -n 50

grep -RIn "canceling remote connection" -n internal/grid | head -n 50
```

---

## 3) PutObject / Healing 端：最容易把 I/O 拉爆的點（把 syscall 對回 Go 函式）

### 3.1 RenameData：rename + sync 的最常見落點

- 介面：`cmd/storage-interface.go` → `StorageAPI.RenameData(...)`
- 實作（常見）：`cmd/xl-storage.go` → `(*xlStorage).RenameData(...)`
- 呼叫點（PutObject/Healing 都會走到）：`cmd/erasure-object.go` / `cmd/erasure-healing.go`

```bash
cd /path/to/minio

grep -RIn "RenameData\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-object.go cmd/erasure-healing.go | head -n 120
```

### 3.2 Healing 寫回 metadata：WriteMetadata / WriteAll

```bash
cd /path/to/minio

grep -RIn "WriteMetadata" -n cmd/xl-storage.go | head -n 80

grep -RIn "func \(.+\*xlStorage\) WriteAll" -n cmd/xl-storage.go | head -n 40
```

---

## 4) 現場排查 checklist（從「快」到「深」）

### 4.1 先確認是不是「Healing 壓力」在共振

- 背景 heal/MRF queue 是否暴增？
- 最近是否有大量 disk 變慢/壞軌/firmware/控制器問題？
- 是否剛好有 rebalance、healing scan、或大量小物件寫入？

你可以先抓：
- bg healing 狀態（mc admin heal status / Console）
- MinIO 的 pprof（goroutine / profile）

### 4.2 若你已經抓到 pprof/goroutine dump

把 stack 先粗分類：
- 卡在 `RenameData`/`renameData`/`commitRenameDataDir`
- 卡在 `WriteMetadata`/`WriteAll`
- 卡在 `readAllFileInfo`（讀 meta fan-out）

然後回到 trace 文件對 anchors：
- `docs/trace/putobject-healing-real-functions.md`

---

## 5) 可能的改善方向（按風險排序）

> 這段是「策略建議」；是否適用要看你 cluster 的瓶頸點。

低風險：
- 先把「是哪顆 disk / 哪台 node」慢定位出來（iostat/SMART/控制器/檔案系統）
- 用 pprof 確認熱點是不是集中在 rename/fsync/metadata

中風險：
- 降低 healing scan 的擾動（排程/節流，或避開尖峰寫入時間）

高風險（需要完整變更管理）：
- 檔案系統與 mount options、storage stack（RAID/HBA/queue depth）調校
- 版本升級（有些 release 會調整 grid 連線/timeout 行為）

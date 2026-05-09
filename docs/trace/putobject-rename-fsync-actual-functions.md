# Trace：PutObject rename/fsync（實際函式/檔案/呼叫鏈）

> 目的：把「PutObject → renameData → disk.RenameData → FS rename/fsync」這條路補成 **可直接 grep 對齊** 的實際函式 / 檔案清單。
>
> 背景：現場常見症狀是 PutObject 延遲飆高、或同時間出現 `canceling remote connection`（grid mux watchdog）。
> 很多時候根因是 **rename + fsync**（或 metadata writeback）在某些 disk/節點上尾延遲很大。
>
> 原則：
> - 不記行號（避免漂移）
> - 每段提供最短 anchors

---

## 1) PutObject 主線：寫 tmp → renameData → commit

最短定位：
- `cmd/erasure-object.go`
  - `func (er erasureObjects) putObject(...)`（或 `PutObject` → `putObject`）
  - `renameData(...)`
  - `commitRenameDataDir(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

grep -n "^func renameData" cmd/erasure-object.go

grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 80
```

你要找 rename/fsync 卡住，通常會沿著 `renameData(...)` 往下追每顆 disk 的 `RenameData` 實作。

---

## 2) renameData() → StorageAPI.RenameData()：跨 disk fan-out 的切點

典型 pattern：
- `cmd/erasure-object.go`：`renameData(...)`
  - loop disks → `disk.RenameData(ctx, ...)`

Anchors：
```bash
cd /path/to/minio

grep -n "\\.RenameData(ctx" cmd/erasure-object.go | head -n 120

grep -RIn "type StorageAPI interface" -n cmd/storage-interface.go
grep -RIn "RenameData(ctx" -n cmd/storage-interface.go
```

重點：
- `renameData` 是 PutObject 的 **可見性切換點**；卡住就會把 HTTP handler 卡住
- 同時也會放大 node 的 tail latency，影響 peer REST/grid 的 ping/pong（間接觸發 `canceling remote connection`）

---

## 3) xlStorage 的 RenameData：最常見的「真正落地」位置

多數部署的本地 disk 實作是 `xlStorage`：
- `cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(ctx context.Context, srcVolume, srcPath, dstVolume, dstPath string) error`

Anchors：
```bash
cd /path/to/minio

grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go
```

你在這裡通常會看到幾類關鍵操作（不同版本命名可能微調）：
- `os.Rename(...)` / `renameat`
- 針對目錄或檔案的 `fsync`（確保 metadata durability）
- 若有 tmp/legacy path 轉換，會有 `pathJoinBuf` 等 helper

### 3.1 `os.Rename` 的直接 anchor
```bash
cd /path/to/minio

grep -n "os\\.Rename" cmd/xl-storage.go | head -n 80
```

### 3.2 fsync 相關 anchor（不同 release 可能分散在 helper）
```bash
cd /path/to/minio

grep -RIn "fsync" -n cmd/xl-storage.go cmd/os-*.go internal/* 2>/dev/null | head -n 120
```

實務判讀：
- 卡在 `os.Rename`：常見是底層 FS/RAID/磁碟（或 NFS/遠端）鎖競爭、I/O stall
- 卡在 `fsync`：常見是 journal/metadata flush 的尾延遲；配合 `iostat -x`, `pidstat -d`, `bpftrace`/`perf` 可更快定位

---

## 4) （補）RenameData 失敗/超時 → partial → MRF → Healing：共振鏈

你要把「rename/fsync 卡住」跟「後續 healing」串起來，最短 anchors：

- PutObject 留 partial：
  - `cmd/erasure-object.go`：`addPartial(...)` → `globalMRFState.addPartialOp(...)`
- MRF 消費端：
  - `cmd/mrf.go`：`healRoutine(...)` → `z.HealObject(...)`

Anchors：
```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go

grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 40
```

---

## 5) 與 `canceling remote connection` 的關係：grid mux watchdog 的 code 錨點

當 node 因為 rename/fsync/metadata 尾延遲而「整體排程變慢」，grid 連線上的 ping/pong 或 handler dispatch 會失去 deadline，常在 log 看到：
- `canceling remote connection`

Anchors：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 40

grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80
```

建議搭配閱讀：
- `docs/troubleshooting/canceling-remote-connection-when-rename-fsync-stalls.md`
- `docs/trace/putobject-healing-real-functions.md`

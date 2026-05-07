# Trace：PutObject / Healing 常見 pprof / SIGQUIT stack 指紋（可對齊到實際檔案/函式）

> 目的：當你在現場拿到 `pprof/goroutine` 或 `kill -QUIT`（goroutine dump）時，快速把「卡住在哪一段」對回 MinIO source code 的 *實際檔案/函式*。
>
> 使用方式：
> 1) 先從 stack 內挑 1~2 個最穩的函式/檔案 token
> 2) 用本頁提供的 anchors 在你實際版本的 source tree 直接 `grep -RIn` 釘住
> 3) 再回到對應的 trace 筆記頁（PutObject / Healing / grid watchdog）串成因果鏈

關聯頁：
- PutObject 主線：`docs/trace/putobject.md`
- PutObject ↔ Healing：`docs/trace/putobject-healing-callchain.md`
- grid watchdog：`docs/troubleshooting/canceling-remote-connection.md`

---

## 0) 先辨識：你看到的 stack 是 PutObject 還是 Healing？

### PutObject 常見 token
- `objectAPIHandlers.PutObjectHandler`（HTTP handler）
- `(*erasureServerPools).PutObject` / `(*erasureSets).PutObject`
- `erasureObjects.putObject`
- `renameData` / `commitRenameDataDir`
- `(*xlStorage).RenameData`

### Healing/MRF 常見 token
- `(*mrfState).healRoutine`（MRF consumer）
- `(*scannerItem).applyHealing`（scanner）
- `(*erasureServerPools).HealObject` / `(*erasureSets).HealObject`
- `(*erasureObjects).healObject`
- `readAllFileInfo` / `Erasure.Heal`
- `StorageAPI.RenameData` / `(*xlStorage).RenameData`

---

## 1) PutObject：rename/fsync/metadata stall（最常跟 latency 尖峰共振）

### Stack 指紋（你可能在 dump 裡看到）
- `cmd/erasure-object.go`：`renameData` / `commitRenameDataDir`
- `cmd/xl-storage.go`：`(*xlStorage).RenameData`
- 或更底層：`os.Rename` / `unix.Renameat` / `syscall.Fsync`

### 最短 anchors（跨版本穩）
```bash
cd /path/to/minio

# PutObject write+commit
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# rename/commit hot path
grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go

# StorageAPI.RenameData → xlStorage.RenameData
grep -RIn "type StorageAPI interface" -n cmd/storage-interface.go
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go | head -n 120
```

判讀提示：
- 如果 goroutine 大量堆在 `RenameData`/`Fsync`，通常是 metadata-heavy tail latency（rename/fsync）在放大。
- 同時間窗若出現 `canceling remote connection ... not seen for ~60s`，很常是「對端忙到 ping handler 跑不動」的結果（不一定是網路掉包）。

---

## 2) Healing：readAllFileInfo（xl.meta fan-out）卡住

### Stack 指紋
- `readAllFileInfo` / `readFileInfo` / `xlMeta`
- 常見伴隨大量 goroutine 在讀 metadata（小檔/bucket 多時特別明顯）

### Anchors
```bash
cd /path/to/minio

grep -RIn "readAllFileInfo\\(" -n cmd | head -n 60

# healObject 主流程
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 40
```

---

## 3) Healing：RS rebuild（Erasure.Heal）/ writer 被 I/O 卡住

### Stack 指紋
- `Erasure.Heal` / `NewErasure` / `Decode` / `Encode`
- `bitrot` reader/writer（視版本命名可能不同）

### Anchors
```bash
cd /path/to/minio

# RS heal
grep -RIn "func (e Erasure) Heal" -n cmd | head -n 60

# PutObject encode（常與 heal 的 I/O 壓力互相放大）
grep -RIn "\\.Encode\\(ctx" -n cmd/erasure-object.go | head -n 80
```

---

## 4) Healing/寫回：StorageAPI.RenameData（把重建結果原子寫回）

### Stack 指紋
- `(*erasureObjects).healObject` → `StorageAPI.RenameData` → `(*xlStorage).RenameData`

### Anchors
```bash
cd /path/to/minio

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 160
```

---

## 5) grid：`canceling remote connection`（streaming mux watchdog）

### Stack / log 指紋
- log：`canceling remote connection ... not seen for ...`
- code：`internal/grid/muxserver.go`：`(*muxServer).checkRemoteAlive()`

### Anchors
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head
grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80

# threshold 常數（多數版本是常數）
grep -RIn "clientPingInterval" -n internal/grid | head -n 80
```

---

## 6) 你可以直接照抄的 incident 結論句（避免把因果寫反）

- 「`canceling remote connection` 是 grid streaming mux 的 ~60s watchdog；同時間窗若看到 `RenameData/fsync` 或 `healObject/readAllFileInfo` goroutine 堆積，優先懷疑 I/O tail latency / 背景 healing 造成 ping handler starvation，而非純網路斷線。」

- 「若 `ss -ti` 顯示 retrans/RTO 明顯升高，才把方向往網路/CNI/MTU/conntrack 先拉高優先序。」

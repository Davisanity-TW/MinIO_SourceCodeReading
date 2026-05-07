# Trace：PutObject / Healing 的 rename/fsync 熱點（RenameData / commitRenameDataDir）——實際函式/檔案/呼叫鏈

> 目的：把現場最常卡住、也最容易跟 `canceling remote connection` 共振的 **rename/fsync/metadata** 熱點，補成一頁「可跨版本 grep 對齊」的 call chain。
>
> 你在 incident 常會看到：
> - PutObject latency 飆高（或 tail latency 長尾）
> - 同時間 MRF/Healing 變多
> - grid/peer RPC 印 `canceling remote connection`（看起來像網路斷線，實際常是對端太忙）
>
> 這頁只做一件事：把 **PutObject 的 rename/commit** 與 **Healing 的 RenameData** 精準釘到實際函式/檔案，讓你能用 stack/pprof/strace 直接回鏈到 source。

相關頁：
- PutObject/Healing 全圖與更多背景：`docs/trace/putobject-healing-callchain.md`
- PutObject/Healing（實際函式清單）：`docs/trace/putobject-healing-real-functions.md`
- `canceling remote connection` 排查主頁：`docs/troubleshooting/canceling-remote-connection.md`

---

## 1) PutObject：rename/commit 的最短 call chain（`.minio.sys/tmp` → `<bucket>/<object>`）

**抽象鏈：**
- `PutObjectHandler` → `ObjectLayer.PutObject` → `erasureObjects.putObject`
- `renameData(...)` → `disk.RenameData(...)`（每顆 disk）
- `commitRenameDataDir(...)`（可見性切換 / commit）

**核心檔案/函式：**
- `cmd/object-handlers.go`：`func (api objectAPIHandlers) PutObjectHandler(...)`
- `cmd/erasure-object.go`：`func (er erasureObjects) putObject(...)`
- `cmd/erasure-object.go`：`func renameData(ctx context.Context, ... )`（helper）
- `cmd/erasure-object.go`：`commitRenameDataDir(...)`
- `cmd/storage-interface.go`：`type StorageAPI interface { RenameData(...) }`
- `cmd/xl-storage.go`：`func (s *xlStorage) RenameData(...)`（常見實作落點）

Anchors（只用函式簽名/穩定字串，避免行號漂移）：
```bash
cd /path/to/minio

# PutObject handler → ObjectLayer
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go

# putObject 主流程
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# rename/commit helper
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 80

# StorageAPI.RenameData interface + xlStorage 落點
grep -n "RenameData(" cmd/storage-interface.go
grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go
```

### 1.1 你在 strace/pprof 看到「rename/fsync 卡住」要怎麼回鏈

常見 syscall 熱點（視 FS/內核/磁碟而異）：
- `renameat2` / `renameat`
- `fsync` / `fdatasync`
- `mkdirat` / `openat` / `fchmodat`（metadata-heavy）

對照方向：
- stack/pprof 顯示卡在 `(*xlStorage).RenameData` 或 `renameData` → 幾乎可以直接假設是「metadata ops + fsync tail latency」
- 若同時間 `canceling remote connection` 激增 → 先驗證對端是否 **ping handler starvation**（不是純網路）

（grid watchdog 的 code anchors 另見：`docs/trace/grid-canceling-remote-connection.md`）

---

## 2) Healing：`HealObject()` → `healObject()` → `disk.RenameData()` 的最短 call chain

**抽象鏈：**
- 入口（MRF/scanner/admin）→ `ObjectLayer.HealObject`
- `(*erasureObjects).healObject(...)`
  - `readAllFileInfo(...)`（讀 meta fan-out）
  - `erasure.Heal(...)`（RS rebuild）
  - `disk.RenameData(...)` / `(*xlStorage).RenameData(...)`（寫回 + 原子切換）

Anchors：
```bash
cd /path/to/minio

# HealObject 分層跳板（pool/sets/objects）
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 40
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head -n 40

# healObject 主流程
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 40

# meta fan-out / RS rebuild / rename writeback
grep -RIn "readAllFileInfo\\(" -n cmd | head -n 40
grep -RIn "func (e Erasure) Heal" -n cmd | head -n 40

grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go | head -n 140
```

---

## 3) 與 `canceling remote connection` 的共振：一行 log 怎麼快速分流

這句 log（server-side）通常在 `internal/grid` 的 mux watchdog：
- 「**~60s 沒看到 client ping**（或 ping 進來但 handler 排不到）」→ server 主動 close

最小 anchors：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "clientPingInterval|lastPingThreshold" -n internal/grid | head -n 80
```

**現場快速判讀（偏實務）：**
- 同時間窗：PutObject/Healing/MRF 活躍 + disk iowait/await 飆高 + stack 指到 `RenameData/fsync` → 優先朝「對端忙（I/O tail latency）」排查
- 若 ss/nstat 顯示 retrans/RTO 爆炸、或只有特定網段/節點對 → 才把網路/CNI/conntrack 放到前面

---

## 4) 最小蒐證包（你只抓得到 5 分鐘也夠用）

1) 固定時間窗（60–120s）：把 `canceling remote connection` 的 local->remote 組合記下來
2) 兩台節點同窗：
   - `iostat -x 1 60`（或 node exporter disk metrics）
   - `ss -ti` / `nstat`（retrans/RTO）
3) 取一份 goroutine dump/pprof：看有沒有大量卡在 `RenameData`/`fsync`/`readAllFileInfo`/`erasure.Heal`

把上述證據對回本頁 anchors，incident note 就能從「像網路」直接收斂到「是哪個 code path/哪類 I/O」。

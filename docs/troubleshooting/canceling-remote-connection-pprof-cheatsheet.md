# canceling remote connection：pprof / trace 快速定位 cheatsheet

> 目的：當你在同一時間窗看到大量：
> - `canceling remote connection A:9000->B:9000 not seen for ...`
> - 以及 `grid: ErrDisconnected` / request latency 飆高
>
> 這份頁面提供「不靠猜」的最小證據收集方式：用 **pprof / internal trace** 把問題分成：
> - (A) **網路/傳輸層**（ping 真的沒到）
> - (B) **對端忙/排程延遲**（ping 到了但 handler 沒被排到、或 I/O/GC 把 goroutine 卡住）
>
> 讀碼錨點請搭配：`docs/troubleshooting/canceling-remote-connection.md`。

---

## 0) 先固定「哪一對節點」與時間窗

從 log 原文拆三個欄位（每次 incident 都建議照抄）：
- **time window**：`T ± 5m`
- **local->remote**：`A:9000 -> B:9000`
- **not seen for**：`~60s`（多數版本）

> 誰印 log = local（A）；被 cancel 的那台是 remote（B）。

---

## 1) 最便宜的 3 個訊號：先分「網路」vs「對端忙」

### 1.1 local 端：TCP retrans / RTO（偏網路）
在 **local (A)**：
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 200
```
判讀：
- `retrans` / `rto` 明顯增加 → 優先懷疑 **網路/CNI/MTU/conntrack/中間設備 idle timeout**

### 1.2 remote 端：disk latency（偏 I/O/資源壓力）
在 **remote (B)**：
```bash
iostat -x 1 3
```
判讀：
- `await` 高、`%util` 接近 100% → 常見是 **healing/scanner/rebalance 把 I/O 打滿**，造成 grid ping handler 延遲

### 1.3 任一節點：MinIO internal trace（把「grid」落到「哪個 handler」）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```
判讀：
- 若同時間 `grid.*` duration 明顯拉長，且 (1.2) I/O 也高 → 優先走「對端忙」路線

---

## 2) 進一步：用 pprof 把「對端忙」落到具體卡點（I/O / lock / GC）

> 你要的是：證明 remote (B) 當下 goroutine/排程卡在哪裡。
> 常見卡點：
> - Healing：`readAllFileInfo()` / `erasure.Heal()` / `StorageAPI.RenameData()`
> - PutObject：`erasure.Encode()` / `renameData()` / `commitRenameDataDir()`
> - grid：`internal/grid` 的 readLoop/writeLoop / muxserver ping handler 被延遲

### 2.1 goroutine profile（最實用）
目標：在 remote (B) 取到 **goroutine dump**，看是不是大量卡在：
- `cmd/erasure-healing.go`（healObject / RenameData）
- `cmd/erasure-object.go`（PutObject rename/commit）
- `cmd/xl-storage.go`（RenameData 內部 syscall）

> 取得方式依你的部署型態而定：
> - 若你有啟用 MinIO 的 profiling/admin endpoint：用你既有 SOP（例如 `mc admin profile` / `mc admin inspect`）。
> - 若你是自建 binary 且暴露了 net/http/pprof：用 `go tool pprof` 抓 `/debug/pprof/goroutine?debug=2`。

拿到 goroutine profile 後的「快速 grep」：
```bash
# 直接找最常見的三個 I/O/修復熱點
grep -nE "readAllFileInfo\(|erasure\.Heal\(|RenameData\(" goroutines.txt | head -n 200

# 看 grid ping/pong 相關是否被拖慢
grep -nE "internal/grid|OpPing|LastPing|checkRemoteAlive" goroutines.txt | head -n 200
```

### 2.2 block / mutex profile（判斷是不是鎖/排程壓力）
若 goroutine profile 看起來不是 I/O，而是大量等鎖，建議同時間抓：
- mutex profile（鎖競爭）
- block profile（channel/同步阻塞）

> 這兩種 profile 需要程式有打開對應的 runtime 設定；是否可抓取取決於你線上版本/啟動參數。

### 2.3 heap / GC（判斷是不是 GC pause 把 ping 延遲放大）
如果同時間有：
- heap 快速上升
- `go_gc_duration_seconds` 尖峰

那 `canceling remote connection` 可能是 GC/排程壓力的副作用。

---

## 3) 讀碼對照：把 profile 堆疊對回關鍵函式（不靠行號）

> 一律用 signature grep（跨 RELEASE tag 不怕飄）。

在你對應的 MinIO source tree：
```bash
cd /path/to/minio

# PutObject 熱點
grep -RIn "func \(api objectAPIHandlers\) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func \(er erasureObjects\) putObject" -n cmd | head
grep -RIn "func renameData\(" -n cmd | head
grep -RIn "commitRenameDataDir\(" -n cmd | head

# Healing 熱點
grep -RIn "func \(er \\*erasureObjects\) healObject" -n cmd | head
grep -RIn "readAllFileInfo\(" -n cmd | head
grep -RIn "\\.Heal\(ctx" -n cmd | head
grep -RIn "RenameData\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd | head

# grid watchdog 熱點
grep -RIn "canceling remote connection" -n internal/grid | head
grep -RIn "checkRemoteAlive" -n internal/grid | head
```

---

## 4) 最小結論模板（可直接貼 incident note）

> 用意：讓後續回溯的人不用重做一次推理。

- 時間窗：`T ± 5m`
- local->remote：`A:9000 -> B:9000`，`not seen for ~60s`
- 同時間窗：
  - TCP retrans/RTO：`(有/無)`（`ss -ti`）
  - remote I/O：`await=%s util=%s`（`iostat -x`）
  - internal trace：最熱的 `grid.*` handler：`<funcName> <duration>`
- 初步判定：
  - 偏網路（retrans/RTO 明顯）/ 偏對端忙（I/O 高或 healing/scanner 活躍）
- 佐證（如有）：
  - goroutine profile 顯示大量卡在：`readAllFileInfo` / `erasure.Heal` / `RenameData`（或其他堆疊）

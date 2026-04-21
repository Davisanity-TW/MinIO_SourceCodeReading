# Troubleshooting：`canceling remote connection` 事件的「stack dump/pprof」快速特徵（signature）

> 目的：當你已經在 log 看到 `canceling remote connection ... not seen for ~60s`，你下一步常常是抓：
> - `SIGQUIT` goroutine stack dump（最便宜，現場最常用）
> - 或 Go pprof（CPU/heap/block/mutex）
>
> 這頁把「最常見、最好判讀」的 stack signature 列出來，讓你不用每次從頭看。
>
> 延伸閱讀：
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`（把 log 釘到 `internal/grid`）
> - `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`（怎麼抓、怎麼保存）
> - `docs/troubleshooting/canceling-remote-connection-with-putobject-healing.md`（PutObject/Healing 共振時的因果鏈）

---

## 1) 先講判讀原則：你在找什麼？

`canceling remote connection`（server ~60s watchdog）最常見不是「單純網路斷線」，而是：
- server 沒有在門檻時間內處理/更新 ping（`LastPing`）

因此你要在 stack/pprof 裡回答兩件事：
1) **ping handler 是否被餓死**（CPU/排程/GC/鎖）
2) **系統是否卡在 I/O 熱點**（rename/fsync/metadata lock/heal rebuild）

---

## 2) Signature A：大量 goroutine 卡在 `RenameData` / `os.Rename` / `fsync`

這個型態最常出現在：
- Healing 寫回（`RenameData`）
- PutObject commit（tmp → 正式）
- metadata-heavy（大量小檔/dirent lock）

你在 stack dump 可能會看到類似（示意）：
- `cmd/xl-storage.go: (*xlStorage).RenameData`
- `cmd/storage-interface.go: StorageAPI.RenameData`
- `os.rename` / `syscall.Rename`
- `syscall.Fsync` / `fdatasync`

讀碼 anchors（方便把 stack 函式名釘到 source）：
```bash
cd /path/to/minio

# PutObject commit / rename
grep -RIn "^func renameData" -n cmd/erasure-object.go

grep -RIn "RenameData\(" -n cmd/erasure-object.go cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 200
```

事件筆記常用一句話：
> stack dump 顯示大量 goroutine 卡在 `xlStorage.RenameData()` / fsync/rename，符合磁碟/檔案系統 metadata 壓力導致整體延遲擴散，進而讓 grid ping handler 無法在 watchdog 期限內更新。

---

## 3) Signature B：卡在 healing rebuild / readAllFileInfo fan-out（quorum/metadata）

如果你看到很多 goroutine 在：
- `(*erasureObjects).healObject` / `erasure.Heal`
- `readAllFileInfo` / `getLatestFileInfo`

通常代表 healing 正在「讀很多 metadata + 做 RS rebuild」，磁碟/網路任一端慢都會放大。

Anchors：
```bash
cd /path/to/minio

grep -RIn "func \(er \*erasureObjects\) healObject" -n cmd/erasure-healing.go

grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go cmd/erasure-metadata.go cmd/*.go | head -n 200

grep -RIn "func \(e Erasure\) Heal" -n cmd/erasure-decode.go
```

---

## 4) Signature C：MRF queue / healRoutine 很活躍（PutObject partial → 背景補洞）

當你要證明 PutObject/Healing 共振：
- stack/pprof 若能看到 `mrfState.healRoutine` 或相關 goroutine，代表 background heal 真的在跑

Anchors：
```bash
cd /path/to/minio

grep -RIn "func \(m \*mrfState\) healRoutine" -n cmd/mrf.go

grep -RIn "globalMRFState" -n cmd | head -n 120
```

---

## 5) Signature D：grid mux ping handler/IO loop 被餓死（但不是網路）

你可能會看到：
- `internal/grid/muxserver.go` / `checkRemoteAlive`
- `internal/grid/muxclient.go` ping/pong loop
- 大量 goroutine 在 runtime scheduler / GC / mutex（例如 `runtime.gopark`, `sync.(*Mutex).Lock`）

Anchors：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 120

grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 120

grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 120
```

事件筆記要避免的誤寫：
- 不要只寫「network issue」
- 你至少要把 `LastPing`/`LastPong` 的 watchdog 機制講清楚，並用 stack/pprof 證明「資源壓力」更吻合

---

## 6) 最小結論模板（可直接貼 incident note）

> `canceling remote connection` 對應 `internal/grid` mux server watchdog（`LastPing` 超過門檻，常見 ~60s）。
> stack dump/pprof 顯示大量 goroutine 卡在 `RenameData()`/fsync/rename（或 healing rebuild/readAllFileInfo），推測主要是 I/O/metadata 壓力造成整體延遲擴散，導致 ping handler 無法準時更新；後續以 disk latency、pprof（mutex/block）與網路 counters 交叉驗證。

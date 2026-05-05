# Troubleshooting：`canceling remote connection`（當你懷疑是 PutObject/Healing 的 rename/fsync tail latency 放大）

> 這頁要解決的問題：
> - 你看到 `canceling remote connection`（server side grid/mux watchdog）
> - 同時間窗 PutObject latency 飆高、或 healing/MRF/scanner 很熱
> - 你懷疑根因其實是 **rename/fsync/metadata-heavy I/O 卡住**，導致 ping handler 排不到（不是單純網路掉包）
>
> TL;DR：先用最便宜的三件套把假說「釘死」：
> 1) `journalctl`（同時間窗找 rename/fsync 相關字眼 + PutObject/heal/mrf）
> 2) `iostat -x`（%util / await / svctm）
> 3) `strace -f -tt -T -p <minio-pid>`（直接量測 rename/fsync syscall latency）

相關頁：
- `docs/troubleshooting/canceling-remote-connection.md`（總頁）
- `docs/troubleshooting/canceling-remote-connection-root-causes.md`（根因分類）
- `docs/trace/putobject-healing-actual-callchain-map.md`（PutObject → partial/MRF → HealObject/healObject 的實際函式/檔案錨點）

---

## 1) 先把「同時間窗」釘死（避免誤判）

從 server log 把三個欄位抽出來（建議直接貼進 incident note）：
- time window（±2~5 分鐘）
- `local->remote`
- `not seen for`（通常是 ~60s，若明顯偏離先懷疑 NTP/時間跳動）

示例（把時間窗固定在 120s）：
```bash
# 在印出 cancel 的那台節點上
journalctl -u minio -S "2026-05-05 21:55" -U "2026-05-05 22:05" | \
  grep -E "canceling remote connection|local->remote|ErrDisconnected|context deadline exceeded" -n
```

---

## 2) 快速證明：這不是純網路（而是對端/本機忙到 ping handler 跑不動）

### 2.1 `ss`：retrans/RTO 沒爆，但仍在 cancel（常見於「對端忙」）
```bash
ss -ti dst :9000 | head -n 80
# 看看是否大量 retrans/RTO；若 retrans 幾乎沒有，卻持續 cancel，更像是 handler starvation / busy node
```

### 2.2 `iostat -x`：%util/await 飆高（rename/fsync 會把 metadata-heavy I/O 放大）
```bash
iostat -x 1 10
# 重點看：%util、await、svctm、aqu-sz
```

### 2.3 `strace`：直接量測 rename/fsync latency（最硬的證據）
> 注意：strace 會有開銷；只在短時間窗（10~30s）抓，並優先在「疑似忙的那台」做。

```bash
pidof minio
strace -f -tt -T -p <PID> -e trace=rename,renameat,renameat2,fsync,fdatasync,openat,close,pwrite,write,unlink,statx 2>&1 | \
  head -n 200

# 你在找的證據：同一個 syscall 出現 0.5s/1s/5s 以上的耗時（最後一欄 <...>）
```

若 syscall latency 明顯偏高，而同時間 `canceling remote connection` 出現頻率上升，通常可以把根因方向先定在：
- disk tail latency / filesystem metadata ops
- node CPU/GC/lock 導致 I/O worker/handler 排程延遲（可再用 pprof / SIGQUIT 佐證）

---

## 3) 把現象對回 MinIO code path（PutObject / Healing 的 rename/commit）

### 3.1 PutObject 的 rename/commit 錨點
```bash
cd /path/to/minio

# PutObject 寫入主線（rename/commit）
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 120

# PutObject 出錯後留下 partial（MRF enqueue）
grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -RIn "\\.addPartial\\(" cmd/erasure-object.go | head -n 60
```

### 3.2 Healing 的 RenameData（寫回/原子切換）錨點
```bash
cd /path/to/minio

# healObject 落點（不同版本可能在 erasure-healing.go 或拆檔）
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 60

# 最後寫回通常會走到 StorageAPI.RenameData → xlStorage.RenameData
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-healing.go 2>/dev/null | head -n 120
```

---

## 4) 你可以在 incident note 直接用的結論句（模板）

> 在 `<time window>` 期間，`canceling remote connection`（`local->remote`）頻繁發生；
> 同時間 `iostat -x` 顯示 `<device>` 的 await/%util 明顯升高，且 `strace` 觀察到 `rename/fsync` syscall latency 進入秒級。
> 推定 grid/mux watchdog 斷線為「結果」，根因更可能是 PutObject/Healing 相關 rename/commit（metadata-heavy I/O）造成的 tail latency/排程飢餓；
> 下一步將用 pprof/SIGQUIT 驗證 goroutine 是否大量卡在 `RenameData/fsync/renameData/commitRenameDataDir/healObject`。

# Troubleshooting：`canceling remote connection` 的 goroutine stack / pprof signature 速查

> 目標：你在現場抓到 SIGQUIT stack dump（或 pprof goroutine/block profile）時，能用「關鍵 stack 片段」快速分流：
> - 是網路掉包導致 ping 根本沒到？
> - 還是**對端忙到 ping handler 跑不動**（I/O/GC/鎖/背景任務）？
>
> 本頁把常見的「signature」整理成可 grep 的片段，方便你在 incident note 直接貼：
> - 看到哪些函式，就優先看哪個 root-cause bucket。

---

## 0) 先確認你看到的是哪一端的 watchdog

- server 端（~60s 沒看到 ping）：log 常見 `canceling remote connection ... not seen for ...`
- client 端（~30s 沒 pong）：常見 `ErrDisconnected` / `context deadline exceeded`（取決於 caller）

延伸：`docs/troubleshooting/grid-errdisconnected.md`

---

## 1) Signature：`RenameData()` / fsync / metadata-heavy（最常見的「對端忙」）

當你在 goroutine dump 看到很多 goroutine 卡在 rename/fsync/mkdir/lock，且同時間 `canceling remote connection` 暴增，常見是：
- healing / putobject rename/commit / rebalance / scanner 之類的背景任務把磁碟 metadata ops 打滿
- 造成 grid ping handler 的 goroutine 排程飢餓（不是 ping 沒到，而是「到了但來不及處理」）

### 1.1 典型 stack 片段（示意）
你可能會看到類似（函式名依版本略有不同）：
- `(*xlStorage).RenameData`
- `Renameat` / `renameat2`
- `Fdatasync` / `Fsync`
- `MkdirAll` / `os.Mkdir`

快速 grep（在 stack dump 文本上）：

```bash
# 直接找 storage rename
grep -n "RenameData" stackdump.txt

# 常見 syscall
grep -n "renameat2\|renameat\|fdatasync\|fsync\|MkdirAll\|mkdir" stackdump.txt
```

### 1.2 對照 source anchors（釘到 MinIO code）
```bash
cd /path/to/minio

# storage interface + xlStorage 實作
grep -RIn "RenameData(ctx" -n cmd/storage-interface.go
grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go

# PutObject rename/commit
grep -RIn "^func renameData\(" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head -n 50

# Healing rename（healObject 端呼叫 disk.RenameData）
grep -RIn "RenameData\(" -n cmd/erasure-healing.go | head -n 120
```

---

## 2) Signature：Healing / MRF / scanner 正在跑（重建讀寫把 I/O 打滿）

### 2.1 healing 核心函式
- `(*erasureObjects).healObject`
- `erasure.Heal`
- `readAllFileInfo`

快速 grep：
```bash
grep -n "healObject\|erasure\.Heal\|readAllFileInfo" stackdump.txt
```

對照 source anchors：
```bash
cd /path/to/minio

grep -RIn "^func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go
grep -RIn "\\.Heal(ctx" -n cmd/erasure-healing.go cmd/erasure-decode.go | head -n 80
grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go | head -n 80
```

### 2.2 MRF queue consumer（PutObject 留 partial 後的背景補洞）
- `(*mrfState).healRoutine`

```bash
# stack dump
grep -n "mrfState\|healRoutine" stackdump.txt

# source
cd /path/to/minio
grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
```

### 2.3 scanner 觸發 healing
- `(*scannerItem).applyHealing`

```bash
cd /path/to/minio
grep -RIn "func (i \\*scannerItem) applyHealing" -n cmd/data-scanner.go
```

---

## 3) Signature：grid ping handler / mux 相關 goroutine（判斷是「網路」還是「飢餓」）

你要找的是：
- ping 的接收/處理（LastPing 更新鏈）
- watchdog（`checkRemoteAlive()`）

### 3.1 stack dump 裡常見的關鍵字
- `internal/grid`
- `muxServer`
- `checkRemoteAlive`
- `handlePing`

```bash
grep -n "internal/grid\|muxServer\|checkRemoteAlive\|handlePing" stackdump.txt
```

### 3.2 source anchors
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 40
grep -RIn "checkRemoteAlive" -n internal/grid | head -n 80
grep -RIn "handlePing" -n internal/grid | head -n 120
```

判讀提示：
- 如果 stack dump 顯示大量 goroutine 卡在 storage rename/fsync，而 grid 相關 goroutine 很少能跑：偏向「飢餓」
- 如果你同時看到 TCP retrans/RTO 異常（`ss -ti`/`nstat`）：偏向網路

---

## 4) pprof 快速對照（只寫最常用的兩個）

> 這裡不提供完整 SOP（避免各環境差異）；只列「看到什麼 function 就往哪邊查」。

### 4.1 block profile / mutex profile
若 top stack 出現：
- `(*xlStorage).RenameData`
- `os.(*File).Sync` / `syscall.Fdatasync`
→ 優先看 disk latency / filesystem / 裝置問題。

若 top stack 出現：
- `(*erasureObjects).healObject` / `erasure.Heal`
→ 優先看 healing/scan/rebalance 是否正在打 I/O。

### 4.2 goroutine profile
若 goroutine 數暴增且大量卡在：
- `readAllFileInfo`
→ xl.meta fan-out 讀取壓力（小檔/大量版本/慢盤）。

---

## 5) 最小結論模板（incident note 可直接用）

你可以把本頁的 signature 寫成一句：

- 「同時間窗 `canceling remote connection` 與 healing/MRF/scanner 活躍共現；SIGQUIT stack dump 顯示大量 goroutine 卡在 `(*xlStorage).RenameData`/fsync/rename 類 syscall，推測是 I/O metadata-heavy 導致 grid ping handler starvation（非單純網路掉包）。」

延伸閱讀：
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`
- `docs/trace/putobject-healing.md`

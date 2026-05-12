# Troubleshooting：`canceling remote connection`（我在現場遇到的筆記：log 片段 → 下一步）

> 目的：把我實際遇到過的訊息（以及容易一起出現的訊息）整理成一頁「拿到 log 就能動手」的筆記。
> 
> 重要觀念：這句在 MinIO 多數時候是 **grid/peer REST watchdog 的結果**，根因往往是 **disk tail latency 或 handler 排隊**（特別是 healing / PutObject 高壓期）。

相關頁：
- Root cause map：`docs/troubleshooting/canceling-remote-connection-root-causes.md`
- Quick triage：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- Code anchors：`docs/trace/grid-canceling-remote-connection.md`
- PutObject ↔ Healing：`docs/trace/putobject-healing-real-functions.md`

---

## 1) 你會看到的典型 log（server）

常見片段（示意，字串關鍵在 `canceling remote connection` + `not seen for`）：

```
... grid: canceling remote connection <node-id> (not seen for 1m0s)
```

**我會先做的 3 件事（順序固定）：**
1) 在 client 端同時間窗（±2 分鐘）找 `ErrDisconnected` / `context deadline exceeded` / `i/o timeout`
2) 看同時間是否有 healing/scanner/MRF（或 admin heal）正在跑
3) 直接查受影響節點的 disk tail latency（`iostat -x 1` / `pidstat -d 1`）

因為多數案例是：**disk rename/fsync/xl.meta latency 拉高 → handler 回不來 → watchdog 斷線**。

---

## 2) 我最常一起看到的「共振訊息」與解讀

### 2.1 `ErrDisconnected`（client）

```
... ErrDisconnected
```

解讀：
- 通常不是「網路突然壞」；而是對端太慢（CPU/disk 壓力）導致 pong/handler 超時。

下一步：
- 去對端對齊是否有 `canceling remote connection`（server watchdog）
- 若只集中在 healing 相關 handler（例如 background heal status），直接往 healing 壓力（disk/CPU）查。


### 2.2 `context deadline exceeded` / `i/o timeout`

解讀：
- 這兩個是最容易誤導你去查網路的訊息；但在 MinIO 內部 RPC/streaming 場景，**handler 排隊/卡住**也會呈現類似 timeout。

下一步：
- 一律先把 disk/CPU 的「能否在 30 秒內否決」做完：
  - `iostat -x 1` 看 await/%util
  - `top`/`pidstat -u 1` 看 CPU throttling / steal


### 2.3 PutObject 高壓期：rename/fsync 慢 → partial → MRF heal

你可能在同一段時間看到：
- PutObject latency 變長
- MRF queue enqueue 或 drop
- scanner/heal goroutine 變多

把它釘回 code 的最短 grep（用來跨版本對齊）：
```bash
cd /path/to/minio

# PutObject 主線
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

# rename/fsync 落點
grep -RIn "func \(s \*xlStorage\) RenameData" -n cmd/xl-storage.go

# partial → MRF
grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go
grep -n "func (m \*mrfState) addPartialOp" cmd/mrf.go

# MRF consumer → HealObject
grep -n "func (m \*mrfState) healRoutine" cmd/mrf.go
grep -RIn "func (z \*erasureServerPools) HealObject" -n cmd | head -n 40
```

---

## 3) 我遇到過最有用的「快速否決」手段

### 3.1 10–30 秒 strace：只盯 rename/fsync

> 只建議短時間窗，用來回答一個問題：**是不是 rename/fsync 單次耗時已經到秒級？**

```bash
pidof minio
sudo strace -fp <PID> -tt -T -e trace=rename,renameat,renameat2,fsync,fdatasync,unlink,openat 2>&1 | head -n 200
```

判讀：
- 若 `renameat2/fsync/fdatasync` 的單次 `<...>` 明顯飆高，且 `iostat await/%util` 也一致升高：優先往 disk/FS（特定盤、journal、metadata 壓力、RAID cache、firmware）查。

### 3.2 goroutine/pprof：看是不是卡在 RenameData/commit

如果你有 pprof 或 stackdump：
- 大量 goroutine 卡在 `xlStorage.RenameData` / `commitRenameDataDir` / `readAllFileInfo` 這種點，幾乎可以直接把方向鎖定在 disk/metadata。

---

## 4) 建議你寫事件筆記的固定欄位（下次更快）

- 發生時間（含時區）
- 哪兩台 node（client ↔ server）互相 cancel
- 同時間是否有 healing/scanner/MRF/admin heal
- `iostat -x 1` 摘要（await/%util）
- 是否有重啟 / OOM / CPU throttling

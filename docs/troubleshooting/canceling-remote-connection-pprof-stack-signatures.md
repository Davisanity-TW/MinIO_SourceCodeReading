# Troubleshooting：`canceling remote connection`（pprof/stackdump 常見 stack signatures 對照表）

> 目的：incident 現場你只有兩樣東西：
> - MinIO log 看到 `canceling remote connection`
> - `curl /debug/pprof/goroutine?debug=2` 或 SIGQUIT 的 goroutine dump
>
> 這頁把最常見的 **stack signature → 可能的瓶頸分類 → 下一步驗證** 做成最短對照。
>
> 延伸（精準對回 internal/grid 實際函式/檔案）：
> - `docs/trace/grid-canceling-remote-connection.md`

---

## 0) 先記住一個原則

`canceling remote connection` 多數時候不是「網路線斷了」，而是：
- server 端的 grid/mux ping/pong watchdog 在 deadline 內等不到回應
- 或 handler/forwarding 因為 **I/O tail / lock / CPU starvation** 被拖慢

所以你要做的是：把「grid cancel」和「誰在拖慢 node」用 stack 對起來。

---

## 1) signature：卡在 rename/fsync/fdatasync（PutObject/Healing 最常見）

你會在 dump 裡看到類似：
- `(*xlStorage).RenameData`
- `syscall.Rename` / `renameat2`
- `syscall.Fsync` / `fdatasync`

**分類：I/O / metadata tail latency**

**下一步（最短驗證）：**
1) 同時間跑（抓 30–60 秒就好）：
   - `iostat -x 1`
   - `pidstat -u -w 1 -p $(pidof minio)`
2) 若可：短時間 `strace` 對 minio：
   - `strace -ttT -p <pid> -f -e trace=fdatasync,fsync,rename,renameat2,openat`
3) 用 grep 把 Go 函式對回程式碼：

```bash
cd /path/to/minio

grep -RIn "func \\(s \\*xlStorage\\) RenameData" -n cmd/xl-storage.go

grep -RIn "commitRenameDataDir|renameData\\(" -n cmd/erasure-object.go cmd/erasure-healing.go | head -n 200
```

---

## 2) signature：卡在 lock / global state / namespace（CPU 很閒但 goroutine 排隊）

你會看到類似：
- `sync.(*Mutex).Lock` / `sync.(*RWMutex).RLock`
- `nsLock` / `global*Lock` / `bucket*Lock`（各版本命名不同）

**分類：lock contention / goroutine starvation**

**下一步：**
- 用 goroutine dump 找「誰持有鎖最久」的那幾條 stack
- 對照那個 goroutine 同時正在做 PutObject rename/commit、healing、scanner、tiering 等

建議把 stack 裡出現的函式名當 grep anchor：
```bash
cd /path/to/minio

git grep -n "<stack 上看到的 function name>" -- cmd internal | head -n 50
```

---

## 3) signature：grid/mux 相關 goroutine 大量堆積

你會看到類似：
- `internal/grid` 相關檔案/函式
- 讀寫 socket（`net.(*conn).Read` / `Write`）
- handler forward / stream

**分類：grid handler backlog / keepalive 超時**

**下一步：**
- 先查 internal/grid 的 cancel 來源（server/client 哪一端）：

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 80
```

- 再看當下是否同時間有 I/O tail（最常見）或 lock contention（第二常見）。

---

## 4) 最短結論模板（寫進 incident note 用）

> 觀察到 `canceling remote connection` 時段，同步 goroutine dump 顯示大量 goroutine 卡在 `<signature>`（例如 `(*xlStorage).RenameData` / `fdatasync`）。
> 初步判定是 node 資源 starvation（I/O tail 或 lock contention）造成 grid/mux keepalive deadline 超時，而非單純 network drop。

---

## 5) 相關頁面

- Trace：`docs/trace/grid-canceling-remote-connection.md`
- Trace：`docs/trace/putobject-healing-real-functions.md`
- Troubleshooting：`docs/troubleshooting/canceling-remote-connection-decision-tree.md`

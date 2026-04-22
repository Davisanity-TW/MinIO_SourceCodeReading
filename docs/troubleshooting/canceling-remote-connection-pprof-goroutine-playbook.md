# Playbook：`canceling remote connection` 時，用 pprof / goroutine dump 最快證明「對端忙（I/O/鎖/GC）」而不是純網路

> 目標：當現場出現 `canceling remote connection ... not seen for ~60s`（server 端 grid mux watchdog）時，用**最小、最便宜、可重複**的蒐證，把方向快速分成：
> - A) 純網路問題（loss/retrans/idle timeout/conntrack/MTU）
> - B) 對端忙到 ping handler 跑不動（磁碟 I/O、rename/fsync、鎖競爭、GC、CPU throttling）
>
> 背景與 code anchors：
> - grid watchdog / threshold：`docs/troubleshooting/canceling-remote-connection-codepath.md`
> - PutObject/Healing 共振 call chain：`docs/trace/putobject-healing-callchain.md`

---

## 0) 先把事件寫成「三欄位」

你只要先補這三欄位，後面所有 pprof/stack 都能對齊：

- **time window**：從第一條到最後一條 `canceling remote connection`（例如 10:12:00–10:18:00）
- **local → remote**：log 裡的連線兩端（哪個 node 在印、remote 是誰）
- **not seen for**：是否接近 ~60s（典型是 `clientPingInterval=15s`、`lastPingThreshold=4*interval≈60s`）

---

## 1) goroutine dump（最低門檻）：用 SIGQUIT 抓「當下卡在哪」

> 適用：你不能打開 pprof、或只能用最少侵入方式。

### 1.1 怎麼抓

- **systemd/journald**：
  - 找到 MinIO PID：`pidof minio` / `ps -ef | grep minio`
  - 送 SIGQUIT：`kill -QUIT <pid>`
  - 去 log 看輸出：`journalctl -u minio -n 2000 --no-pager`（或你的 unit 名稱）

> 注意：SIGQUIT 會把 goroutine dump 印到 stderr（通常會進 journald）。

### 1.2 怎麼判讀（你要找的 signature）

在 time window 內，如果你看到大量 goroutine 卡在這幾類堆疊，通常偏向「對端忙」：

- **RenameData / rename/fsync**
  - `(*xlStorage).RenameData` → `syscall.Rename`/`renameat2`/`fsync`/`fdatasync`
- **Healing**
  - `(*erasureObjects).healObject` → `readAllFileInfo` / `erasure.Heal` / `disk.RenameData`
- **MRF**
  - `(*mrfState).healRoutine` / `healObject` helper
- **grid ping handler starvation**
  - 不一定會直接看到 ping handler；你要看的是：大量 goroutine 被 I/O/鎖拖住，導致 scheduler 不容易準時跑到 `muxServer.ping()` 更新 `LastPing`

（搭配速查）
- `docs/troubleshooting/canceling-remote-connection-stack-signatures.md`

---

## 2) pprof（更準）：用 profile/trace 把「忙在哪裡」量化

> 適用：你能在事件發生時（或重現時）抓 30–60s 的 profile。

### 2.1 抓哪幾個就夠（最小集）

建議只抓三個（30s 以內就能看出方向）：

1) **goroutine**：看是否大量卡在 storage/heal/lock
2) **profile (CPU)**：看 CPU 是否被 encode/heal/crypto/hash 打滿，或被 runtime/GC 吃掉
3) **block / mutex**（若已啟用）：看鎖競爭（metadata lock / ns lock / global state）

> 實務上，`canceling remote connection` 常見是「I/O/鎖/排程」→ ping handler 延遲；所以 goroutine + block/mutex 往往比 CPU 更關鍵。

### 2.2 你在圖上想看到什麼（結論寫法）

- **偏網路**：pprof/stack 沒顯著 I/O/鎖熱點，反而 ss/nstat/NIC counters 顯示 loss/retrans 伴隨。
- **偏對端忙（最常見）**：
  - goroutine 堆在 `RenameData`/`healObject`/`readAllFileInfo`/`fsync`
  - 或 block/mutex 顯示特定鎖高等待
  - 同時間 iostat/await 飆高（尤其 metadata-heavy）

你要在 incident note 裡寫得「可驗證」：

> time window 內 goroutine dump/pprof 顯示大量 goroutine 卡在 `(*xlStorage).RenameData`（rename/fsync）與 `(*erasureObjects).healObject`（HealObject 路徑），同時間 disk await 上升；推測為 I/O/metadata 壓力導致 grid ping handler 延遲，觸發 server 端 ~60s watchdog `canceling remote connection`。

---

## 3) 把「pprof/stack 證據」跟 PutObject/Healing 串成一條最短因果鏈

你最後要能一句話把 chain 說完整（不需要長篇）：

- PutObject 成功但留下 partial → `addPartial()` → `globalMRFState.addPartialOp()`（best-effort）
- MRF/scanner/admin-heal 觸發 `HealObject()` → `(*erasureObjects).healObject()`
- heal/commit 或 PutObject commit 都會落到 `StorageAPI.RenameData()` → `(*xlStorage).RenameData()`（rename/fsync）
- I/O/鎖/排程壓力讓 grid ping handler 沒及時更新 `LastPing` → server watchdog ~60s 斷線 → `canceling remote connection`

對照讀碼頁：
- `docs/trace/putobject-healing-callchain.md`

---

## 4) 常見坑（避免誤判）

- **時間跳動（NTP/chrony）**：`not seen for` 不是 ~60s 時，先排除時鐘跳動。
- **client vs server 兩端 watchdog**：
  - client 端常在 ~30s 沒 pong 就先斷（`ErrDisconnected`）
  - server 端才在 ~60s 沒 ping 印 `canceling remote connection`
- **MRF queue drop**：看到 partial enqueue 不代表一定會 heal；queue 滿會 drop，會導致「洞存在但 heal 沒追上」。

---

## 5) 最小連結索引

- grid codepath：`docs/troubleshooting/canceling-remote-connection-codepath.md`
- stack signatures：`docs/troubleshooting/canceling-remote-connection-stack-signatures.md`
- PutObject/Healing call chain：`docs/trace/putobject-healing-callchain.md`

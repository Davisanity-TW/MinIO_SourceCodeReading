# Troubleshooting：`canceling remote connection`（現場排查 Playbook）

> 這頁把你在 incident 現場最常遇到的那句 log：
>
> `canceling remote connection <...> not seen for <~60s>`
>
> 補成「可以照抄去做」的排查步驟。
>
> 核心重點：這句多半是 **grid streaming mux 的 watchdog** 判定「太久沒看到 ping」而主動斷線；它常是**結果**，不是根因。

延伸閱讀（更完整的 code anchors / root causes）：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/trace/grid-canceling-remote-connection.md`
- `docs/trace/putobject-healing-callchain.md`
- `docs/trace/putobject-healing-xlmeta-anchors.md`

---

## 0) 你要先做的分類（10 秒內）

把事件時間窗內的現象分成三類之一：

A) **I/O 壓力型**（最常見）
- PutObject tail latency 上升、heal/scanner/MRF 活躍、iostat await/%util 飆高
- 這時 `canceling remote connection` 多半是「忙到 ping handler 排不到」

B) **網路/連線品質型**
- 丟包、RTT 飆高、conntrack/NAT 問題、MTU/路由波動
- 這時通常會更早看到 client 端 `ErrDisconnected` / timeout

C) **CPU/排程/GC 型**
- CPU 飆滿、runtime 停頓、goroutine backlog
- 也會讓 ping/pong 被延遲（看起來像網路，但其實是本機排不到）

---

## 1) 先釘 code anchor：這句 log 到底在哪裡印的？（避免猜）

在 MinIO source tree：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 20

# 一般會落在 muxserver.go 的 watchdog / checkRemoteAlive
grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head -n 50

grep -RIn "lastPingThreshold|clientPingInterval" -n internal/grid | head -n 80
```

現場解讀（你要能一句話講清楚）：
- server 端 watchdog 看到 `LastPing` 太久沒更新 → 主動 close streaming mux → 印這句。

---

## 2) 現場最有效的 3 個「同時間窗對照」

### 2.1 對照 healing / scanner / MRF 是否放大

看 code 錨點（你不用立刻看懂全部，只要知道它們代表「背景補洞很忙」）：
```bash
cd /path/to/minio

# MRF
grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go

# scanner applyHealing
grep -RIn "applyHealing\\(" -n cmd/data-scanner.go

grep -RIn "HealObject\\(" -n cmd | head -n 40
```

現場解讀：
- 如果同時間有大量 HealObject：優先懷疑「I/O 壓力 + 背景任務 fan-out」造成 ping handler delay。

### 2.2 對照 PutObject commit/rename 是否變慢

```bash
cd /path/to/minio

grep -n "^func renameData" cmd/erasure-object.go

grep -RIn "RenameData\\(" -n cmd/erasure-object.go cmd/xl-storage.go cmd/storage-interface.go | head -n 80
```

現場解讀：
- `RenameData` 是 metadata-heavy 操作（rename/fsync），磁碟 tail latency 一尖峰就很容易把整體排程拖慢。

### 2.3 對照 OS 層是否真的忙（把「猜」變成「證據」）

如果你在 node 上：
- `iostat -x 1`（看 await/%util）
- `pidstat -dru 1 -p <minio-pid>`

若可以短時間 attach：
- `strace -fp <minio-pid> -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,openat,unlink`（觀察是否卡 syscall）

現場解讀：
- 若 syscall latency 明顯升高，而同時出現 `canceling remote connection`：通常是「本機太忙」不是「網路先壞」。

---

## 3) 你可以直接抄進事件記錄的「判讀句」

- **結論模板（I/O 型最常見）**：
  - 在 healing/MRF/scanner 活躍時間窗內，metadata/rename I/O（`readAllFileInfo`、`RenameData`）造成 goroutine 排程延遲，使 internal/grid streaming mux 的 ping/pong watchdog 逾時，導致 `canceling remote connection`。

- **結論模板（網路型）**：
  - 同時間窗內觀察到 RTT/丟包/連線重置，client 端先出現 `ErrDisconnected` / timeout，server 端隨後 watchdog 印出 `canceling remote connection`；推測為網路品質/中間設備造成的長連線不穩。

---

## 4) Stop condition（你什麼時候可以停止挖？）

你至少要拿到一組能說服人的對照：
- 同時間窗內 `iostat await/%util` 明顯上升（I/O 壓力）
- 或明確的 packet loss/RTT 飆高（網路）
- 或 goroutine dump/pprof 顯示大量卡在 `xlStorage.RenameData` / `readAllFileInfo` / `internal/grid` handler backlog（排程/鎖/GC）

拿到其中之一，就可以先把 `canceling remote connection` 定位成「結果」，接著回頭處理根因（I/O、heal 放大、或網路）。

# Troubleshooting：`canceling remote connection`（在 PutObject / Healing 熱點時出現）

> 目標：把這句 log 從「看起來像網路問題」拉回可操作的排查流程：
> - **它通常代表 grid streaming mux 的 ping/pong 心跳在 deadline 內沒被處理**
> - 在 PutObject / Healing/MRF/scanner 很忙（I/O 或排程壓力）時，這句 log 很容易被放大成「結果」
>
相關 trace/錨點：
- Trace：`docs/trace/putobject-healing-callchain.md`
- Trace：`docs/trace/grid-canceling-remote-connection.md`
- 既有 triage：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`

---

## 0) 先把「這句 log」釘到 code（避免誤解）

在 MinIO source tree（以你線上跑的版本為準）：

- server 端 watchdog：`internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`
  - 條件：`time.Since(LastPing) > lastPingThreshold` → 印出 `canceling remote connection ... not seen for ...` → close
- 閾值：通常 ~60s
  - `internal/grid/grid.go`：`clientPingInterval = 15s`
  - `internal/grid/muxserver.go`：`lastPingThreshold = 4 * clientPingInterval`

快速 grep：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 40
grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go internal/grid/grid.go | head -n 80
```

**判讀重點**
- 這不是「TCP 斷線」的原始原因描述；它是 **應用層心跳超時後主動中止** 的訊號。
- 因此根因常見落在：
  - node 忙到 ping handler 排不到（CPU/排程）
  - 磁碟/檔案系統 tail latency 飆高，導致 goroutine/handler 長時間卡住（I/O）
  - 或真的有網路抖動/丟包/MTU/conntrack 問題（但通常要用證據支持）

---

## 1) PutObject / Healing 互相放大的常見機制（從 code 角度）

### 1.1 PutObject 留下 partial → 進 MRF queue → 背景 HealObject

最常見的「為什麼 PutObject 熱點時，會同時看到 healing/grid 壓力」：

- PutObject 主線：`cmd/erasure-object.go: (erasureObjects).putObject()`
- 若留下缺片/版本不一致：
  - `addPartial()` → `globalMRFState.addPartialOp(...)`（`cmd/mrf.go`）
- MRF consumer：
  - `mrfState.healRoutine(...)` 出隊後呼叫 `z.HealObject(...)`

你要在 source tree 釘死的最短錨點：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go

grep -n "globalMRFState" cmd/*.go | head -n 80

grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go

grep -RIn "HealObject\(" -n cmd/mrf.go | head -n 80
```

### 1.2 Healing 的 heavy point 常是 `RenameData()`（metadata-heavy tail latency 放大器）

不論是 PutObject 的 commit，或 Healing 的寫回，最後都會打到 storage rename/cutover 類操作。

- PutObject：`cmd/erasure-object.go` → `renameData()` / `commitRenameDataDir()`
- Healing：`cmd/erasure-healing.go: (*erasureObjects).healObject()` → `disk.RenameData()`
- 落地：`cmd/xl-storage.go: (*xlStorage).RenameData()`

快速釘死：
```bash
cd /path/to/minio

grep -n "^func renameData" cmd/erasure-object.go

grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go

grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 120
```

**實務判讀**
- 如果你同時看到：`canceling remote connection` + iostat await/%util 尖峰 + healing/MRF 活躍，通常先假設是 **I/O/排程壓力**，再用證據排除網路。

---

## 2) 事件現場：最省時間的 triage 路線（證據導向）

### Step A：確認這個時間窗是不是 healing/MRF/scanner 活躍

1) 看 server log 是否同時間有：
- `heal` / `MRF` / `scanner` 關鍵字
- 大量 `RenameData` 相關 error（依版本訊息不同）

2) 若可以抓 goroutine dump/pprof：
- 堆疊是否大量卡在：
  - `xlStorage.RenameData`
  - `erasureObjects.healObject`
  - `mrfState.healRoutine`
  - `internal/grid/*` 的 mux handler

### Step B：用 host 指標把「忙」定性（I/O vs CPU vs network）

- I/O：`iostat -x 1` 看 `await/%util`
- CPU：`top` / `pidstat -w -p <pid> 1` 看 runq/sched
- network：
  - `ss -s` / `ss -tanp | grep minio` 看大量連線重傳/重置
  - 若環境允許：抓 `tcpdump`/NIC drops/conntrack

**快速結論模板（建議寫在 incident note）**
- 「同時間窗 healing/MRF 活躍（依 X/Y log/pprof 證據），磁碟 await/%util 尖峰（依 iostat），因此 `canceling remote connection` 更可能是 grid ping handler 排程延遲的結果，而非網路先壞。」

---

## 3) 你需要回到 code 時，建議直接對齊這兩張表

- PutObject ↔ MRF ↔ Healing call chain：`docs/trace/putobject-healing-callchain.md`
- grid ping/pong watchdog 錨點：`docs/trace/grid-canceling-remote-connection.md`

（這樣你的筆記可以同時回答：**為什麼會 heal**、**heal 最重在哪**、**為什麼 grid 斷線**。）

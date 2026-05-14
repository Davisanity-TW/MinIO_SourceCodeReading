# Troubleshooting：`canceling remote connection ... not seen for ~60s`（常與 PutObject / Healing I/O 壓力同時出現）

> 目標：把你在 incident 看到的 `canceling remote connection %s not seen for %v` 這類訊息，整理成**可操作**的排查筆記。
>
> 這個 log 來自 MinIO 的 `internal/grid`（peer RPC/mux），不是外部 client 的連線。

---

## 1) 典型訊息長相（範例）

你可能會看到類似：

- `canceling remote connection <peer> not seen for 1m0s`

此訊息通常代表：**某個 peer 的 grid 連線在一段時間內沒有被觀察到「活著」（ping/pong/traffic）**，server 端 watchdog 判定連線僵死而主動切斷。

---

## 2) 來源與閾值（為什麼常是 ~60s）

> 建議先把「log 的真實出處」釘死，避免誤判。

- Log 字串位置：`internal/grid/muxserver.go`
  - `func (m *muxServer) checkRemoteAlive()`
  - `"canceling remote connection %s not seen for %v"`
- 閾值常見 ~60s：
  - `internal/grid/grid.go`：`clientPingInterval = 15 * time.Second`
  - `internal/grid/muxserver.go`：`lastPingThreshold = 4 * clientPingInterval`（= 60s）

快速定位（在你的 minio source workspace）：

```bash
cd /home/ubuntu/clawd/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "clientPingInterval" -n internal/grid | head -n 20

grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go
```

---

## 3) 為什麼它常跟 PutObject / Healing 同時出現（推論 → 驗證）

### 3.1 常見情境（推論）

當叢集出現下列「重 I/O」條件時，remote 端的 goroutine（或 ping handler）可能：

- 卡在磁碟 I/O（高 iowait、rename/fsync/metadata ops 爆量）
- 被 healing/MRF 搶資源（大量讀 xl.meta、RS rebuild、rename 提交）
- goroutine/排程延遲（看起來像「沒有 ping」）

結果就是：**grid watchdog 看到 remote 太久沒有更新活性**，誤判為 dead connection，切斷並重建。

### 3.2 你可以怎麼驗證（可操作）

同一時間窗（同一分鐘）內，對照下面三類訊號：

1) **MinIO log**：是否同時有 healing/MRF/rename/fsync 相關訊息或 stack signature
2) **pprof / goroutine dump**：是否大量卡在 `rename(2) / fsync(2)` 或 healing call chain
3) **OS 指標**：iowait 飆高、磁碟 util 逼近 100%、延遲尖峰

---

## 4) PutObject / Healing 的「可落地」呼叫鏈錨點（用來對齊 stack）

把堆疊釘在「真的會打到磁碟、rename/fsync」的幾個入口：

- PutObject handler：`cmd/object-handlers.go:PutObjectHandler()`
- 寫入主流程：`cmd/erasure-object.go:erasureObjects.putObject()`
- MRF 背景 heal：`cmd/mrf.go:mrfState.healRoutine()`
- HealObject heavy path：`cmd/erasure-healing.go:(*erasureObjects).healObject()`

更完整的「實際函式/檔案/行號」（以特定 commit 驗證）：

- `docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`

---

## 5) 現場快速 triage（10 分鐘內要得到的答案）

### 5.1 先回答：這是「網路問題」還是「remote 忙到回不了 ping」？

- 如果同時看到：
  - healing/MRF/rename/fsync 壓力訊號
  - OS iowait、磁碟延遲明顯上升

  → 優先當作 **remote I/O 壓力導致 grid ping 餓死**（不一定是網路壞）。

- 如果同時看到：
  - 多台 peer 互相大量斷線
  - NIC / switch / MTU / packet loss 指標異常

  → 轉向 **網路層** 排查（但仍要排除 I/O 導致的應用層 timeout）。

### 5.2 你要收集的最小證據集（建議）

- 同時間窗的 MinIO log（含 `canceling remote connection` 前後 1–2 分鐘）
- `pprof/goroutine`（至少一次）
- OS：`iostat -x 1 10` 或等價指標、磁碟 latency/queue depth、CPU iowait

---

## 6) 常見 root causes（按「最容易遇到」排序）

1) **Healing / MRF 造成的 I/O 尖峰**：讀 meta + rebuild + rename/fsync 疊加
2) **磁碟資源不足**：IOPS/latency 不夠、空間不足（導致重試/排隊更嚴重）
3) **對象/版本數膨脹**：metadata fan-out 放大 healing 成本
4) **網路抖動**：packet loss、over-subscription、MTU mismatch（相對少見但要驗）

---

## 7) 下一步：把你的 incident stack signature 加回來

如果你有「當時的 goroutine stack / pprof top」：

- 把 top 5–10 的函式名（含檔案）貼上來
- 我會把它整理成：
  - 對應到 PutObject/Healing 的哪一段
  - 哪幾個 syscalls 最可能是瓶頸（rename/fsync/open/read）
  - 可再收斂的 metrics/trace 位置

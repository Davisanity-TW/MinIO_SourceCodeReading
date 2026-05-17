# Troubleshooting：`canceling remote connection` 與 PutObject/Healing 共振時（訊號/判讀/下一步）

> 目的：把現場常見的「`canceling remote connection` + 寫入變慢/Healing 變熱」整理成 **可快速驗證的訊號**，並把每個訊號對回 **MinIO code anchors**。
>
> 適用情境：
> - 叢集中出現大量 `canceling remote connection`（多半來自 `internal/grid/muxserver.go`）
> - 同時間 PutObject latency 飆高 / HealObject 或 MRF 很忙
> - 你想快速回答：**是 grid 連線本身壞了？還是被 IO/CPU tail latency 拖到 watchdog 觸發？**

延伸閱讀：
- `canceling remote connection` 總頁：`docs/troubleshooting/canceling-remote-connection.md`
- grid code trace：`docs/trace/grid-canceling-remote-connection.md`
- PutObject/Healing 真實函式與呼叫鏈：`docs/trace/putobject-healing-real-functions.md`

---

## 0) 快速結論（你要先站隊的假設）

**最常見（優先假設）：**
- `canceling remote connection` 是 *症狀*，根因是節點忙到 **ping/pong / handler 排不到**（tail latency）
- 共振來源常見是：PutObject rename/fsync + Healing rename/fsync + metadata fan-out

**比較少見但要排除：**
- 真的網路中斷 / MTU / conntrack / TLS reset
- 節點時間跳動（NTP 問題）造成 deadline 判斷異常

---

## 1) 你看到 log 時，先把它對回 grid 哪一段

MinIO 端常見 anchor（不同版本 log 文字一致性很高）：

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80
```

**判讀重點：**
- 這類 log 常表示：muxserver 認為 remote 端不再「活著」或 deadline 超時 → 主動 cancel
- 它不直接告訴你根因（IO/CPU/GC/網路都可能）

---

## 2) 若是 PutObject/Healing 共振，最常見的「三個熱區」

### 2.1 rename/fsync 熱（PutObject & Healing 共用）

**為什麼會影響 grid：**
- rename/fsync 造成 IO queue、journal、metadata lock 變長
- Go runtime / goroutine scheduling 被拖慢 → ping handler 也會被延遲

Code anchors：

```bash
cd /path/to/minio

# PutObject rename/commit
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
grep -RIn "renameData\(" -n cmd/erasure-object.go | head -n 200
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head -n 200

# Healing rename/commit
grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go
grep -RIn "renameData\(" -n cmd/erasure-healing.go | head -n 200
grep -RIn "commitRenameDataDir" -n cmd/erasure-healing.go | head -n 200

# StorageAPI 最終落點（syscall 熱點）
grep -RIn "type StorageAPI interface" -n cmd/storage-interface.go
grep -RIn "RenameData\(" -n cmd/storage-interface.go

grep -RIn "func \\(s \\*xlStorage\\) RenameData" -n cmd/xl-storage.go
```

現場訊號（建議你用來做「站隊」的觀察）：
- 同時間 PutObject latency 變長（尤其尾端 commit）
- iostat/nvme smart/IOPS 沖高 + await 上升
- node 上 goroutine dump 出現大量卡在 `(*xlStorage).RenameData` / `fdatasync` / `renameat2`

### 2.2 readAllFileInfo / metadata fan-out 熱（Healing 前段）

**為什麼會影響 grid：**
- healObject 會 fan-out 讀取大量 meta（N disks × objects）
- 導致 IO + CPU（decode/xl.meta）擴大

Anchors：

```bash
cd /path/to/minio

grep -RIn "readAllFileInfo\(" -n cmd | head -n 60
```

### 2.3 MRF queue / healRoutine 熱（背景修復把壓力維持住）

Anchors：

```bash
cd /path/to/minio

grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go

grep -RIn "HealObject\(" -n cmd/mrf.go | head -n 80
```

**判讀：**
- 若 MRF 一直有工作，表示 partial/failed ops 持續產生，叢集壓力可能進入「自激振盪」

---

## 3) 最小排查流程（不用先猜，先收集 5 個訊號）

> 這段是為了讓你在 incident 當下能快速收斂：到底比較像 IO 壓力、CPU/GC、還是網路。

1) **時間對齊**：`canceling remote connection` 發生的分鐘級時間窗
2) **PutObject**：同窗是否有 PutObject latency 變差（client 端或 MinIO trace）
3) **Healing/MRF**：同窗 healObject / mrf 是否很熱
4) **節點資源**：iowait、disk await、load average、GC pause（若可）
5) **網路面**：是否伴隨大量 reconnect / `ErrDisconnected` / socket reset

如果 (2)(3)(4) 同時成立，優先往 **IO tail latency / rename/fsync 熱區** 收斂。

---

## 4) 你要把「症狀 → 可行動」寫成一行

建議你在事件紀錄裡用這種句型，方便後續回顧：

- 「`canceling remote connection` 在 14:05–14:20 密集出現，與 PutObject p95 上升 + healRoutine 活躍同窗；goroutine dump 顯示大量卡在 `(*xlStorage).RenameData`，推定為 IO tail latency 造成 grid watchdog 觸發。」

---

## 5) 後續要補的（TODO）

- [ ] 補一段：internal/grid ping handler 的具體 handler 名稱與 client/server deadline 參數 anchors（讓你能更精確判斷是「排不到」還是「deadline 太短」）
- [ ] 補一段：把「rename/fsync 熱」對回 ext4/xfs 的典型瓶頸（journal commit / inode lock / barrier）與可觀測指標

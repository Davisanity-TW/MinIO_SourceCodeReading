# Troubleshooting：`canceling remote connection` 事件現場最小採證（goroutine dump / pprof）

> 目標：當你看到 MinIO log 出現
>
> - `canceling remote connection ... not seen for ...`
>
> 或 client/peer 端開始出現 `ErrDisconnected`/RPC timeout 時，用**最少步驟**把「是網路抖動」還是「遠端節點被 I/O/排程卡住」快速分流。
>
> 這頁刻意不寫太多背景敘事，重點是：**現場要留下哪些證據**，以及每個證據能回答什麼問題。

相關讀碼定位（call chain anchors）：
- `docs/trace/putobject-healing-callchain.md`（末段有把 `canceling remote connection` 釘到 `internal/grid` 的 ping/pong watchdog）

---

## 0) 先做兩個判斷（避免第一時間就怪網路）

1) 這條 log 出現的時間窗，是否同時有大量：
- Healing/MRF/scanner 活躍（大量 background I/O）
- rebalance/replication/ILM 等背景任務
- `iostat await/%util` 飆高、或 node load/GC spike

2) 這條 log 是：
- **server 端**印出（通常代表 server 端 ~60s 沒看到 client ping）
- 還是 **client 端**先報 `ErrDisconnected`（常見 ~30s 沒看到 pong 就先斷）

> 實務上很常見的順序是：client 端先斷（~30s）→ server 端稍後才印 `canceling remote connection`（~60s）。

---

## 1) 現場最小採證清單（建議 5 分鐘內完成）

### 1.1 收集基本環境狀態（同一時間窗）

在「出現 log 的那一分鐘」附近記下：
- `minio --version`（或 server banner 版本）
- 節點角色（是 server node 還是 gateway/console）
- 當下活躍背景任務（heal/scan/rebalance）

### 1.2 針對「可能是遠端節點卡住」：抓 goroutine dump

如果你能對出現問題的那台節點打到 `/debug/pprof/goroutine?debug=2`（或用 `mc admin profile` 類功能），優先抓 **goroutine dump**。

理由：
- 你要的是「遠端 node 當下到底卡在哪一層」：grid？object layer lock？erasure I/O？rename/fsync？

#### 方式 A：直接抓 pprof goroutine（常見）

（端點/保護方式依你部署與版本為準；以下是概念示意）

```bash
# 只示意：實際請改成你的 endpoint 與 auth
curl -sS "http://127.0.0.1:9000/debug/pprof/goroutine?debug=2" > goroutines.txt
```

你要在 dump 裡快速找的關鍵字：
- `internal/grid` / `muxserver` / `muxclient`
- `erasureObjects.putObject` / `renameData` / `commitRenameDataDir`
- `erasureObjects.healObject` / `readAllFileInfo` / `RenameData`
- `xlStorage.RenameData` / `fsync` / `renameat`（若有 syscall/stack 資訊）

### 1.3 針對「可能是 I/O 放大」：抓短時間 pprof（CPU / block）

如果你能抓 pprof，建議至少抓：
- CPU profile（30s）
- block profile / mutex profile（若版本/設定允許）

目標是回答：
- CPU 是不是被 RS rebuild/encoding 打滿？
- 還是卡在 mutex/lock（例如 namespace lock、metadata lock）？
- 還是主要時間都在 syscalls（rename/fsync）？

---

## 2) 如何用採證快速分流（判讀口訣）

### A) dump 顯示大量 goroutine 卡在 `internal/grid` 讀寫/等待
- 偏向：對端忙到 ping handler 排隊、或 network 抖動導致 ping/pong 延遲
- 下一步：對齊同時間窗是否有 healing/scanner/rebalance；並看該 node 的 CPU/IO

### B) dump 顯示大量卡在 `xlStorage.RenameData` / `renameData` / `commitRenameDataDir`
- 偏向：底層 FS/磁碟 metadata ops（rename/fsync）被放大 → tail latency 拉高 → grid 心跳跟著超時
- 下一步：同時間窗做 `iostat -x 1`、看 `await/%util`，必要時短時間 `strace` 觀察 rename/fsync latency

### C) dump 顯示卡在 `readAllFileInfo` / metadata fan-out
- 偏向：大量 disk 讀 `xl.meta`、或部分 disk slow/hung → quorum/timeout 拉長
- 下一步：找出慢盤（SMART、dmesg、單盤 latency），並檢查 healing 是否在反覆掃同一批 objects

---

## 3) 事件筆記建議模板（最少要能回答三件事）

1) 這次 `canceling remote connection` 出現時，MinIO 同時間在做什麼？
   - heal/MRF/scanner/rebalance/replication/其他
2) goroutine/pprof 顯示主要卡在哪一層？
   - grid / object layer / erasure I/O / rename commit
3) 你採取了什麼立即緩解措施？
   - 降低 heal scan、暫停 rebalance、隔離慢盤、調整資源、或只是觀察

---

## 4) 快速連回 code anchors（提醒你把「猜測」變成「可驗證」）

如果你要把 incident note 釘到 code（避免事後爭論），用這些 grep：

```bash
cd /path/to/minio

# server 端 watchdog log
grep -RIn "canceling remote connection" -n internal/grid | head

# ping/pong 閾值
grep -RIn "clientPingInterval" -n internal/grid | head
grep -RIn "lastPingThreshold" -n internal/grid | head

# PutObject / Healing 的 commit rename
grep -RIn "commitRenameDataDir" -n cmd | head
grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 80
```

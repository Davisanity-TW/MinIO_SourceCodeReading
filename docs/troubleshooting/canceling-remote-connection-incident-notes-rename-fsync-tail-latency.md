# Troubleshooting：`canceling remote connection`（事件筆記：rename/fsync tail latency 共振）

> 目的：把我在現場遇到的 `canceling remote connection`（MinIO grid RPC）補成 **可以落地排查** 的筆記。
>
> 這頁偏「事件推理 + 現場指令」；更完整的背景/根因分類看：
> - `docs/troubleshooting/canceling-remote-connection-root-causes.md`
> - `docs/trace/grid-canceling-remote-connection.md`

---

## 0) 這句 log 通常在講什麼？

`canceling remote connection` 多數不是「網路真的斷線」，而是 **server 端覺得這條 grid 連線已經不健康**（例如 ping/pong 或 keepalive 沒有在 deadline 內完成），於是主動 cancel。

典型共振場景：
- **PutObject / Healing / MRF** 把磁碟壓到 rename/fsync/metadata tail latency 升高
- node 的 goroutine 排程 / syscalls 卡住 → grid mux 的 ping handler 排不到
- 於是出現 `canceling remote connection`

---

## 1) 先把 log 釘到 code（快速確認你看的版本語意沒跑掉）

> 你只需要做這件事一次：確認訊息是在 `internal/grid` 的哪個檔案/函式。

```bash
cd /path/to/minio

# 1) 字串在哪裡印出來（通常在 mux server / conn watchdog）
grep -RIn "canceling remote connection" internal/grid | head -n 20

# 2) 常一起出現的 health check / deadline 設定
grep -RIn "checkRemoteAlive\(" internal/grid | head -n 50

grep -RIn "clientPingInterval|ping" internal/grid | head -n 80
```

如果你看到的不是 `internal/grid/*`，而是在 `cmd/peer-rest-*`、`cmd/iam-*` 等層，表示你追的版本/分支把訊息搬家了：**先以 grep 的結果為準**。

---

## 2) 最常見的「不是網路」：磁碟 rename/fsync 造成 tail latency

這個模式的特徵：
- `canceling remote connection` 出現的同一時間窗
- 同一台 node（或同一批磁碟）也出現：
  - I/O latency 飆高、`await` 很大
  - 或 put/heal goroutine 卡在 rename/fsync/WriteMetadata
- 之後會連帶造成：MRF queue 增長、healing backlog、甚至更多 put timeout

### 2.1 PutObject 端：rename/fsync 常見落點 anchors

把 syscall 對回 Go code：

```bash
cd /path/to/minio

# PutObject 主線（寫入最後都會碰 rename/commit）
grep -RIn "func (er erasureObjects) putObject" cmd/erasure-object.go

grep -RIn "^func renameData" cmd/erasure-object.go

grep -RIn "commitRenameDataDir" cmd/erasure-object.go | head -n 50

# StorageAPI.RenameData interface / xlStorage 實作
grep -RIn "RenameData\(" cmd/storage-interface.go

grep -RIn "func \(s \*xlStorage\) RenameData" cmd/xl-storage.go
```

### 2.2 Healing 端：寫回 + rename 的落點 anchors

```bash
cd /path/to/minio

# healObject 主流程
grep -RIn "func (er \*erasureObjects) healObject" cmd/erasure-healing.go

# 寫回 xl.meta / commit（名稱跨版本略有差異，但 grep 很好用）
grep -RIn "writeAllDisks\(|writeUniqueFileInfo" cmd/erasure-healing.go | head -n 80

grep -RIn "RenameData\(" cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 120
```

---

## 3) 現場最小排查流程（不需要先下結論）

### 3.1 先做「時間對齊」：log ↔ I/O ↔ healing/put

1) 在出問題 node 上抓出 `canceling remote connection` 的時間戳
2) 同一時間窗（±2~5 分鐘）觀察：
   - iostat / node-exporter disk latency
   - MinIO 的 healing / MRF 指標是否跳升
   - 是否有大量 `rename`/`fsync` 相關 stack

如果你要從 pprof/stack 直接抓 rename/fsync：
- goroutine stack 常見會落在 `xlStorage.RenameData` / `os.Rename` / `syscall.Fdatasync`（實際以版本為準）

### 3.2 快速判斷「是單點磁碟」還是「整台 node 都慢」

- **單顆盤慢**：通常會伴隨特定 mount / 特定 disk 的 await 飆升
- **整台慢**：CPU steal / memory pressure / filesystem 卡住（例如 journal、metadata storm）

下一步通常是：
- 降低 healing 併發（或暫停 healing）觀察 grid disconnect 是否下降
- 或針對最慢盤做替換/隔離，確認 tail latency 恢復後 grid disconnect 是否跟著消失

---

## 4) 跟 MRF / Healing backlog 的連動（為什麼會越來越嚴重）

當 put 因為 disk 慢而留下 partial：
- `erasureObjects.addPartial` → `mrfState.addPartialOp` enqueue
- 背景 `mrfState.healRoutine` 會拉起 heal

若 healing 也同樣需要大量 rename/fsync/metadata：
- tail latency 更高 → grid ping 更容易超時 → `canceling remote connection` 更頻繁
- 形成 feedback loop：disconnect → retries → 更高負載 → 更慢

Anchors（把 PutObject → partial → MRF → heal 釘死）：

```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "func (m \*mrfState) addPartialOp" cmd/mrf.go

grep -n "func (m \*mrfState) healRoutine" cmd/mrf.go

grep -RIn "func (z \*erasureServerPools) HealObject" cmd | head -n 40

grep -RIn "func (er \*erasureObjects) healObject" cmd | head -n 40
```

---

## 5) 這頁的 stop condition（你做到哪裡就算完成）

你不需要一次找出最終 root cause；但至少要能回答：

- 這次 `canceling remote connection` 發生的時間窗內，**node 是否同時有明顯 I/O tail latency**？
- 若有，卡點更像：
  - PutObject rename/fsync？
  - Healing writeback/rename？
  - 或兩者同時？
- 你用 grep anchors 能在 code 上指出：
  - log 的來源（`internal/grid`）
  - I/O 的落點（`xlStorage.RenameData` / `healObject` / `putObject`）

做到上面三個，就已經足夠把「猜測」變成「可驗證的假設」。

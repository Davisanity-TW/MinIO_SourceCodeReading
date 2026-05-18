# Troubleshooting：`canceling remote connection`（常見根因：I/O latency / rename-fsync stall / healing 壓力）

> 目標：把你在 MinIO production 看到的：
> - `canceling remote connection ...`（grid / peer connection 被 server 主動取消）
> - 同時間 PutObject latency / Healing / MRF queue 飆高
>
> 轉成一頁式「先判斷 → 再收斂 → 最後落到 code 錨點」的排查筆記。
>
> 關聯讀碼：
> - `docs/trace/grid-canceling-remote-connection.md`
> - `docs/trace/putobject.md`
> - `docs/trace/healing.md`

---

## 1) 先把現象分類：是網路先壞？還是 scheduler/IO 先卡？

### A. 「真的像網路問題」的特徵
- 只有部分 nodes 互相不通（同時 ping/conntrack/MTU 有異常）
- 服務端 log 先出現連線中斷/重連，再出現 `canceling remote connection`
- NIC/driver error、`dmesg` 有 link flap、或 kube CNI 有 drop

### B. 「其實是 I/O / runtime 壓力」的特徵（更常見）
- 同時看到：PutObject latency、healing/MRF 活躍、或 `.minio.sys/tmp` 大量寫入
- pprof/stack 有大量 goroutine 堆在 storage 層（rename/fsync/open/read）
- node 的 load average 不一定高，但 **iowait** 高 / disk latency 飆
- `canceling remote connection` 大量出現在「repair/restore/回復一顆盤」那段時間

> 經驗法則：`canceling remote connection` 在 healing/MRF 很忙時大量出現，常常不是網路先壞，而是 **server 端處理 ping/pong / handler 的 goroutine 排不到時間片**。

---

## 2) 現場檢查（10 分鐘內能做完）

### 2.1 先抓同一時間窗的 3 類指標/資料
- (1) **Grid/peer 相關 log**（含 `not seen for ...` / reconnect / cancel）
- (2) **I/O 指標**（node-level）：disk util、await、iowait、queue depth
- (3) **MinIO 內部背景活動**：healing/scanner/MRF 是否在跑、是否 retry、是否 queue drop

### 2.2 立刻能縮小範圍的觀察點
- `.minio.sys/tmp` 寫入量是否暴增？
  - 若是：通常對應 PutObject commit / healing writeback
- 是否剛發生 disk offline → online（或換盤/回復）？
  - 若是：`healFreshDisk()` / auto drive healing 很可能正在掃 + rebuild
- MRF queue 是否掉資料（drop）？
  - 若是：表示當下壓力大到「補洞 enqueue 都 best-effort 丟棄」

---

## 3) 常見「I/O 壓力 → grid 被 cancel」的 3 條路徑

### 3.1 PutObject 尾端卡在 rename/fsync（client latency 飆，後面還可能留下 partial）
- 現象：PutObject latency 尾端變長，`.minio.sys/tmp` 有大量暫存資料
- 讀碼錨點：
  - `cmd/erasure-object.go`：`renameData(...)` / `commitRenameDataDir(...)`
  - `cmd/xl-storage.go`：`(*xlStorage).RenameData(...)`

### 3.2 Healing / MRF 補洞把磁碟打滿（同時 grid 心跳跟不上）
- 現象：`canceling remote connection` + healing 很忙 + 讀寫量暴增
- 讀碼錨點：
  - `cmd/mrf.go`：`(*mrfState).healRoutine(...)`（MRF consumer）
  - `cmd/erasure-healing.go`：`(*erasureObjects).healObject(...)`（RS rebuild + writeback）
  - `.minio.sys/tmp/<tmpID>/...` → `StorageAPI.RenameData(...)`

### 3.3 scanner 做 deep scan/bitrot（metadata + data 讀取扇出）
- 現象：CPU 不一定高，但 disk read/metadata ops 爆量
- 讀碼錨點：
  - `cmd/data-scanner.go`：`(*scannerItem).applyHealing(...)`

---

## 4) 快速 grep pack（把 log 現象釘回 code）

> 以 workspace `/home/ubuntu/clawd/minio` 為例。

```bash
cd /home/ubuntu/clawd/minio

# PutObject commit/rename
grep -RIn "commitRenameDataDir" -n cmd | head
grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "func (s \*xlStorage) RenameData" -n cmd/xl-storage.go

# Healing/MRF
grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go

# scanner -> HealObject
grep -RIn "func (i \*scannerItem) applyHealing" -n cmd/data-scanner.go
```

---

## 5) 你要在 incident note 寫清楚的最小集合（避免事後追不回來）

- 發生時間窗（含 timezone）、影響範圍（哪些 nodes / 哪些 buckets）
- 同時間是否：
  - 有 disk offline/online
  - healing/scanner/MRF 活躍（含是否 retry、是否 queue drop）
  - `.minio.sys/tmp` 寫入量明顯升高
- node I/O 指標：await/iowait/util（對齊同時間窗）
- pprof/stack（若可取得）：是否大量卡在 rename/fsync/readAllFileInfo

> 有了這些，後面才有辦法把 `canceling remote connection` 從「像網路」收斂到「其實是 storage/routine 壓力」。

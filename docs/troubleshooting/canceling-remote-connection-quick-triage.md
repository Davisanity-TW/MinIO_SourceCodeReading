# Troubleshooting：`canceling remote connection` 快速排查清單（MinIO）

> 目標：當你在 MinIO log 看到大量 `canceling remote connection`（grid / internode）時，用「先分流、再下鑽」的方法在 10–30 分鐘內把方向收斂。
>
> 這個錯誤訊息本身**不等於網路壞**。在多數事故裡，它更像是「某個 node/handler 長時間沒處理 ping/pong 或 RPC」的症狀；根因常見是 **I/O 壓力、CPU/GC、goroutine backlog**，以及 *PutObject/Healing/MRF* 的負載共振。

關聯頁：
- Trace：`docs/trace/putobject.md`（PutObject rename/commit 熱點）
- Trace：`docs/trace/healing.md`（Healing/MRF → HealObject → `.minio.sys/tmp` → `RenameData()`）
- Troubleshooting：`docs/troubleshooting/canceling-remote-connection-root-causes.md`

---

## 0) 先做「快速分流」（15 分鐘內要完成）

把 incident 當下分成三類（你只要先判對類別，後面就不會浪費時間）：

### A. 真正的網路/連線問題（少數但要快）
常見徵象：
- 同時出現 `connection reset by peer`、`broken pipe`、TLS handshake error、packet loss
- 同一組 node pair 在**低負載**也會重現
- system 層面看到 NIC flap / switch errors

你要先抓：
- node 間 RTT、packet loss（最好雙向）
- kube/host network events（CNI、conntrack）

> 若 A 成立：先處理網路；其他排查先暫停。

### B. I/O 壓力導致的「grid 心跳跟不上」（非常常見）
常見徵象：
- 同時看到 PutObject latency 變長、disk latency 飆升
- `.minio.sys/tmp` 寫入暴增
- healing/MRF/scanner 活躍

優先看：
- 單顆 disk latency / util / queue depth
- pprof：大量 goroutine 卡在 fsync/rename/readDir

### C. CPU/GC/排程壓力導致 handler 飢餓（也很常見）
常見徵象：
- CPU 接近飽和或 throttling（容器/主機）
- Go GC time 上升、STW spikes
- goroutine 數暴增（尤其 net/http / grid / erasure read/write）

優先看：
- CPU throttling / load average
- Go runtime 指標（若有暴露）：gc pause、heap、goroutines

---

## 1) 先對齊「同時間還發生什麼」（把關聯拉出來）

把 `canceling remote connection` 的時間窗（例如 5–10 分鐘）對齊：
- **PutObject** QPS/latency
- **Healing/MRF**（是否 spike、是否有 retry）
- **disk**：latency/util，是否某幾顆盤特別差
- **node**：CPU/Memory/GC

如果你看到它跟以下任一項同步，很高機率根因不在網路：
- PutObject 尾端 commit（rename/fsync）變慢
- Healing 的 `erasure.Heal()` 或 `RenameData()` 變慢
- 某顆盤 intermittently timeout（造成 read quorum 勉強過、後面一直補洞）

---

## 2) 最有效的「程式碼錨點」（用來把現象對回 call chain）

> 你不需要在 incident 期間完整讀碼；你只要知道「卡住時會卡在哪幾個函式」。

### PutObject（寫入成功/留洞/rename commit）
- `cmd/object-handlers.go`：`PutObjectHandler`
- `cmd/erasure-object.go`：`(er erasureObjects) putObject()`
- `cmd/erasure-object.go`：`renameData(...)` / `commitRenameDataDir()`
- `cmd/xl-storage.go`：`(s *xlStorage) RenameData(...)`

### Healing/MRF（補洞/重建/rename commit）
- `cmd/mrf.go`：`(m *mrfState) healRoutine(...)`（MRF consumer）
- `cmd/erasure-healing.go`：`(*erasureObjects) healObject(...)`
  - `readAllFileInfo(...)`（metadata fan-out）
  - `erasure.Heal(...)`（RS reconstruct）
  - `disk.RenameData(...)`（把 `.minio.sys/tmp` commit 成正式路徑）

> 你只要能把 incident 的 I/O 圖（讀/寫/rename/fsync）對到這些點，後續就能針對性 profile。

---

## 3) 現場操作建議（順序）

1) **先確認是否同時有 healing/MRF/scanner 在跑**
   - 若有：先把排查重心放在 I/O 與 `RenameData()` / `.minio.sys/tmp`。

2) **抓 pprof/trace（如果環境允許）**
   - 看 goroutine 堆疊是否集中在：
     - `RenameData` / `renameat2` / `fsync`
     - `readAllFileInfo` / `ReadFile` / `readdir`
     - `erasure.Heal`

3) **找出「最差的那幾顆 disk」**
   - 很多事故不是整體吞吐不足，而是少數盤 latency 長尾拖垮。

4) **把 `canceling remote connection` 當成「資源飢餓」訊號來解讀**
   - 先確認 node 是否被 I/O wait 或 CPU throttling 壓住。

---

## 4) 你最後應該在 incident note 留下的最小資訊集

- 發生時間窗、影響範圍（哪些 nodes / pools / sets）
- 同時間 PutObject QPS/latency 變化
- 是否有 healing/MRF 活躍（以及 queue / retry / drop 跡象）
- Top 3 disk latency（含最差盤）
- pprof/stack 是否顯示 `RenameData`/`fsync`/`readAllFileInfo` 集中

> 有了這組資料，後續要寫「可重現/可驗證」的根因分析會快非常多。

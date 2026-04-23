# Field Notes：`canceling remote connection`（我實際遇到的現場筆記模板 + 常見落點）

> 目的：把我現場真的遇到的 `canceling remote connection` 類型訊息，整理成「可直接照著跑」的排查筆記頁。
>
> 這頁刻意偏 *實戰流程*：先把時間窗、同時期背景任務（healing/scanner/rebalance）、以及 I/O/GC/pprof 對齊；再回頭用 code anchor 佐證。

延伸閱讀（同 repo）：
- 主頁：`docs/troubleshooting/canceling-remote-connection.md`
- 快速 triage：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- symptom → cause：`docs/troubleshooting/canceling-remote-connection-symptom-to-cause.md`
- code anchors：`docs/troubleshooting/canceling-remote-connection-codepath.md`
- 與 PutObject/Healing 的關聯：`docs/trace/putobject-healing.md`

---

## 1) 你看到的訊息長什麼樣？（先把原始 log 釘住）

我現場最常遇到的核心字串就是：

- `canceling remote connection`

通常會跟「多久沒看到 ping」綁在一起（不同版本/格式可能略有差）：
- `... not seen for ...`

### 1.1 先做兩個基本紀錄（不然後面很難對齊）

在 incident note 一開始就固定寫：
- **T（時間窗）**：例如 `T = 2026-04-23 21:57~22:10 (Asia/Taipei)`
- **哪兩個節點之間**：`nodeA -> nodeB`（最好含 IP/hostname）
- **同時間窗是否有 healing/scanner**：
  - `mc admin heal ...` 有沒有在跑？
  - console/alert 有沒有顯示 background healing？
  - `mrf`（Most Recently Failed）queue 是否活躍？

> 直覺：這類 log 很容易被誤判成「網路壞了」。但我實際遇到過的案例裡，更多是 **節點忙到 ping handler 排不到**（I/O/GC/metadata ops）導致的 watchdog 斷線。

---

## 2) 我用的最小排查順序（先判斷是「網路」還是「資源壓力」）

### 2.1 先看同時間窗：I/O latency / disk busy 有沒有尖峰

（在 node 上）
- `iostat -x 1`：看 `await`、`svctm`、`%util`
- `pidstat -d 1 -p $(pidof minio)`：看 minio 進程是否有大量 block I/O

判讀（我實務上最常用的三個訊號）：
- `await` 飆高 + `%util` 幾乎 100%：偏向 disk bottleneck
- 大量 `mkdir/rename/fsync` 類型 metadata 壓力（見下節 pprof/trace）
- 某一顆 disk 特別慢（單顆 device 的 await 很突出）→ healing/rename 很容易被拖死

### 2.2 再看 goroutine/pprof：是不是卡在 rename / fsync / xl.meta fan-out

我會優先找三種 stack pattern：

1) **Healing heavy path**
- `(*erasureObjects).healObject` → `erasure.Heal` → `RenameData`

2) **PutObject commit heavy path**
- `renameData` / `commitRenameDataDir` → `(*xlStorage).RenameData`

3) **metadata fan-out**
- `readAllFileInfo`（大量讀 `xl.meta`）

對應的 code anchors（用 grep 固定錨點，避免行號漂移）：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head

grep -RIn "^func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go cmd/*.go | head

grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go
```

> 我自己的經驗：只要 healing/renameData/RenameData 這段 tail latency 被拖長，grid streaming mux 的 ping/pong 就很容易超時，最後印出 `canceling remote connection`。

---

## 3) 把「為什麼突然開始 heal」對齊：PutObject → partial(MRF) → HealObject

如果同時間窗也看到：
- PutObject latency 變差、或大量 PutObject
- 或某些 disks 偶發 offline/timeout

我會立刻用下面這條最短鏈確認是不是 **quorum 過但留下洞**：

- PutObject：`erasureObjects.putObject()` 在 commit 後
  - offline disk / versions disparity → `addPartial()` / `globalMRFState.addPartialOp()`
- MRF consumer：`mrfState.healRoutine()`
  - 出隊後呼叫 `HealObject()`
- Healing：`erasureObjects.healObject()`
  - `readAllFileInfo` → `erasure.Heal` → `RenameData`

對應的錨點（同樣用 grep 釘死）：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
```

---

## 4) 我在事件筆記會固定收集的欄位（讓後續可回溯）

- 版本資訊：
  - MinIO `RELEASE.*` 或 `git rev-parse --short HEAD`
- 觸發時間窗：`T ± 5m`
- 兩端節點：`src node` / `dst node`
- 同時間窗的背景任務：
  - healing（admin/scanner/MRF）
  - rebalance
  - scanner/metacache rebuild
- 資源數據：
  - iostat（await/%util）
  - load / steal / CPU saturation
  - GC（若可：heap profile / goroutine dump）
- 事件特徵：
  - 是單一 peer 反覆斷，還是整群互斷？
  - 是否伴隨 `ErrDisconnected` / `grid` RPC timeout / `context deadline exceeded`

---

## 5) 我自己的判讀結論（寫 incident note 時的「一句話」模板）

> 在本次時間窗內，`canceling remote connection` 更像是 **節點資源壓力導致 ping handler 延遲** 的結果（常見來源：healing/rename/fsync/metadata ops），而非網路先壞；需優先對齊 healing/MRF/scanner 活躍度與磁碟 I/O await，並在 `xlStorage.RenameData` / `readAllFileInfo` / `erasureObjects.healObject` 堆疊上驗證。

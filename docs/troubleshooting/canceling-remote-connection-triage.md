# Troubleshooting：`canceling remote connection`（快速排查筆記）

> 目標：把你在現場最常看到的錯誤訊息 `canceling remote connection`（MinIO grid/REST）整理成一頁「先做什麼、看什麼、怎麼收斂」的 triage。
>
> 相關延伸（更細）：
> - `docs/troubleshooting/canceling-remote-connection-decision-tree.md`
> - `docs/troubleshooting/canceling-remote-connection-root-causes.md`
> - `docs/troubleshooting/canceling-remote-connection-field-checklist.md`
> - `docs/trace/grid-canceling-remote-connection.md`（code path/呼叫鏈）
> - `docs/trace/putobject.md` + `docs/trace/healing.md`（PutObject/MRF/Healing 會與此訊息共振）

---

## 0) 先釐清你看到的是哪一種「超時」

`canceling remote connection` 本質上是：**某個 remote connection（跨節點/跨磁碟/跨 goroutine 的 grid 通道）被判定「太久沒看到對方」或「心跳/回應沒更新」，於是本端取消**。

實務上最常見的兩大類：

1) **真的網路層問題**
- packet loss / jitter / MTU / NIC reset / conntrack
- kube overlay/iptables 問題

2) **其實是本端忙到「處理不了 ping/pong 或讀寫」**（看起來像網路斷）
- 磁碟 I/O latency 飆高（rename/fsync、metadata storm）
- CPU 飆高 / throttling / GC pause
- goroutine backlog（worker 被塞住）

> 你要的不是「背原因」，而是 **用 3~5 個觀察點快速把這兩大類分開**。

---

## 1) 30 秒快篩：同時看 3 張圖/3 個指標

### A) CPU / throttling
- node CPU 使用率是否接近飽和？
- k8s：看 `cpu throttling`（CFS throttling）是否跳高

### B) 磁碟 I/O latency
- `await` / `svctm`（iostat）
- 99p fsync/rename latency（若你有 blk/io trace）

### C) MinIO 內部壓力來源（把網路因素先放一邊）
- Healing / scanner / MRF queue 是否同時在跑
- `mrf queue drop`（代表補洞佇列被塞爆，會拖尾巴）

如果 B/C 任一個明顯異常，**優先當成 I/O/排程問題**，不要一開始就去調 MTU。

---

## 2) 常見「共振組合」與解釋（現場最有用）

### 組合 1：`canceling remote connection` + PutObject latency 飆高
高機率：
- PutObject 尾端卡在 `rename/fsync/metadata`（tmp → commit）
- 造成 goroutine backlog，grid ping/pong handler 也被延遲

建議對照 trace：
- `docs/trace/putobject.md`（`renameData()` / `commitRenameDataDir()` / `StorageAPI.RenameData()`）

### 組合 2：`canceling remote connection` + healing/MRF 很活躍
高機率：
- MRF/Healing 在做 RS 重建：大量讀（readers）+ 寫回（writers to `.minio.sys/tmp`）
- I/O 壓力上來後，grid connection 變得「像是對方消失」

建議對照：
- `docs/trace/healing.md`（`erasure.Heal()` → `disk.RenameData()`）
- `docs/troubleshooting/mrf-queue-drop.md`

### 組合 3：`canceling remote connection` + 明顯 packet loss / NIC reset
才優先走網路線：
- 查 MTU（尤其 VXLAN/Calico/Flannel）
- 查 conntrack / kube-proxy / node kernel log

---

## 3) 快速收斂 checklist（你可以直接照順序跑）

1) **同時段**是否有 healing/scanner/MRF 事件？
   - 有：先當成 I/O/排程壓力引起的「假網路」

2) 查磁碟延遲：
   - iostat / node-exporter disk latency
   - 看是否有少數幾顆盤特別慢（尾端拖累整體）

3) 查 CPU throttling / load：
   - 如果是容器：確認 request/limit 是否太緊

4) 如果上述都正常，才查網路：
   - packet loss / MTU mismatch / NIC errors

5) 最後才做「調參」：
   - 不要在根因不明時先改 timeout（容易把問題埋更深）

---

## 4) 你要補到 incident note 的最小資料集

- 發生時間窗（start/end）
- 同時段：PutObject latency / healing / MRF queue 指標
- node CPU throttling、load
- disk I/O latency（最好 95/99p）
- 是否伴隨特定 disk offline/online 或 heal fresh disk

> 只要把這些收集齊，後面不管是走 code trace 還是走 infra 排查，都能很快把責任面收斂。

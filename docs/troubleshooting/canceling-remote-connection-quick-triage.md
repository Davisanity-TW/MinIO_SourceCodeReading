# canceling remote connection：快速分流（網路 vs I/O/背景任務）

> 用途：你在現場只看到這句 log：
>
> `WARNING: canceling remote connection A:9000->B:9000 not seen for 1m2.3s`
>
> 想在 **10–15 分鐘內**先把方向分成「偏網路」或「偏對端忙（I/O/背景任務/GC）」。
>
> 更完整背景與 code anchors：
> - `docs/troubleshooting/canceling-remote-connection.md`
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`
>
> （補）若同時間窗也有 PutObject latency 變差、或 healing/scanner/MRF 明顯活躍，建議直接一起對照：`docs/trace/putobject-healing.md`（PutObject partial → MRF → HealObject → `RenameData()` 的 I/O 共振鏈）。

---

## 0) 先固定三個欄位（每次 incident 都照抄）
- **time window**：`T ± 5m`
- **local->remote**：`A:9000 -> B:9000`（A = 印 log 的節點；B = 被 cancel 的對端）
- **not seen for**：`~60s`（多數版本是 `lastPingThreshold = 4 * clientPingInterval = 4 * 15s`）

> 若 `not seen for` 明顯不是 ~60s：優先把 **時鐘/NTP 跳動** 納入排查（`time.Since(time.Unix(LastPing,0))` 會受系統時間回撥/校時影響）。

---

## 1) 10 分鐘三件套（最省時間、最常有效）

### 1.1 local 節點：看 TCP retrans/RTO（偏網路）
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```
- `retrans` / `rto` 明顯上升：偏 **網路/CNI/conntrack/MTU**

### 1.2 remote 節點：看磁碟 latency（偏 I/O/資源）
```bash
iostat -x 1 3
```
- `await` 高、`%util` 高：偏 **I/O 壓力**（常見共振：healing/scanner/MRF/rebalance）

### 1.3 任一節點：看 MinIO internal trace 的 grid 熱點（偏「誰把 grid 拖慢」）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```
- `grid.*` duration 明顯拉長：偏 **對端忙/handler 排隊**（不是單純 TCP 立刻斷）

---

## 2) 判讀小抄（粗但很好用）
- **retrans/RTO 明顯**、但 remote I/O 不高 → 先查：MTU、CNI drop、conntrack、LB/中間設備 idle timeout
- **retrans 不高**，但 remote I/O 高、且同窗有 healing/scanner/MRF → 先查：healing 的 I/O 點（`erasure.Heal` / `RenameData`）、scanner、MRF queue
- 三個都不明顯 → 把 **NTP/時鐘跳動** 放回優先序（同窗是否有 chrony step/slew）

---

## 3) 最短「因果鏈」模板（incident note 可直接貼）
> 同時間窗（T±5m）觀察到：healing/scanner/MRF 活躍 + disk await/%util 尖峰；推測 I/O/排程壓力導致 grid streaming mux 心跳（LastPing）更新延遲，觸發 `checkRemoteAlive()` 印出 `canceling remote connection ... not seen for ~60s`。

對照讀碼：
- `internal/grid/muxserver.go: (*muxServer).checkRemoteAlive()`
- `cmd/erasure-healing.go: (*erasureObjects).healObject()`（`erasure.Heal` + `RenameData`）
- `cmd/mrf.go: (*mrfState).healRoutine()`（若是 PutObject partial → MRF）

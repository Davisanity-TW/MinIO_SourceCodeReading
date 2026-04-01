# Field Checklist：`canceling remote connection`（30 分鐘內把方向分對）

> 這頁是給「值班現場」用的精簡版：只保留你在 30 分鐘內最需要做的判斷與蒐證。
> 深入讀碼與完整背景請看：
> - `docs/troubleshooting/canceling-remote-connection.md`
> - `docs/troubleshooting/grid-errdisconnected.md`
> - `docs/trace/putobject-healing-callchain.md`（PutObject/MRF/Healing 與 grid 共振）

---

## 0) 先把一行 log 拆成 3 個欄位（不拆就很難查）
把原文抄下來：

```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```

固定拆成：
- **time window**：`T ± 5m`
- **local->remote**：`10.0.0.10:9000 -> 10.0.0.11:9000`
- **not seen for**：`1m2.3s`（多數版本≈60s）

> `local` = 印 log 的這台；`remote` = 被判定「心跳沒看到」的那台。

---

## 1) 最便宜的「三件套」蒐證（60–120 秒內做完）

### 1.1 local：TCP retrans/RTO（判斷偏網路還是偏資源）
在 **local** 節點：
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 200
```
判讀：
- retrans / rto 明顯 → 先偏 **網路/CNI/MTU/conntrack/中間設備 idle timeout**
- retrans 不明顯 → 先偏 **remote 忙/IOwait/GC/背景任務**（ping handler 來不及跑）

### 1.2 remote：磁碟 latency（最常見共犯）
在 **remote** 節點：
```bash
iostat -x 1 3
```
判讀：
- `await` 高、`%util` 接近 100% → 先把它當成 **I/O 壓力** 事件處理

### 1.3 任一節點：MinIO internal trace（抓同時間最熱的 grid handler）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

---

## 2) 10 分鐘判斷樹（方向分對就贏一半）

### A) 偏「網路/傳輸層」的典型樣子
- `ss -ti` 看到 retrans/RTO 上升
- remote 的 `iostat` 不一定高
- remote 不是固定同一台（remote 漂移）

下一步優先檢查：
- **K8s/CNI MTU 不一致**（overlay/VXLAN/Geneve）
- **conntrack table 壓力/滿載**
- **中間設備 idle timeout**（LB/NAT/Firewall）

### B) 偏「對端忙（I/O/GC/背景任務）」的典型樣子
- retrans 不明顯
- remote 的 `iostat` 顯示 `await/%util` 尖峰
- 同時間窗 healing/scanner/rebalance/MRF 活躍（log/trace/metrics 任一成立）

下一步優先釘死共振源：
- PutObject → partial → **MRF queue** → HealObject
- scanner applyHealing → HealObject
- admin heal（`mc admin heal`）→ HealObject

（讀碼 anchors）
- PutObject：`cmd/erasure-object.go`（`addPartial()`、`renameData()`、`commitRenameDataDir()`）
- MRF：`cmd/mrf.go`（`addPartialOp()`、`healRoutine()`）
- Healing：`cmd/erasure-healing.go`（`(*erasureObjects).healObject()`、`erasure.Heal()`、`RenameData()`）

---

## 3) 在你跑的版本把 code anchors 釘死（避免 master/RELEASE 差異）

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "clientPingInterval" -n internal/grid | head
grep -RIn "lastPingThreshold" -n internal/grid | head

grep -RIn "checkRemoteAlive" -n internal/grid | head
grep -RIn "LastPing" -n internal/grid | head
```

---

## 4) 寫 incident note 的最小模板（直接照抄）

- 時間窗：`T ± 5m`
- 事件：`canceling remote connection A:9000->B:9000 not seen for ~60s`
- local 節點 `ss -ti` 摘要：`retrans=<...> rto=<...>`
- remote 節點 `iostat -x` 摘要：`await=<...> util=<...>`
- 同時間背景任務：`healing/scanner/rebalance/MRF`（有/無，附 trace/log 關鍵字）

> 目的：讓你下一次回頭看（或交接給別人）時，能快速回答「這次比較像網路」或「比較像 I/O/背景任務」。

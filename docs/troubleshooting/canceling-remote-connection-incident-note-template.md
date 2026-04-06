# Incident Note Template: `canceling remote connection`（可直接照抄）

> 目的：把你在現場遇到的一行 log，轉成後續可以追的「最小蒐證包」與「可對齊的 call chain」。
>
> 適用：MinIO server log 出現：
> `WARNING: canceling remote connection <local>:9000-><remote>:9000 not seen for <~60s>`

---

## 1) 原始 log（務必原樣貼上）

```
<貼上原始那一行（不要改）>
```

### 1.1 抽出三個欄位（後面所有查詢都靠它）
- **time window**：`YYYY-MM-DD HH:mm:ss ± 5m`（含 timezone）
- **local->remote**：`<localIP>:9000 -> <remoteIP>:9000`
- **not seen for**：`<duration>`（多數版本≈`~60s`，對應 server-side watchdog）

---

## 2) 10 分鐘內「先分方向」的最小蒐證包（網路 vs 對端忙）

> 原則：同一時間窗（T±5m）只要拿到下面 3 份資料，通常就能先把方向分對。

### 2.1 local 節點（印出 log 的那台）：TCP retrans/RTO
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```
- 如果 retrans/RTO 明顯上升：先偏 **網路/CNI/MTU/conntrack**。
- 如果 retrans 幾乎沒有：更像是 **remote 太忙（I/O/CPU/GC）** 造成 ping handler 跑不動。

### 2.2 remote 節點（被 cancel 的那台）：磁碟 latency
```bash
iostat -x 1 3
```
- 若 `await` 高、`%util` 接近 100%：先偏 **I/O 壓力**。

### 2.3 任一節點（若可）：MinIO internal trace（抓 grid 熱點）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```
- 目的：把「grid 斷線」落到「哪個 grid handler 在變慢/被打爆」。

---

## 3) 同時間窗背景任務（最常見共振源）

在 **remote 節點**，同時間窗做關鍵字關聯（擇一即可）：

### 3.1 systemd/journald
```bash
journalctl -u minio -S "5 min ago" -U "5 min" \
  | egrep -i 'heal|healing|mrf|scanner|rebalance|drive.*offline|disk.*offline' \
  | tail -n 200
```

### 3.2 container logs / 集中式 log
- 用 remote node/pod 為條件，查同時間窗：`heal|healing|mrf|scanner|rebalance`。

---

## 4) 寫 incident note 時的「最短因果鏈」段落（避免把因果寫反）

> 你可以直接把下面這段貼到工單裡，再把 `<...>` 換成你這次蒐證到的內容。

- 在 `T±5m`（`<time window>`）觀察到：`canceling remote connection <local->remote> not seen for <duration>`。
- 同時間窗：
  - TCP retrans/RTO：`<低/高>`（見 `ss -ti` 摘要）
  - remote 磁碟 await/%util：`<低/高>`（見 `iostat -x` 摘要）
  - 背景任務：`<healing/scanner/rebalance/MRF 有/無>`（見 log/trace）

（若偏 I/O/背景任務）推定最短鏈：
- PutObject quorum 過但留下 partial → MRF/scanner 觸發 `HealObject()` → `erasure.Heal()` + `RenameData()` 把 I/O 拉高 → grid ping handler 延遲 → 60s watchdog 觸發 `canceling remote connection`。

（若偏網路）推定最短鏈：
- node-to-node packet loss/conntrack/MTU/idle-timeout → ping/pong 無法在 ~60s 內被對端看到 → server-side watchdog 觸發 `canceling remote connection`。

---

## 5) code anchors（跨版本也好 grep）

> 目的：讓你在不同 RELEASE tag 上都能快速釘死同一條鏈。

```bash
cd /path/to/minio

# grid watchdog 的 log 出處
grep -RIn "canceling remote connection" -n internal/grid | head

# PutObject -> partial -> MRF
grep -RIn "globalMRFState\.addPartialOp" -n cmd | head

grep -RIn "func \(m \*mrfState\) healRoutine" -n cmd/mrf.go

# Healing：真正 RS rebuild + rename writeback
grep -RIn "func \(er \*erasureObjects\) healObject" -n cmd | head

grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head
```

---

## 6) 這次結論/後續動作（填空）

- 初判類型：`<網路/對端忙(I/O/GC)/未知>`
- 最可能根因：`<一句話>`
- 下一步建議：
  - [ ] `<要做的事 1>`
  - [ ] `<要做的事 2>`
  - [ ] `<要做的事 3>`

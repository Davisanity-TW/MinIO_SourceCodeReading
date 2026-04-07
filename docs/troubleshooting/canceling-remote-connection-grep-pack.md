# `canceling remote connection`：現場快速 grep pack（把 log → 可行動證據）

> 目的：你只有 log/journal（沒有完整 metrics dashboard）時，仍能在 10–20 分鐘內把事件整理成「可回放」的證據包。
>
> 搭配閱讀：
> - `docs/troubleshooting/canceling-remote-connection.md`（完整背景 + code anchors）
> - `docs/troubleshooting/canceling-remote-connection-field-checklist.md`（30 分鐘判斷樹）

---

## 0) 先從一行 log 抽出欄位（不要跳步）

範例：
```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```

固定抄這 3 個欄位到 incident note：
- **time window**：`T ± 5m`
- **local->remote**：`10.0.0.10:9000 -> 10.0.0.11:9000`
- **not seen for**：`1m2.3s`（多數版本≈60s）

> `local` = 印 log 的那台；`remote` = 這次被判定 ping 沒看到的那台。

---

## 1) 在 local 節點：把同時間窗的 log 抓出來（journald）

把 `SINCE/UNTIL` 換成你的時間窗（建議用 Asia/Taipei），先抓「只有這條」：

```bash
SINCE='2026-04-06 13:55:00'
UNTIL='2026-04-06 14:05:00'

journalctl -u minio --since "$SINCE" --until "$UNTIL" \
  | egrep -n 'canceling remote connection' \
  | tail -n 200
```

接著把同時間窗的「可能共振關鍵字」一起撈出來（用來判斷偏網路還是偏 I/O/背景任務）：

```bash
journalctl -u minio --since "$SINCE" --until "$UNTIL" \
  | egrep -i -n 'canceling remote connection|errdisconnected|timeout|reset by peer|heal|healing|scanner|mrf|partial|rebalance|drive.*offline|disk.*offline' \
  | tail -n 400
```

---

## 2) 在 local 節點：用 `ss -ti` 把 TCP 重傳/RTO 摘要抓下來（最省時間）

```bash
# 只看 MinIO 9000 相關連線（依實際 port 調整）
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 200
```

粗判讀：
- retrans/RTO 明顯升高 → 先偏 **網路/CNI/MTU/conntrack/中間設備 idle timeout**
- retrans 不明顯 → 先偏 **remote 忙（I/O/CPU/GC/背景任務）**

---

## 3) 在 remote 節點：抓 I/O latency（最常見共犯）

```bash
iostat -x 1 3
```

若 `await` 高、`%util` 接近 100%：把事件先當作 **I/O 壓力** 看待，再回頭對齊 healing/scanner/MRF。

---

## 4) 有 `mc` 的話：用「最小 admin 指令」補齊 cluster 視角

### 4.1 把 `remoteIP` 對到 `nodeName/hostname`

```bash
REMOTE_IP='10.0.0.11'
mc admin info --json <ALIAS> \
  | jq -r --arg ip "$REMOTE_IP" '.servers[]
      | select((.endpoint|tostring)|contains($ip) or (.addr|tostring)|contains($ip))
      | [.endpoint,.addr,.hostname,.state] | @tsv'
```

### 4.2 同時間窗抓 internal trace（鎖 `grid.*`）

> 這段對「是不是 peer RPC handler 排隊/卡住」非常有幫助。

```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

### 4.3 背景 healing 是否活躍（共振判斷）

```bash
mc admin heal status --json <ALIAS> | jq -r '.'
```

---

## 5) 把「結果」對回「可能根因」：一個很實用的寫法模板

把下面這段貼進 incident note，逐項填空：

- 時間窗：`T ± 5m`
- 事件：`canceling remote connection A:9000->B:9000 not seen for ~60s`
- local `ss -ti`：`retrans/RTO 是否異常：<是/否>（貼 10–30 行摘要）`
- remote `iostat -x`：`await/%util：<數值>（貼輸出）`
- 背景任務：`healing/scanner/rebalance/MRF：<有/無>（貼 log/trace 關鍵字）`
- 初判：`偏網路 / 偏 I/O / 不明（需補 NTP/時間跳動檢查）`

> 目標不是一次找出根因，而是先把方向分對、把證據留住，避免下一班/下次回顧時只能靠猜。

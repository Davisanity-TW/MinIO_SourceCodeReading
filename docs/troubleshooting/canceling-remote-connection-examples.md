# 範例：`canceling remote connection` 現場 log 寫法（可直接貼進 incident note）

> 目的：把你在現場看到的錯誤訊息，直接轉成「可行動」的排查筆記。
> 
> 搭配閱讀：
> - `docs/troubleshooting/canceling-remote-connection.md`
> - `docs/troubleshooting/canceling-remote-connection-field-checklist.md`
> - `docs/troubleshooting/grid-errdisconnected.md`
> - `docs/trace/putobject-healing-callchain.md`

---

## 1) Server 端 watchdog：`canceling remote connection ... not seen for ...`

你常會在 **印 log 的那台（local）** 看到：

```
WARNING: canceling remote connection 10.0.0.10:9000->10.0.0.11:9000 not seen for 1m2.3s
```

建議在 incident note 直接改寫成固定欄位：

- 時間窗：`2026-04-06 13:55–14:05 (Asia/Taipei)`
- local->remote：`10.0.0.10:9000 -> 10.0.0.11:9000`
- not seen for：`1m2.3s`（多數版本≈60s）
- 初判：**結果/症狀**（代表 server 端 ~60s 沒看到或沒處理到 remote ping）

### 同時間「要順手抓」的三個最便宜證據（建議直接貼輸出）

1) local：TCP retrans/RTO（偏網路 vs 偏資源）
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```

2) remote：I/O latency（偏 I/O 壓力）
```bash
iostat -x 1 3
```

3) 任一節點：internal trace（找最熱的 `grid.*` handler）
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

---

## 2) Client 端先斷（常見會早於 server 端 60s）：`grid: ErrDisconnected`

同一個 incident 常見順序是：

1) **client 端**先出現 `ErrDisconnected`（約 30s 沒看到 pong）
2) **server 端**稍後才印 `canceling remote connection ... not seen for ~60s`

因此在筆記裡建議把兩邊時間點都記下來，避免誤判成「server 先砍線」。

---

## 3) 常見共振寫法：Healing/MRF 忙 → I/O 壓力 → ping handler 延遲

如果同時間窗你也看到（任一成立就值得記）：
- healing/scanner/MRF/rebalance 明顯活躍
- remote `iostat` 的 `await/%util` 尖峰
- PutObject latency 變長

建議在 incident note 加上一句「最短因果鏈」(可直接照抄)：

> 可能鏈路：PutObject quorum success 但留下 partial → MRF/scanner 觸發 HealObject → RS rebuild + RenameData 寫回打滿 I/O → grid streaming mux ping 更新延遲 → server watchdog 印 `canceling remote connection`。

讀碼錨點：
- PutObject partial：`cmd/erasure-object.go` → `addPartial()` → `globalMRFState.addPartialOp(...)`
- MRF consumer：`cmd/mrf.go` → `healRoutine()`
- Healing I/O 熱點：`cmd/erasure-healing.go` → `erasure.Heal()` + `disk.RenameData()`
- watchdog：`internal/grid/muxserver.go` → `checkRemoteAlive()`

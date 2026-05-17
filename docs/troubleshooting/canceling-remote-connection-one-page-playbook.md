# Troubleshooting：`canceling remote connection`（一頁版 Playbook）

> 目的：把你現場看到的單行 log（server side）快速變成可驗證的假說，並且能在 10 分鐘內分流成：
> 1) **網路/連線層**（retrans/idle timeout/MTU/conntrack）
> 2) **對端忙到 ping handler 跑不動**（I/O tail latency、healing/MRF/scanner、CPU/GC/鎖）
>
> 延伸（更細）：
> - 決策樹：`docs/troubleshooting/canceling-remote-connection-decision-tree.md`
> - Root causes：`docs/troubleshooting/canceling-remote-connection-root-causes.md`
> - pprof 指紋：`docs/troubleshooting/canceling-remote-connection-pprof-stack-signatures.md`
> - code anchors：`docs/troubleshooting/canceling-remote-connection-code-anchors.md`
> - PutObject/Healing trace：`docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`

---

## 0) 先把單行 log 變成 3 個欄位（incident note 最小模板）

典型 log：

```text
canceling remote connection <local->remote> not seen for <duration>
```

請先記下：

- **time window**：log 的前後 1–2 分鐘（至少）
- **local->remote**：哪台 node 對哪台 node（IP/port）
- **not seen for**：是否接近 ~60s（常見是 `lastPingThreshold = 4 * clientPingInterval`）

> 若 duration 明顯不是 ~60s：優先把 **時鐘/NTP 跳動** 或 **不同版本閾值** 納入假說。

---

## 1) 1 分鐘分流：網路 vs 對端忙（最便宜的 3 問）

### Q1：同時間窗，有沒有網路重傳/丟包訊號？

（任一成立 → 先走網路方向）

- `ss -ti` 看 retrans/RTO 明顯上升
- NIC / CNI / firewall 有 drop
- K8s CNI（尤其 overlay）在尖峰時 RTT 抖動

### Q2：同時間窗，remote 節點的 disk I/O tail latency 是否爆掉？

（任一成立 → 先走 I/O/對端忙）

- `iostat -x 1`：await/svctm 飆升，util 長時間高
- dmesg 有 FS/blk 層告警
- MinIO 同時間有 healing/scanner/rebalance/MRF 背景流量

### Q3：同時間窗，PutObject latency / healing（HealObject）是否尖峰？

（成立 → `canceling remote connection` 很常是「結果」不是「原因」）

- PutObject/hot objects 寫入延遲上升
- `mc admin heal status` 顯示 active 或 backlog
- goroutine dump/pprof 顯示大量卡在 `RenameData`/`readAllFileInfo`/`erasure.Heal`

---

## 2) 10 分鐘可操作 SOP（順序固定）

1. **固定 time window**：抓出 log 前後各 60s 的範圍。
2. **鎖定節點對**：把 `local->remote` 對應到 node identity（必要時用 `mc admin info --json`）。
3. **同窗抓三件套**（至少其一）：
   - `ss -ti`（retrans/RTO）
   - `iostat -x 1`（await/util）
   - MinIO internal trace（60–120s）
4. **如果懷疑對端忙**：
   - 先用 goroutine dump（SIGQUIT）或 pprof goroutine，找 `RenameData`/`readAllFileInfo`/`erasure.Heal` 指紋。
5. **把指紋對回 code**：用下列 anchors 直接釘點：
   - grid watchdog：`internal/grid/muxserver.go: checkRemoteAlive()`（log 字串在同檔）
   - PutObject 主線：`cmd/object-handlers.go: PutObjectHandler()` → `cmd/erasure-object.go: erasureObjects.putObject()`
   - Healing heavy path：`cmd/erasure-healing.go: (*erasureObjects).healObject()`
   - I/O 熱點：`cmd/erasure-metadata-utils.go: readAllFileInfo()`、`cmd/erasure-object.go: renameData()`

> 你如果只想「最短錨點集合」：直接看 `docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`（已補實際檔案/函式/行號）。

---

## 3) 常見結論句（寫 incident note 用）

- **網路方向**：`canceling remote connection` 與 retrans/RTO 同時間窗共振，初判為連線品質/中間設備 idle-timeout/MTU 或 conntrack 壓力；需先穩定網路，再觀察是否仍有 ping starvation。
- **I/O/對端忙方向**：`canceling remote connection (~60s)` 與 PutObject/Healing/MRF 的 rename/fsync（`RenameData`）或 metadata fan-out（`readAllFileInfo`）尾端延遲同窗出現；初判為對端 goroutine 排程延遲導致 ping handler starvation，屬「結果」；需先定位 I/O 瓶頸（disk/FS/queue depth）與背景 healing 流量。

---

## 4) 版本無關 grep pack（快速帶走）

```bash
# 在 MinIO source tree 直接釘 log 與 threshold
grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "clientPingInterval" -n internal/grid | head

grep -RIn "lastPingThreshold" -n internal/grid/muxserver.go

# PutObject/healing 最短錨點
grep -RIn "PutObjectHandler" -n cmd/object-handlers.go

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go

grep -RIn "func readAllFileInfo" -n cmd/erasure-metadata-utils.go

grep -RIn "func renameData" -n cmd/erasure-object.go
```

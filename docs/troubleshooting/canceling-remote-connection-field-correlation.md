# Troubleshooting：`canceling remote connection`（internal/grid）如何把「單行 log」快速關聯到 PutObject / Healing / Peer REST（含最小命令包）

> 目標：你在現場只有一條 log：
>
> - `canceling remote connection ... not seen for ...`
>
> 也能在 **10~20 分鐘內**把它變成「可回放」的 incident note：
> - 這條 log 是 server 端的 grid streaming mux watchdog
> - 是哪個 peer（remote IP:port）
> - 同時間窗是否有 PutObject tail latency / Healing（MRF/scanner/admin heal）/ RenameData I/O 壓力共振
>
> 補充：本頁偏「如何關聯」，grid watchdog 的 code anchors / threshold 請看：
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`
> - `docs/troubleshooting/canceling-remote-connection-thresholds.md`

---

## 0) 先把 log 拆成 4 個欄位（incident note 最小模板）

把你看到的 log 行（或 journald）固定寫成：

- **time window**：T ± 5m（至少 10 分鐘）
- **direction**：`local->remote`（哪一端印的？通常是 local 端 node）
- **remote endpoint**：`<remote-ip>:<remote-port>`
- **not-seen-for**：`~60s`（若不是 60s，優先懷疑 NTP/時鐘跳動或版本差異）

> 只有把這 4 個欄位寫出來，後面才能用同一時間窗去對齊 I/O / Healing / PutObject。

---

## 1) 最小命令包（只靠節點 shell）

> 假設你能上到印出 log 的那台 node。

### 1.1 用 journald 抓出同一 remote 的重複頻率

```bash
# 先拿出 10 分鐘窗內所有 canceling remote connection（依環境調整單位/服務名）
journalctl -u minio --since "-10 min" | \
  grep -F "canceling remote connection" \
  | tail -n 200

# 想看是不是同一個 local->remote 一直反覆
journalctl -u minio --since "-10 min" | \
  grep -F "canceling remote connection" \
  | sed -n 's/.*\(local->remote[^)]*\).*/\1/p' \
  | sort | uniq -c | sort -nr | head
```

### 1.2 同時間窗：看 socket 層是否有明顯 retrans（純網路方向）

```bash
# 快速看 TCP retrans（只要方向）
ss -ti | head

# 若有權限/工具：看系統層 counters
nstat -az | egrep -i 'Retrans|Timeout|ListenOverflows|TCPLoss|RTO' || true
```

### 1.3 同時間窗：看 I/O latency（資源壓力方向，最常見）

```bash
# 觀察 await/%util（重點：是否在同時間窗尖峰）
iostat -x 1 10

# 若磁碟很多，至少先抓 top 幾顆
lsblk
```

> 實務判讀：`canceling remote connection` 在 healing / rename/fsync 放大時最常見。

---

## 2) 把「方向」對到 PutObject / Healing 的最短因果鏈（可直接貼 incident note）

你最後最常需要寫成這一句：

> `canceling remote connection` 對應 internal/grid mux server watchdog（~60s 沒看到 remote ping 更新 LastPing），同時間窗 PutObject tail latency 上升、healing/MRF/scanner 活躍、以及 RenameData（rename/fsync/metadata ops）造成的 disk latency 上升；推測主要是 **remote 或 local 端資源壓力導致 ping handler 延遲**，而非單純網路中斷。

把它釘到 code 的最短鏈（不靠行號）：

- PutObject 留洞：`cmd/erasure-object.go` → `addPartial()` → `globalMRFState.addPartialOp()`
- MRF 背景補洞：`cmd/mrf.go` → `healRoutine()` → `z.HealObject(...)`
- 真正 I/O 熱點：`cmd/erasure-healing.go` → `(*erasureObjects).healObject()` → `erasure.Heal()` + `disk.RenameData()`
- grid watchdog：`internal/grid/muxserver.go` → `checkRemoteAlive()` → `canceling remote connection ... not seen for ...`

（對照用）
- Trace call chain：`docs/trace/putobject-healing-callchain.md`

---

## 3) 進階關聯：為什麼常跟 Healing/Peer REST（grid RPC）同窗共振？

你在 `canceling remote connection` 出現的時間窗，如果同時看到（任一個即可）：
- bucket heal / background heal status query
- scanner applyHealing
- rebalance / decommission

那通常代表這條 grid streaming mux 承載的是「長連線/串流」類 peer RPC。

快速讀碼 anchor（釘到 handler/threshold）：
- `internal/grid/muxserver.go`：`DeadlineMS` 判斷 + `checkRemoteAlive()`
- `cmd/peer-rest-server.go`：`BackgroundHealStatusHandler` / `HealBucketHandler`

> 實務上：你要找的是「為什麼在 60s 內 ping 沒被處理」：常見原因是 I/O/排程/鎖/GC，而不是 ping 本身壞掉。

---

## 4) Stop condition（什麼情況下你就可以停止往下挖）

- 如果同時間窗 `iostat await/%util` 明顯尖峰，而且 healing/MRF/scanner 明顯活躍：先把方向定為「資源壓力」即可（下一步才是釘到 RenameData/fsync）。
- 如果同時間窗 retrans/RTO 明顯異常，但 disk/CPU 平：先把方向定為「網路/連線層」即可（下一步才查 MTU/conntrack/overlay）。
- 如果 `not seen for` 明顯不是 ~60s 且時間戳跳動：先做 NTP/時鐘跳動排除。

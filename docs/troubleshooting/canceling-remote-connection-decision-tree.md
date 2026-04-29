# Troubleshooting：`canceling remote connection` 決策樹（從 log → 下一步要查什麼）

> 目的：當你在 MinIO server log 看到類似訊息：
>
> - `canceling remote connection <node> not seen for ~60s`
>
> 你要能在 **5 分鐘內**決定：
> 1) 這比較像「網路斷/抖」？還是「對端忙到 ping handler 排不到」？
> 2) 你下一步該抓哪些證據（pprof / stackdump / iostat / 連線狀態）？
> 3) 這條 log 跟 PutObject/Healing/MRF 這些背景 I/O 是否共振？

本頁刻意做成「決策樹/Checklist」，細節與 code anchors 請回看：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- `docs/troubleshooting/canceling-remote-connection-codepath.md`
- `docs/trace/putobject-healing-callchain.md`（把 Healing/MRF 與 grid ping watchdog 串在一起）

---

## 0) 先確認：你看到的是「server 端」還是「client 端」訊息？

- **server 端**常見字串：
  - `canceling remote connection ... not seen for ...`
  - 意義：server 端 watchdog 判斷 *LastPing* 超過閾值沒更新（通常 ~60s）→ 主動 close

- **client 端**常見字串：
  - `ErrDisconnected` / `context deadline exceeded` / `grid peer rpc ...`
  - 意義：client 端先覺得對端無回應/無 pong → 主動斷

> 實務上：常見是 **client 端先斷（~30s）**，server 端後印 `canceling...`（~60s）。

下一步：把同一時間窗（±2 分鐘）兩端的 log 收齊。

---

## 1) 決策樹：網路問題 vs 對端過載（最常見的分岔）

### A. 如果同時滿足：
- 多個 peer 都在同一時間窗「互相 cancel」
- 叢集內還出現 `i/o timeout`、`connection reset`、`no route to host`、`TLS handshake timeout`
- ping/丟包（或 switch/防火牆事件）能對上時間

→ **優先當成網路/連線層問題**

你下一步要做：
1) 在同一時間窗抓：
   - `ss -tnp | grep :<minio-port>`（或對應 grid/peer 的 port）
   - `ethtool -S <iface>` / dmesg（link flap / rx errors）
   - 若是 K8s：Node/Pod 的 conntrack、CNI 日誌（視環境）
2) 觀察是否「只影響特定 rack/子網」：
   - 若集中在某一批 nodes：更像網路/拓撲

### B. 如果同時滿足：
- `canceling remote connection` 大多集中在「某一台」或「某一組 disks 很慢的 nodes」
- 同時間窗：`iostat await/%util` 飆高，或 CPU/GC/ctx 切換異常
- 同時間窗：PutObject latency / Healing / scanner / MRF 明顯變熱

→ **優先當成對端過載（busy peer）造成 ping handler 延遲**

你下一步要做：
1) 立刻抓對端：
   - goroutine dump（SIGQUIT 或 pprof/goroutines）
   - `pprof`：至少 `profile`（CPU）、`goroutine`、`mutex`（若可用）
   - `iostat -x 1`（至少 30 秒）
2) 對照這些關鍵卡點：
   - 大量 stack 在 `xlStorage.RenameData` / `fsync` / `renameat` → **rename/commit 慢**
   - 大量 stack 在 `readAllFileInfo` / `xl.meta` 讀取 → **metadata fan-out 慢**
   - 大量 stack 在 `internal/grid` read/write → **RPC handler 排隊/被 block**

---

## 2) 快速分類：跟 Healing/MRF 有沒有高度相關？

在 incident timeline 上做三個問答（用 yes/no）：

1) 同時間窗是否有大量 `mc admin heal`、Background heal task、scanner heal 的跡象？
- yes → 這條 log 很可能是「結果」：heal 把 I/O 拉高 → ping 延遲

2) 同時間窗是否有 PutObject 失敗/重試/partial 的跡象（或 MRF queue drop）？
- yes → 常見是 PutObject 留洞 → MRF 拉起 heal → I/O 壓力上升 → grid 斷線

3) `canceling remote connection` 是否伴隨 `storage resources insufficient` / `mrf queue drop` / disk offline？
- yes → 直接把調查重心放到 **disk/FS/IO**（不是先怪網路）

---

## 3) 你應該「固定收集」的證據（建議模板）

> 建議你每次碰到這條 log 都固定收集下面這包，之後很容易做比對（跨事件/跨版本）。

### A) Log 片段（兩端）
- 出現 `canceling remote connection` 的前後各 200 行
- 同時間窗是否有 healing/scanner/mrf/rename 相關關鍵字

### B) 系統層（對端那台最重要）
- `iostat -x 1 60`
- `pidstat -p <minio-pid> 1 60`（CPU/ctx 切換）
- `ss -s` + `ss -tnp`（連線狀態、SYN backlog）

### C) MinIO runtime（對端那台最重要）
- goroutine dump（至少一份）
- pprof：`/debug/pprof/goroutine?debug=2`、`/debug/pprof/profile?seconds=30`

### D) MinIO code 對齊（避免版本誤判）
- `git rev-parse --short HEAD`
- grep anchors：見 `docs/trace/putobject-healing-callchain.md` 的 §4

---

## 4) 常見結論句（寫在事件筆記裡最耐打）

- 「此 `canceling remote connection` 在同時間窗伴隨大量 healing/MRF 活躍與磁碟 `await/%util` 飆高，推定為 peer 過載導致 grid ping handler 延遲，屬結果型訊號；根因需回到 RenameData/fsync 或特定 disk latency。」

- 「此 `canceling remote connection` 同時影響多個 peer 且伴隨連線層 timeout/reset，推定為網路/連線品質問題，需對齊 switch/防火牆/CNI/conntrack 事件。」

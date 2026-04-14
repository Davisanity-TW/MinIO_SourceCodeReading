# Troubleshooting：grid/peer RPC 相關 timeout（`ErrDisconnected` / `context deadline exceeded` / `connection reset by peer`）

> 目標：把 MinIO node-to-node（`internal/grid` + peer REST / peer RPC）常見的幾種錯誤訊息整理成「可行動」的排查筆記。
>
> 這頁的定位是：當你在 incident 裡同時看到 `canceling remote connection`、`ErrDisconnected`、`context deadline exceeded`、`connection reset by peer` 等訊息時，快速判斷 **是網路**、**是對端忙**、還是 **對端重啟/被 OOM**。

相關頁：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/grid-errdisconnected.md`
- `docs/trace/putobject-healing-callchain.md`

---

## 0) 先釐清：這些錯誤訊息通常出現在「哪一端」？

同一個事件時間窗（T±5m）裡，你常會在不同節點看到不同訊息：

- **client 端（發起 peer RPC 的那台）**常見：
  - `grid: ErrDisconnected`
  - `context deadline exceeded`
  - `i/o timeout`

- **server 端（被呼叫/被連線的那台）**常見：
  - `canceling remote connection A:9000->B:9000 not seen for ~60s`
  - （有時）`connection reset by peer`（如果是對端先斷/重啟）

> 記法：
> - `ErrDisconnected` 比較像「我（client）等不到 pong/回應」
> - `canceling remote connection` 比較像「我（server）太久沒看到對方 ping，所以我把連線砍了」

---

## 1) 症狀 → 高機率原因（快速對照表）

### A) `grid: ErrDisconnected`（client 端）
常見意義：client 端偵測到 **一段時間沒有收到對端的 pong/資料**，所以自行中止該 mux/stream。

高機率原因（由常見到較少見）：
1) **對端忙/排程延遲**（I/O 飆高、healing/scanner/MRF/rebalance 活躍、CPU throttling、GC pause）
2) **網路丟包/延遲抖動**（K8s overlay、conntrack、MTU）
3) **對端重啟/OOM**（連線直接被重置/消失）

現場最便宜的 3 個驗證：
- 同時間窗 remote 節點 `iostat -x 1 3`（await/%util 是否尖峰）
- local 節點 `ss -ti`（retrans/rto 是否明顯）
- 同時間是否有 healing/scanner/MRF 相關 log/trace


### B) `context deadline exceeded`（client 端）
常見意義：上層 caller（例如 peer REST 某個 handler / admin API / healing 調度）對該 RPC 設了 deadline，**時間到就放棄**。

高機率原因：
- **對端做事太慢**（大量 metadata fan-out、disk latency、rename/fsync 卡住）
- **網路延遲/丟包**（讓 round-trip 超過 deadline）
- **deadline 本身很短**（版本/功能不同，某些 RPC 可能預設較短 timeout）

現場建議先做：
- 把同時間窗的 `canceling remote connection` / `ErrDisconnected` 一起對齊（通常同根因）
- 用 internal trace 抓 60–120 秒：找最熱的 `grid.*` handler（若你有 `mc admin trace --type internal`）


### C) `connection reset by peer`（兩端都可能看到）
常見意義：TCP 層收到 RST。

高機率原因：
1) **對端重啟或被 OOM kill**（最常見）
2) **中間設備/iptables/NAT 直接 reset**（較少見，但 K8s/LB 可能）
3) **對端主動 close**（例如 watchdog/timeout 或程式主動關閉 socket）

現場快速驗證：
- K8s：看 pod restart / OOMKilled event（同時間窗）
- systemd：看 remote 節點 minio service restart / crash

---

## 2) 把這些訊息跟 healing/MRF 對齊（最常見的共振）

如果同時間窗你也看到：
- healing/scanner/MRF 活躍
- `canceling remote connection` 大量出現

那很常不是「網路先壞」，而是：
- PutObject 寫入達 quorum 但留下 partial → MRF queue / scanner 觸發 `HealObject()`
- `HealObject()` 在 `erasure.Heal()` + `RenameData()` 造成 I/O 壓力
- grid streaming mux 的 ping/pong handler 更新延遲 → `ErrDisconnected` / `canceling remote connection`

呼叫鏈速查：`docs/trace/putobject-healing-callchain.md`

---

## 3) 事件筆記模板（建議直接照抄）

1) 時間窗：`T ± 5m`
2) local->remote：`A:9000 -> B:9000`（從 `canceling remote connection` 抄）
3) 同時間是否有：healing / scanner / rebalance / MRF
4) local：`ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120`
5) remote：`iostat -x 1 3`
6) 是否有：pod/node restart / OOMKilled / dmesg I/O error

> 有了這 6 點，下次回頭看 log 幾乎都能很快分出：網路 vs I/O/資源壓力 vs 重啟/OOM。

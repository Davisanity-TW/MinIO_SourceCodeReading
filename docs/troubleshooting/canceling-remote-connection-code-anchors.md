# Troubleshooting：`canceling remote connection`（程式碼錨點 / 呼叫鏈）

> 目的：把你在 log 看到的 `canceling remote connection` 這類訊息，快速對齊到 MinIO source code 的 **實際檔案/函式**，方便你：
> - 確認是 **server 端 watchdog** 主動斷線，還是 client side 先偵測到 disconnect
> - 釘死「遠端多久沒 seen/ping」的判斷邏輯（interval、deadline、誰更新 LastPing）
> - 把現場的症狀（PutObject/MRF/Healing 高負載）連回 grid mux 的行為

延伸閱讀：
- Trace：`docs/trace/grid-canceling-remote-connection.md`
- Trace：`docs/trace/healing.md`（Healing/MRF 與 grid 心跳共振）

---

## 1) 先把 log 字串釘死到 `internal/grid`

```bash
cd /path/to/minio

git rev-parse --short HEAD

grep -RIn "canceling remote connection" -n internal/grid | head -n 50
```

你要找到的通常是：
- mux server 的 watchdog loop（例如 `muxserver.go`/`muxclient.go` 類似檔名）
- log 會帶：remote addr / last seen / elapsed / reason

> 實務：不同 RELEASE tag 可能改字串或改字段名，但只要先釘住字串所在檔案，後面就能一路追到「LastPing/LastSeen 是在哪裡更新」與「多久判定為 dead」。

---

## 2) watchdog 的核心判斷：多久沒更新就斷

常見錨點（名稱可能略有差異）：

```bash
cd /path/to/minio

grep -RIn "checkRemoteAlive\(" -n internal/grid | head -n 80

grep -RIn "clientPingInterval|serverPingInterval|pingInterval" -n internal/grid | head -n 120

grep -RIn "not seen for" -n internal/grid | head -n 120
```

你要關心的三件事：
1) **interval 是常數還是可配置**（env / flag / config）
2) **LastPing/LastSeen 的更新點**（讀到 ping frame？收到任何 frame？寫成功才算？）
3) **mux/handler backpressure** 會不會讓「handler 處理慢」變成「沒 seen」

---

## 3) 把「誰更新 LastPing」釘死：ping/pong 的 handler

```bash
cd /path/to/minio

# 找 ping/pong frame 的處理點
grep -RIn "Ping|Pong" -n internal/grid | head -n 200

# 如果 grid 有明確的 handler id / op code
grep -RIn "HandlerPing|OpPing|opPing" -n internal/grid | head -n 200
```

當你找到 ping handler 後，你要一路追：
- handler 入口 → 讀 frame → 更新 `conn.lastSeen` / `peer.lastPing`（類似欄位）
- 更新點是否會被 goroutine 排程/鎖競爭/GC 延遲

---

## 4) 現場最常見的共振來源：PutObject/MRF/Healing 拉高 tail latency

`canceling remote connection` 很常不是「網路先壞」，而是：
- 磁碟 I/O（尤其 rename/fsync/metadata）或 CPU/GC 把 tail latency 拉長
- grid mux 是長連線（多 handler multiplexing）
- ping handler 排不到 → watchdog 認為 remote dead → 主動斷線

把這條因果鏈對回 code 時，建議同步釘住這些 I/O 熱點（同一個版本）：

```bash
cd /path/to/minio

# PutObject commit 路徑：tmp -> rename -> commit
grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head -n 80

# Healing writeback：.minio.sys/tmp -> RenameData
grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 120

# MRF：partial enqueue + healRoutine
grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go
```

> 實務：如果你看到同一時段 PutObject latency ↑、MRF queue 活躍、healing/scanner 在跑，再搭配 `canceling remote connection` 爆量，通常先把瓶頸當成「節點內部 tail latency」去排（IO wait / fsync / inode contention / CPU throttling / Go runtime）。

---

## 5) 快速 checklist（你下次遇到同樣訊息時要收的佐證）

- 事件時間窗內：
  - `iostat -x` / disk latency（尤其 await / svctm）
  - CPU steal/throttling（虛擬化/容器）
  - goroutine 數量 / GC pause（pprof/metrics）
- MinIO 指標/狀態：
  - healing/scanner/mrf 是否活躍
  - `.minio.sys/tmp` 是否暴增（tmp write/rename 共振）
- 程式碼側：
  - `internal/grid` watchdog 判斷的 interval/threshold（本頁 anchors）

（把這些和 code anchors 綁在一起，你做 postmortem 會快很多。）

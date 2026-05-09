# Troubleshooting：`canceling remote connection` — Log signature / 版本差異速查

> 目的：把現場會看到的 **log 文字** 與 MinIO `internal/grid` 的 **實際 code 錨點** 對齊。
> 你看到這句（或相近變體）時，下一步就是：
> 1) 先確認是 **server** 還是 **client** 主動 cancel
> 2) 再用 pprof/stackdump/latency 指標確認是否是 **CPU starvation / GC / disk stall / inter-node RTT** 造成 keepalive 失敗
>
> 注意：不同 release / fork 可能會有：
> - log 文字微調
> - watchdog 變數/欄位命名不同
> 但通常仍落在 `internal/grid/muxserver.go` / `internal/grid/muxclient.go`。

相關頁：
- `docs/troubleshooting/canceling-remote-connection.md`（總頁）
- `docs/trace/putobject-healing-real-functions.md`（PutObject/Healing 真實函式錨點）

---

## 1) 你在現場可能看到的 log 變體（收斂成「同一類事件」）

最常見基底（server side / mux watchdog）：
- `canceling remote connection`  （你遇到的就是這句）

常見共伴訊號（同一段時間內一起出現，提示是 grid keepalive / stream lifecycle）：
- `grid: ErrDisconnected`（或你在 client 看到 RPC 失敗/重連）
- `peer is not connected`（上層 peer REST / healing status 之類）
- heal/mrf/scanner 相關 log 在同一波尖峰

建議一次抓「同一節點同一分鐘」的關鍵字：
```bash
# 依你實際 log 系統調整：journalctl / k8s logs / file
rg -n "canceling remote connection|ErrDisconnected|grid" /path/to/minio-logs | head -n 200
```

---

## 2) 最短：把 log 釘到 source tree 的位置（不用行號）

在 MinIO source tree：
```bash
cd /path/to/minio

# 1) log 文字在哪裡
rg -n "canceling remote connection" internal/grid

# 2) 同檔案內：抓 keepalive / deadline / ping-pong / alive 判斷
rg -n "checkRemoteAlive|keepalive|heartbeat|ping|pong|deadline|timeout" internal/grid/muxserver.go internal/grid/muxclient.go

# 3) alive 判斷用的欄位（不同版本命名不同，用模式抓）
rg -n "last(Ping|Pong|Read|Write|Msg)|time\.Since\(|time\.Now\(" internal/grid/muxserver.go internal/grid/muxclient.go

# 4) 真正做 cancel/close 的地方
rg -n "Cancel\(|cancel\(|Close\(|close\(" internal/grid/muxserver.go internal/grid/muxclient.go
```

你要得到的結論是：
- **是哪個 goroutine / ticker** 在掃描 remoteConn
- 它判斷 remote 不健康的 **條件**（多久沒 pong？多久沒任何 read/write？）
- 它做的動作是：關閉底層 conn？cancel ctx？還是 close 某些 streams？

---

## 3) 最常見根因（用「排除法」對齊）

> 心法：`canceling remote connection` 往往是「症狀」，不是 root cause。

### A) CPU starvation / GC stop-the-world / goroutine 爆量
特徵：
- 同時看到 request latency 飆升
- pprof 顯示 goroutine 很多卡在 scheduler/network poll/GC

最短證據：
- SIGQUIT stackdump：看 mux ping/pong handler 是否排不到
- pprof：看是否被 PutObject/Healing 的 hash/encode/metadata 放大

### B) Disk stall（rename/fsync/metadata）放大 tail latency → keepalive handler 排不到
特徵：
- 同時看到 PutObject rename/commit 或 healing writeback 尖峰
- iostat / node exporter：await 飆高、util 100%

對回 code（你要能把 syscall 卡住對回 Go）：
- `StorageAPI.RenameData`（interface）→ `(*xlStorage).RenameData`（實作）
- PutObject/Healing 共同會踩到 rename/commit

快速 anchors：
```bash
cd /path/to/minio

rg -n "type StorageAPI interface" cmd/storage-interface.go
rg -n "RenameData\(" cmd/storage-interface.go cmd/xl-storage.go cmd/erasure-object.go cmd/erasure-healing.go
```

### C) Inter-node RTT / packet loss / conntrack 壓力
特徵：
- 單一方向（某些 node pair）特別容易斷
- 同時看到 TCP retransmit、conntrack table 壓力、或 k8s overlay 問題

證據：
- mtr/ping
- node network 指標
- 抓一段 tcpdump（必要時）

---

## 4) 與 PutObject / Healing 共振時，最常用的「三步鑑別」

1) 同時段是否有 PutObject rename/commit / healing writeback 尖峰？
2) 如果有：先以 disk latency/IO wait 為第一嫌疑（rename/fsync）。
3) 如果沒有：再回頭看 CPU/GC/network。

建議把這句 log 與下列指標同時對齊（同一個時間窗）：
- MRF queue 深度 / drop
- healing concurrency
- disk await / util
- inter-node RTT

---

## 5) 你可以直接貼進 incident note 的「一句結論模板」

- 觀察：`canceling remote connection` 出現於 __（節點/時間窗）__，同時 __（PutObject rename/Healing/IO wait/RTT）__ 上升。
- 推論：grid mux keepalive watchdog 因 __（CPU starvation / disk stall / RTT）__ 判定 remote 不健康而 cancel。
- 下一步：收集 __（pprof + iostat + RTT/packet loss）__，並把 log anchor 對回 `internal/grid/mux{server,client}.go` 的 __（checkRemoteAlive/keepalive ticker）__。

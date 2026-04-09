# Troubleshooting：`canceling remote connection` — code anchors（grep 速查）

> 用途：把現場看到的 log（`canceling remote connection ... not seen for ...`）快速對回 **MinIO internal/grid** 的 watchdog/ping/pong 實作位置。
>
> 本頁只放「可釘死的檔案/函式/grep」；分析與現場 checklist 請看：
> - `docs/troubleshooting/canceling-remote-connection.md`
> - `docs/trace/putobject-healing-callchain.md`（PutObject/MRF/Healing 共振）

---

## 1) Server 端：為什麼會印 `canceling remote connection`

- 檔案：`internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`
    - 條件：`time.Since(time.Unix(LastPing,0)) > lastPingThreshold`
    - 動作：log `canceling remote connection ... not seen for ...` → `m.close()`

### 閾值來源（常見 ~60s）

- `internal/grid/grid.go`
  - `clientPingInterval = 15 * time.Second`
- `internal/grid/muxserver.go`
  - `lastPingThreshold = 4 * clientPingInterval`

### LastPing 更新點（server 收到 ping）

- `internal/grid/muxserver.go`
  - `(*muxServer).ping(...)`：`atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

---

## 2) Client 端：為什麼常先看到 `ErrDisconnected`（~30s）

很多現場會先看到 client 端（發起端）報 `ErrDisconnected`，server 端稍後才印 `canceling remote connection`。常見原因：

- `internal/grid/muxclient.go`
  - `LastPong` 超時（通常 `clientPingInterval*2`，約 ~30s）會先斷線／回 `ErrDisconnected`

---

## 3) 一鍵 grep（建議 incident note 直接貼輸出）

```bash
cd /path/to/minio

git rev-parse --short HEAD

# server watchdog
grep -RIn "canceling remote connection" -n internal/grid | head -n 50
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

# ping interval / threshold
grep -RIn "clientPingInterval" -n internal/grid | head -n 80
grep -RIn "lastPingThreshold" -n internal/grid | head -n 80

# LastPing/LastPong
grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 80
grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 80

# client-side ErrDisconnected
grep -RIn "ErrDisconnected" -n internal/grid/muxclient.go internal/grid/connection.go | head -n 80
```

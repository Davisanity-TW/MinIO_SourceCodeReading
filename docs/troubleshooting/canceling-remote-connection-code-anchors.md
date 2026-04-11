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

### 1.1 這個 watchdog 是誰啟動的？（通常只針對 streaming/長連線 mux）
`checkRemoteAlive()` 不是全域固定 tick 掃描，而是 **在建立 streaming mux 時**（MuxID != 0）視條件啟動。

- 檔案：`internal/grid/muxserver.go`
  - 典型 callsite：`newMuxStream(...)` 之類建立 streaming mux 的地方
  - 條件常見是：`msg.DeadlineMS == 0 || msg.DeadlineMS > lastPingThreshold`

一鍵釘死（避免版本差異搬家）：
```bash
cd /path/to/minio

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 120
# 往上看 10~30 行，通常能看到建立 streaming mux 時 go 起 watchdog 的條件判斷
```

### 1.2 LastPing 是「哪裡更新」的？（server 收到 OpPing）
你要回答的是：remote 端的 ping 是沒送、送了但丟包，還是送到了但 server handler 跑不動。

最短可 grep 的接收鏈：
- `internal/grid/connection.go`
  - `(*Connection).handleMsg()`（switch/case `OpPing`）→ `handlePing(...)`
- `internal/grid/muxserver.go`
  - `(*muxServer).ping(...)`：`atomic.StoreInt64(&m.LastPing, time.Now().Unix())`

```bash
cd /path/to/minio

grep -RIn "case OpPing" -n internal/grid/connection.go
grep -RIn "handlePing" -n internal/grid/connection.go | head -n 80
grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 120
```

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

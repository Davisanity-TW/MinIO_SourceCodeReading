# canceling remote connection × HealBucket（bucket heal 放大 → grid streaming mux watchdog）

> 目的：把你在現場常遇到的「跑 `mc admin heal -r <bucket>` / background bucket heal」與 `canceling remote connection ... not seen for ~60s` 這句 log 串在一起，讓 incident note 可以直接落到 **實際函式/檔案/呼叫鏈**。

典型現象：
- 你對某個 bucket/prefix 啟動 heal（或背景 heal 自動跑）
- 叢集開始大量列舉 object、並對大量 object 逐一 `HealObject()`
- 同時間 inter-node peer REST（grid RPC）長連線/串流流量上升
- 遠端節點 I/O/排程吃緊，導致 ping handler 延遲 → `canceling remote connection ... not seen for ~60s`

## 1) 最短因果鏈（寫 incident note 用）

1) **bucket heal 進入節點（admin API 或 peer REST）**
- `cmd/admin-handlers.go`：`func (a adminAPIHandlers) HealHandler(...)`
- `cmd/peer-rest-server.go`：`func (s *peerRESTServer) HealBucketHandler(...)`

2) **落到本地 bucket heal：`healBucketLocal()`**
- `cmd/...`：`func healBucketLocal(ctx, bucket string, opts madmin.HealOpts) ...`

3) **bucket heal 列舉 objects → 逐一 `HealObject()`（I/O 放大點）**
- call pattern（跨版本很常見）：
  - `for obj in list(...) { o.HealObject(ctx, bucket, object, versionID, healOpts) }`

4) **`HealObject()` heavy path：RS rebuild + 寫回/rename**
- `cmd/erasure-healing.go`：`func (er *erasureObjects) healObject(...)`
  - metadata fan-out：`readAllFileInfo(...)`
  - RS rebuild：`erasure.Heal(...)`
  - writeback/commit：`StorageAPI.RenameData(...)`

5) **grid streaming mux watchdog（server 端）超時 → 斷線 log**
- `internal/grid/muxserver.go`：`(*muxServer).checkRemoteAlive()`
  - `lastPingThreshold ≈ 4*clientPingInterval ≈ 60s`
  - log：`canceling remote connection ... not seen for ...`

## 2) 一鍵釘死（最小 grep 錨點）

> 把下面 grep 跑在「你線上跑的那個 MinIO commit/tag」上，incident note 直接貼輸出即可。

```bash
cd /path/to/minio

git rev-parse --short HEAD

# bucket heal 的入口：admin / peer

grep -RIn "func (a adminAPIHandlers) HealHandler" -n cmd/admin-handlers.go

grep -RIn "HealBucketHandler" -n cmd/peer-rest-server.go | head -n 80

grep -RIn "func healBucketLocal" -n cmd | head -n 80

# bucket heal 內部是否逐一呼叫 HealObject（用 healBucketLocal 所在檔案縮小範圍較準）
# 先找 healBucketLocal 在哪個檔案，再在該檔案內找 HealObject(
FILE=$(grep -RIn "func healBucketLocal" -n cmd | head -n 1 | cut -d: -f1)
[ -n "$FILE" ] && echo "healBucketLocal in: $FILE" && grep -n "HealObject(" "$FILE" | head -n 40

# HealObject heavy path

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 20

grep -RIn "readAllFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 20

grep -RIn "func (e Erasure) Heal" -n cmd/erasure-decode.go

grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 80

# grid watchdog log 的印出點

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive" -n internal/grid/muxserver.go | head -n 50
```

## 3) 現場排查：先把方向分對（網路 vs 對端忙）

同一時間窗（T±5m）先做 3 個 cheapest check：

1) local：TCP retrans/RTO（偏網路）
```bash
ss -tiH '( sport = :9000 or dport = :9000 )' | head -n 120
```

2) remote：磁碟 latency（偏 I/O/資源壓力）
```bash
iostat -x 1 3
```

3) MinIO internal trace：是否 healing/grid handler duration 拉長
```bash
mc admin trace --type internal --json <ALIAS> \
  | jq -r 'select(.funcName|startswith("grid."))
           | [.time,.nodeName,.funcName,.path,.error,.duration] | @tsv'
```

## 4) 跟其他頁面的關聯

- Healing/PutObject 全景呼叫鏈：`docs/trace/putobject-healing-callchain.md`
- `canceling remote connection` 主頁：`docs/troubleshooting/canceling-remote-connection.md`
- code anchors（grid）：`docs/troubleshooting/canceling-remote-connection-codepath.md`

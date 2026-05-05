# Trace：PutObject / Healing — 實際函式 / 檔案 / 呼叫鏈（可 grep 對齊）

> 補強目標：把「PutObject 造成 partial → MRF → Healing」這條路徑，以 **更貼近實際 code 結構** 的方式整理成一張表，讓你在不同 MinIO release / fork 上能用 `grep` 直接定位。
>
> 原則：
> - **不記行號**（避免漂移）
> - 每段附一組最短 anchors
> - 以 `cmd/` 與 `internal/grid/` 為主（現場最常需要對 code）

相關頁：
- PutObject/Healing 概念與大圖：`docs/trace/putobject-healing-callchain.md`
- 實際函式錨點彙總：`docs/trace/putobject-healing-real-functions.md`
- `canceling remote connection` 與 PutObject/Healing 共振：`docs/troubleshooting/canceling-remote-connection-with-putobject-healing.md`

---

## 1) PutObject（HTTP → ObjectLayer）

| 階段 | 目的 | 常見檔案 | 關鍵函式/符號（可 grep） |
|---|---|---|---|
| Router | 對應 API endpoint → handler | `cmd/api-router.go` | `PutObjectHandler` `PutObjectPartHandler` `CopyObjectHandler` |
| Handler | auth/metadata/checksum/streaming → 呼叫 ObjectLayer | `cmd/object-handlers.go` | `func (api objectAPIHandlers) PutObjectHandler` `hash.NewReaderWithOpts` `putOptsFromReq` `.PutObject(ctx` |
| ObjectLayer fan-out | multi-pool → pool → sets | `cmd/erasure-server-pool.go` `cmd/erasure-sets.go` | `func (z *erasureServerPools) PutObject` `func (p *erasureServerPool) PutObject` `func (s *erasureSets) PutObject` |
| Erasure object write | encode/write tmp → rename → commit | `cmd/erasure-object.go` | `func (er erasureObjects) putObject` `newBitrotWriter` `.Encode(ctx` `renameData` `commitRenameDataDir` |

Anchors：
```bash
cd /path/to/minio

# Router/handler
grep -n "PutObjectHandler" cmd/api-router.go
grep -n "func (api objectAPIHandlers) PutObjectHandler" cmd/object-handlers.go

# ObjectLayer / erasure
grep -n "func (z \\*erasureServerPools) PutObject" cmd/erasure-server-pool.go
grep -n "func (s \\*erasureSets) PutObject" cmd/erasure-sets.go
grep -n "func (er erasureObjects) putObject" cmd/erasure-object.go

# disk touch points
grep -n "newBitrotWriter(" cmd/erasure-object.go | head
grep -n "\\.Encode(ctx" cmd/erasure-object.go | head
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head
```

---

## 2) PutObject 失敗後留下 partial（MRF enqueue）

> 典型觸發：rename/commit 階段（或 metadata write）失敗、timeout、disk hang、node/network tail latency。

| 階段 | 目的 | 常見檔案 | 關鍵函式/符號 |
|---|---|---|---|
| record partial | 將 bucket/object/version 記錄為待修復 | `cmd/erasure-object.go` | `func (er erasureObjects) addPartial` `globalMRFState.addPartialOp` |
| enqueue | 寫入 MRF queue（滿了可能 drop） | `cmd/mrf.go` | `type partialOperation` `func (m *mrfState) addPartialOp` |

Anchors：
```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
```

---

## 3) Healing（MRF / scanner / admin）→ ObjectLayer.HealObject → healObject

| 觸發來源 | 檔案 | 對應 call | 你在現場會看到的線索 |
|---|---|---|---|
| MRF consumer | `cmd/mrf.go` | `func (m *mrfState) healRoutine` → `z.HealObject(...)` | repair/h heal logs、以及當併發高時的 tail latency 放大 |
| Scanner | `cmd/data-scanner.go` | `applyHealing` → `.HealObject(` | 長時間掃描、磁碟壓力/IO wait | 
| Admin heal | `cmd/admin-*.go` | `HealHandler` → `.HealObject(` | Console/mc heal 操作後立即上升 |
| ObjectLayer | `cmd/erasure-server-pool.go` `cmd/erasure-sets.go` `cmd/erasure-healing.go` | `(*erasureServerPools).HealObject` → `(*erasureObjects).healObject` | pprof/stack 常落在 `healObject` 或其 fan-out helper |

Anchors：
```bash
cd /path/to/minio

# MRF → HealObject
grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
grep -RIn "HealObject\\(" cmd/mrf.go | head -n 80

# Scanner / Admin
grep -RIn "applyHealing" cmd/data-scanner.go
grep -RIn "HealHandler" cmd/admin-router.go cmd/admin-handlers.go | head -n 80

# ObjectLayer heal
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 40
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 40
```

---

## 4) `canceling remote connection`：把 log 釘到 grid/mux 的 watchdog

> 這句 log 常在兩種情境「放大」：
> 1) node 本身 busy（disk/CPU/GC）導致 ping/pong handler 排程延遲
> 2) 大量 healing/PutObject 併發造成 tail latency，grid RPC 長連線被判定不健康

Anchors：
```bash
cd /path/to/minio

# log 本體
grep -RIn "canceling remote connection" internal/grid | head

# 追 watchdog / ping interval / deadline 設定
grep -RIn "checkRemoteAlive\\(" internal/grid/muxserver.go internal/grid/muxclient.go 2>/dev/null | head -n 120
grep -RIn "Ping" internal/grid | head -n 80
```

建議搭配：
- `pprof`：確認 goroutine 是否大量卡在 rename/fsync/network poll
- `strace`：看 `renameat2/fsync/pwrite` tail latency
- 指標：healing 併發、MRF queue 深度、disk latency、inter-node RTT

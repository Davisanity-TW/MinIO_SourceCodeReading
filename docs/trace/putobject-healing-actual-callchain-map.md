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

### 1.1 PutObject 最短 call chain（把 incident 的 stack/log 對回「卡在哪一段」）

> 你在現場最常想回答的是：「它現在卡在 handler 前置？encode/write tmp？rename/commit？還是 commit 後段的 versions/offline 分支？」
>
> 下面這條鏈用來把任何一段 stack/log 快速對齊到 source tree（不綁行號）。

- `cmd/api-router.go`：`PutObjectHandler`（route）
- `cmd/object-handlers.go`：`func (api objectAPIHandlers) PutObjectHandler`（auth/opts/stream）
  - `.PutObject(ctx, bucket, object, r, opts)`（ObjectLayer interface）
- `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) PutObject`
- `cmd/erasure-sets.go`：`func (s *erasureSets) PutObject`
- `cmd/erasure-object.go`：`func (er erasureObjects) putObject`
  - `newBitrotWriter(...)`（寫入 `.minio.sys/tmp`）
  - `erasure.Encode(ctx, ...)`（fan-out 寫各 disk）
  - `renameData(...)`（tmp → data dir）
  - `commitRenameDataDir(...)`（可見性切換 / metadata commit / versions/offline 分支）

快速把「rename/commit 卡住」釘死：
```bash
cd /path/to/minio

grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 200
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

### （補）addPartial() 真正被呼叫的位置：你要把「哪一種錯誤」對回 PutObject 的哪一段

> 目的：現場看到 PutObject timeout/rename/fsync 相關錯誤時，快速判斷它會不會留下 partial（以及留下的是 bucket/object/version 哪一個）。
>
> 小技巧：先用 `grep -RIn "\\.addPartial\\(" cmd/erasure-object.go` 找到 caller，再往上看是 `renameData/commitRenameDataDir/writeMetadata` 哪一段的 error branch。

Anchors：
```bash
cd /path/to/minio

# 先找呼叫點（caller）
grep -RIn "\\.addPartial\\(" cmd/erasure-object.go | head -n 60

# 然後把它對齊到 rename/commit（常見出事點）
grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 120

# 有些版本會在 commit 後段檢查 offline disks / versions disparity 之類的分支
# 看到 addPartial 周邊有這些字眼，通常就是「寫入達 quorum 但仍留洞」的情境
grep -n "offline" cmd/erasure-object.go | head -n 120
grep -n "versions" cmd/erasure-object.go | head -n 120
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

### 3.1 HealObject 最短 call chain（把「背景修復」對回真正 I/O 熱點）

> 現場你最常想回答的是：「現在是 *誰* 在觸發 healing？最後落在哪些 disk I/O？」
> 下面這條鏈用來把 log/pprof/stack 對回到 source tree。

- 觸發來源之一：`cmd/mrf.go`
  - `func (m *mrfState) healRoutine(...)`（consumer loop）
  - `z.HealObject(ctx, bucket, object, versionID, opts)`（ObjectLayer call）
- ObjectLayer（fan-out / set 選擇）：
  - `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) HealObject(...)`
  - `cmd/erasure-sets.go`：`func (s *erasureSets) HealObject(...)`
- 真正幹活（erasure healing core）：
  - `cmd/erasure-healing.go`：`func (er *erasureObjects) healObject(...)`
    - `erasure.Heal(...)`（讀/寫 shards + reconstruct）
    - `RenameData(...)` / `WriteAll(...)` / `Delete(...)`（依版本與情境差異）

最短 anchors：
```bash
cd /path/to/minio

# MRF consumer → HealObject
grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go

# heal fan-out
grep -RIn "func (z \\*erasureServerPools) HealObject" cmd | head
grep -RIn "func (s \\*erasureSets) HealObject" cmd | head

# healing core
grep -RIn "func (er \\*erasureObjects) healObject" cmd/erasure-healing.go

# 盯 I/O 熱點（不同版本可能叫法略不同，用關鍵字找）
grep -RIn "erasure\\.Heal" cmd/erasure-healing.go cmd | head
grep -RIn "RenameData\\(" cmd | head
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

# Cheat sheet：PutObject → MRF partial → HealObject → `canceling remote connection`

> 目的：incident 現場 3 分鐘內把「PutObject 留洞 → 背景補洞 → grid watchdog 斷線」的**完整呼叫鏈**釘死到 *檔案 + 函式*（避免行號飄移）。
>
> 適用情境：你在 log 同時間看到
> - `canceling remote connection ... not seen for ...`
> - healing/scanner/MRF 很忙（或 PutObject latency 變差）
>
> 建議搭配：
> - `docs/trace/putobject.md`（PutObject 詳細路徑）
> - `docs/trace/healobject-callchain.md`（HealObject 詳細路徑）
> - `docs/troubleshooting/canceling-remote-connection-root-causes.md`

---

## 0) 一句話版（你可以直接貼進 incident note）

**PutObject quorum 過但有 disk offline → `erasureObjects.putObject()` 在 commit 後 `addPartial()` 把 work 丟進 `globalMRFState` → `mrfState.healRoutine()` 背景呼叫 `z.HealObject()` → `erasureObjects.healObject()` 做 `erasure.Heal()` + `disk.RenameData()` 重建/寫回，I/O/排程壓力把 grid ping handler 餓死 → server watchdog `checkRemoteAlive()` 印 `canceling remote connection ... not seen for ...`。**

---

## 1) PutObject：HTTP handler → ObjectLayer → erasure putObject（含檔案/receiver）

1) S3 handler（HTTP 入口）
- `cmd/object-handlers.go`
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`
  - 最終呼叫：`objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

2) multi-pool（選 pool + NSLock）
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

3) sets（hash 到 set）
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

4) objects（真正寫 shards 的地方）
- `cmd/erasure-object.go`
  - `func (er erasureObjects) PutObject(...) (ObjectInfo, error)` → `return er.putObject(...)`
  - `func (er erasureObjects) putObject(...) (ObjectInfo, error)`
    - `erasure.Encode(...)`（寫到 `.minio.sys/tmp`）
    - `renameData(...)` → `commitRenameDataDir(...)`（切換成正式 object）

---

## 2) PutObject 留洞：`addPartial()` → `globalMRFState`（MRF queue）

- `cmd/erasure-object.go`
  - `func (er erasureObjects) addPartial(bucket, object, versionID string)`
    - 典型內容：`globalMRFState.addPartialOp(partialOperation{...})`

- `cmd/mrf.go`
  - `type partialOperation struct { bucket, object, versionID string; versions []byte; ... }`
  - `func (m *mrfState) addPartialOp(op partialOperation)`
    - **重點：non-blocking**（queue 滿會 drop）

---

## 3) 背景補洞：MRF consumer → HealObject → healObject（RS rebuild + RenameData）

1) MRF consumer（背景 goroutine）
- `cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 內部會呼叫 helper `healObject(...)` → `z.HealObject(...)`

2) ObjectLayer HealObject 分層（pool → set → object）
- `cmd/erasure-server-pool.go`
  - `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-sets.go`
  - `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `cmd/erasure-healing.go`
  - `func (er erasureObjects) HealObject(...) (madmin.HealResultItem, error)`
  - `func (er *erasureObjects) healObject(...) (madmin.HealResultItem, error)`
    - `readAllFileInfo(...)` / `objectQuorumFromMeta(...)`（決定來源與 quorum）
    - `erasure.Heal(...)`（重建 shards）
    - `disk.RenameData(...)`（寫回切換點；大量 metadata/rename/fsync）

---

## 4) grid watchdog：為什麼會印 `canceling remote connection`

- `internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`
    - 判斷：`time.Since(time.Unix(LastPing,0)) > lastPingThreshold`
    - 動作：log `canceling remote connection ... not seen for ...` → `m.close()`

- `internal/grid/muxserver.go`
  - `(*muxServer).ping(...)`：收到 ping 時會更新 `LastPing`

> 現場常見誤判：以為是「純網路問題」。但在 healing/rename/fsync 壓力下，**ping handler 也可能只是排不到 CPU 或卡在 I/O**，最後被 watchdog 判定為 remote 不活躍。

---

## 5) 一鍵 grep pack（建議直接貼輸出到 incident note）

```bash
cd /path/to/minio

git rev-parse --short HEAD

# PutObject chain
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd | head
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd | head
grep -RIn "func (er erasureObjects) putObject" -n cmd | head

# partial/MRF
grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go
grep -RIn "type partialOperation" -n cmd/mrf.go
grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go

# HealObject chain
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head

# grid watchdog
grep -RIn "canceling remote connection" -n internal/grid | head
grep -RIn "checkRemoteAlive\\(" -n internal/grid/muxserver.go | head
```

---

## 6) 快速判讀提示（最常用）

- **PutObject 成功回 200/204 但後續 healing 暴增**：優先懷疑 quorum 過但留下 partial（MRF 補洞）。
- **同窗 `canceling remote connection`**：先查 disk latency / CPU throttling / goroutine 排隊，再查網路。
- **想找真正 I/O 熱點**：`(*xlStorage).RenameData()`（rename/fsync/metadata ops）通常比 `erasure.Encode/Heal` 更常是瓶頸。

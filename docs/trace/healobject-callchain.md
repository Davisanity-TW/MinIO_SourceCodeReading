# Trace：HealObject() 呼叫鏈速查（MRF/scanner/admin → ObjectLayer → erasure healObject）

> 目標：把「一次 object healing」在 MinIO 內部的呼叫鏈釘死：
> - 你是從 **MRF**（PutObject 留 partial）、**scanner**（背景掃描）、還是 **admin heal** 進來？
> - `HealObject()` 實際落到哪一層 object layer？
> - 真正做 RS rebuild + 寫回的核心點在哪？
>
> 用法：incident 時直接用本頁的 grep 錨點，在你正在跑的 RELEASE tag 上把 call chain 對齊。

---

## 1) 三個常見觸發來源（誰呼叫 HealObject）

### 1.1 MRF（Most Recently Failed）補洞：PutObject quorum 過但留下 partial

- enqueue（PutObject 端）：`cmd/erasure-object.go`
  - `erasureObjects.putObject()` → `er.addPartial(bucket, object, versionID)`
  - `addPartial()` → `globalMRFState.addPartialOp(partialOperation{...})`

- dequeue + execute（MRF 消費端）：`cmd/mrf.go`
  - `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 出隊後會走 helper `healObject(...)` → `z.HealObject(...)`

釘死錨點：
```bash
cd /path/to/minio

# PutObject -> MRF enqueue
grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\.addPartialOp" -n cmd/erasure-object.go

# MRF consumer
grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "func healObject" -n cmd/mrf.go
```

### 1.2 Scanner（背景掃描）直接觸發 healing

- `cmd/data-scanner.go`
  - `func (i *scannerItem) applyHealing(ctx context.Context, o ObjectLayer, oi ObjectInfo) (size int64)`
  - 會呼叫：`o.HealObject(ctx, bucket, object, versionID, healOpts)`

錨點：
```bash
cd /path/to/minio

grep -RIn "func (i \*scannerItem) applyHealing" -n cmd/data-scanner.go
# 看它怎麼組 healOpts（NormalScan vs DeepScan）
grep -RIn "HealDeepScan|HealNormalScan" -n cmd/data-scanner.go | head -n 50
```

### 1.3 Admin heal（手動/工具）：`mc admin heal ...`

- router：`cmd/admin-router.go`（`/minio/admin/v3/heal*`）
- handler：`cmd/admin-handlers.go`
  - `func (a adminAPIHandlers) HealHandler(w http.ResponseWriter, r *http.Request)`
  - 最終仍會落到 `objAPI.HealObject(...)`（或 HealBucket/HealFormat）

錨點：
```bash
cd /path/to/minio

grep -RIn "HealHandler" -n cmd/admin-router.go cmd/admin-handlers.go | head -n 80
grep -RIn "HealObject\(" -n cmd/admin-handlers.go | head -n 120
```

---

## 2) ObjectLayer：HealObject 的主呼叫鏈（pool → sets → objects → healObject）

> 這段是把 healing 真正進入 object layer 後的分層釘死；你要看 lock/pool/set/quorum 的決策點時，通常在這裡下斷點最快。

1) multi-pool：`cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

2) sets：`cmd/erasure-sets.go`
- `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

3) objects wrapper → core：`cmd/erasure-healing.go`
- `func (er erasureObjects) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`
- `func (er *erasureObjects) healObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

錨點：
```bash
cd /path/to/minio

grep -RIn "func (z \*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \*erasureSets) HealObject" -n cmd/erasure-sets.go

grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go
grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go
```

---

## 3) healObject() 內部：最常需要看的 4 個切點（讀/算/quorum → rebuild → tmp → RenameData 寫回）

> 你要把「healing 很慢/很吃 I/O」對到具體 code，通常就看這四段。

1) **讀取 metadata + 決定 quorum / 最新版本**
- `readAllFileInfo(...)`
- `objectQuorumFromMeta(...)`
- `pickValidFileInfo(...)`

2) **初始化 RS encoder + 選擇要補的 disks/parts**
- `NewErasure(...)`
-（依 errs/partsMetadata 決定 outdated disks/parts）

3) **重建每個 part：讀來源 → `erasure.Heal(...)` → 寫 tmp**
- 讀：`newBitrotReader(...)`
- 寫：`newBitrotWriter(...)`
- 核心：`erasure.Heal(ctx, writers, readers, partSize, prefer)`

4) **寫回切換：`StorageAPI.RenameData(...)`**
- 介面：`cmd/storage-interface.go`：`RenameData(...)`
- 常見實作：`cmd/xl-storage.go`：`func (s *xlStorage) RenameData(...)`

錨點：
```bash
cd /path/to/minio

# healObject 內部核心
grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go | head -n 50
grep -RIn "objectQuorumFromMeta\(" -n cmd/erasure-healing.go | head -n 50

grep -RIn "NewErasure\(" -n cmd/erasure-healing.go | head -n 50

grep -RIn "\.Heal(ctx" -n cmd/erasure-healing.go cmd/erasure-decode.go | head -n 80

grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 120
```

---

## 4) 跟 troubleshooting 的連結：為什麼 healing 忙時容易一起看到 `canceling remote connection`

當 healing/MRF/scanner 把磁碟 I/O（尤其 rename/fsync/metadata ops）打滿時，peer-to-peer 的 grid streaming mux 可能在 ~60s 內「看不到對端 ping 被處理」而觸發 watchdog：
- `internal/grid/muxserver.go`：`checkRemoteAlive()` → `canceling remote connection ... not seen for ...`

延伸：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/trace/putobject-healing-callchain.md`

# Trace：PutObject（S3）呼叫鏈（MinIO）

> 目標：把「S3 PutObject → ObjectLayer → erasure 寫入 → rename/commit」對應到 *檔案 + 函式*，方便你在不同版本/commit 間用 grep 穩定定位。
>
> 關聯：
> - `docs/trace/putobject-healing-callchain-cheatsheet.md`（PutObject 留洞 → MRF 補洞 → grid watchdog）
> - `docs/trace/healing.md`（Healing 全景）

---

## 1) HTTP 入口：S3 handler

- 檔案：`cmd/object-handlers.go`
- 典型函式：
  - `func (api objectAPIHandlers) PutObjectHandler(w http.ResponseWriter, r *http.Request)`

你要抓的重點：
- **bucket/object** 從路由/vars 解出來
- 會建立 request context（trace/span/log tags）
- 最終會呼叫到 ObjectLayer：
  - `objectAPI.PutObject(ctx, bucket, object, pReader, opts)`

> 實務：incident 現場多半先從 handler 開始 grep（因為 log/stack 常會指到 handler）。

---

## 2) ObjectLayer 分層：serverPools → sets → erasureObjects

PutObject 一般會按這個層級下去（目的是：選 pool、選 set、取 lock、做 shard 寫入）：

1) serverPools
- 檔案：`cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

2) sets
- 檔案：`cmd/erasure-sets.go`
- `func (s *erasureSets) PutObject(ctx context.Context, bucket, object string, data *PutObjReader, opts ObjectOptions) (ObjectInfo, error)`

3) objects（真正幹活的地方）
- 檔案：`cmd/erasure-object.go`
- `func (er erasureObjects) PutObject(...) (ObjectInfo, error)`
  - 典型：`return er.putObject(...)`
- `func (er erasureObjects) putObject(...) (ObjectInfo, error)`

---

## 3) 重要轉折點：temp write → commit rename

在 `erasureObjects.putObject()` 內，你要特別盯「切換成正式 object」的那段：

- `erasure.Encode(...)`：把資料切 shard 寫到暫存路徑（常見是 `.minio.sys/tmp` 一類的位置）
- `renameData(...)` / `commitRenameDataDir(...)`：
  - **把暫存資料 rename 成正式 object 目錄/檔案**
  - 這裡通常會牽涉到 metadata、fsync、rename、以及跨磁碟/跨 mount 的錯誤處理

與底層磁碟操作相關的常見落點（實際名稱/receiver 可能會因版本略有差異，用 grep 定位）：

- 檔案：`cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(...) error`
  - `func (s *xlStorage) renameFile(...)`（若存在）

- 檔案：`cmd/storage-interface.go`
  - `type StorageAPI interface { RenameData(...) ... }`

> 為什麼這段最重要：很多 PutObject 的尾端 latency、以及後續 healing/MRF 的壓力，根源其實在 rename/fsync/metadata IO（而不是 encode 本身）。

---

## 4) PutObject 留洞（partial）是怎麼發生的

常見情境：
- quorum 過了（client 看到成功），但部分 disk 失敗/離線/timeout
- 或 commit/rename 在某些 disk 失敗

這時 MinIO 會把「需要補洞」的工作丟到 MRF（Metastate / Missing Replica Fixer）或 healing queue：

- 檔案：`cmd/erasure-object.go`
- 函式：`func (er erasureObjects) addPartial(bucket, object, versionID string)`
  - 典型：`globalMRFState.addPartialOp(...)`

後續補洞路徑請接 `docs/trace/putobject-healing-callchain-cheatsheet.md`。

---

## 5) 現場用的 grep pack（穩定定位）

```bash
cd /path/to/minio

git rev-parse --short HEAD

# handler
grep -RIn "func (api objectAPIHandlers) PutObjectHandler" -n cmd/object-handlers.go

# object layer PutObject
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd | head
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd | head
grep -RIn "func (er erasureObjects) putObject" -n cmd | head

# rename/commit hot path
grep -RIn "commitRenameDataDir" -n cmd | head
grep -RIn "renameData" -n cmd/erasure-object.go cmd/xl-storage.go | head
grep -RIn "RenameData\\(" -n cmd/xl-storage.go cmd/storage-interface.go cmd/erasure-healing.go | head

# partial/MRF
grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go
```

---

## 6) 你應該順便記的兩個觀察點（Troubleshooting 方向）

- 如果你看到 `canceling remote connection` 同時 PutObject latency/queue/mrf 飆高：別只看網路，先看 **IO latency / CPU throttling / goroutine backlog**。
- 如果 MRF queue 有 drop（滿了）：就會出現「洞沒補上、問題拖很久」的尾巴；把 MRF 指標/日誌一起抓進 incident note。

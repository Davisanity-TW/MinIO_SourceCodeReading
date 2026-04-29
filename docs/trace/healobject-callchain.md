# Trace：HealObject 呼叫鏈（MinIO）

> 目標：把「誰觸發 HealObject（MRF / scanner / admin heal）→ ObjectLayer → erasure healObject → erasure.Heal + RenameData」釘到 *檔案 + 函式*。
>
> 關聯：
> - `docs/trace/putobject-healing-callchain-cheatsheet.md`
> - `docs/trace/admin-heal.md`
> - `docs/troubleshooting/canceling-remote-connection-root-causes.md`

---

## 1) 常見觸發來源（Trigger）

### A) PutObject 留洞 → MRF background heal

- 檔案：`cmd/mrf.go`
- `func (m *mrfState) healRoutine(z *erasureServerPools)`
  - 會從 queue 取出 `partialOperation`
  - 呼叫 `z.HealObject(ctx, bucket, object, versionID, opts)`

### B) scanner / background healing

- 依版本不同，scanner/heal 的入口檔案可能在：
  - `cmd/background-heal-*.go`
  - `cmd/data-scanner.go`
  - `cmd/heal-*.go`

> 建議用 grep 以函式名稱/關鍵字定位（例如 `HealObject(`、`healRoutine`、`scanner`、`bgHeal`）。

### C) 管理者觸發：mc admin heal

- 請見：`docs/trace/admin-heal.md`

---

## 2) ObjectLayer HealObject：serverPools → sets → erasureObjects

1) serverPools
- 檔案：`cmd/erasure-server-pool.go`
- `func (z *erasureServerPools) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

2) sets
- 檔案：`cmd/erasure-sets.go`
- `func (s *erasureSets) HealObject(ctx context.Context, bucket, object, versionID string, opts madmin.HealOpts) (madmin.HealResultItem, error)`

3) objects
- 檔案：`cmd/erasure-healing.go`
- `func (er erasureObjects) HealObject(...) (madmin.HealResultItem, error)`
  - 典型：呼叫 `er.healObject(...)`
- `func (er *erasureObjects) healObject(...) (madmin.HealResultItem, error)`

---

## 3) healObject 內的關鍵階段（你要抓的 call chain）

在 `erasureObjects.healObject()` 你通常會看到：

- `readAllFileInfo(...)`：把各 disk 的 xl.meta / 物件資訊讀出來
- `objectQuorumFromMeta(...)` / 類似函式：
  - 決定「哪些 disks 作為來源」
  - 判定 quorum
- `erasure.Heal(...)`：
  - 這是 Reed-Solomon rebuild shards 的核心
- `disk.RenameData(...)`：
  - 寫回 shards 並切換/commit
  - rename/fsync/metadata IO 通常是最痛的地方

底層磁碟 API 常見落點：

- 檔案：`cmd/xl-storage.go`
  - `func (s *xlStorage) RenameData(...) error`

- 檔案：`cmd/storage-interface.go`
  - `type StorageAPI interface { RenameData(...) ... }`

---

## 4) 為什麼 HealObject 會連動到 `canceling remote connection`

在 healObject/renameData 壓力很大時（尤其是大量 small objects 或 metadata ops），可能造成：
- goroutine 排隊 / scheduler latency
- IO 等待拉長
- grid ping handler 來不及處理

最後 watchdog 在 `internal/grid/muxserver.go` 看到 remote ping 很久沒更新，就會 log：
- `canceling remote connection ... not seen for ...`

完整鏈請見：`docs/trace/putobject-healing-callchain-cheatsheet.md` 第 4 節。

---

## 5) 現場用 grep pack

```bash
cd /path/to/minio

git rev-parse --short HEAD

# HealObject chain
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head
grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head

grep -RIn "erasure\\.Heal\\(" -n cmd | head
grep -RIn "RenameData\\(" -n cmd/xl-storage.go cmd/storage-interface.go cmd/erasure-healing.go | head

# grid watchdog
grep -RIn "canceling remote connection" -n internal/grid | head
```

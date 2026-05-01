# PutObject Healing：實際呼叫鏈（含檔案/函式）

> 目的：把「PutObject 過程中觸發 healing / re-read / quorum retry」的路徑，用 *實際函式/檔案* 串起來，方便你 grep + 下斷點。
>
> 注意：MinIO 版本差異很大（尤其是 healing/erasure 與 grid RPC 一路）。本頁用「你 repo 目前追的 commit」為準；若你換 commit，請用文末的 `grep pack` 快速重新對齊。

## TL;DR（你要找的最短路徑）

1) S3 API handler
- `cmd/object-handlers.go`
  - `PutObjectHandler()`

2) ObjectLayer.PutObject
- `cmd/erasure-server-pool.go`
  - `(*erasureServerPools).PutObject()`

3) XL/erasure object layer
- `cmd/erasure-object.go`
  - `(*erasureObjects).PutObject()`
  - 內部會進入寫入資料 + 產生 metadata（`xl.meta`）的流程

4) 寫入分片 / inline heal / read-after-write 檢查
- `cmd/erasure-multipart.go` / `cmd/erasure-object.go`
  - 常見會經過（依版本/路徑不同）：
    - `putObject()` / `putObjectPart()`
    - `erasureEncode()` / `erasureEncodeAndWrite()`

5) 若遇到磁碟回報 partial failure / inconsistent state → 走 healing-ish 的重試/修復
- 關鍵點在於：
  - 「一次 PutObject」不一定直接呼叫 *完整 HealObject*；
  - 但它會觸發 **同一套**：quorum 計算、read-repair、或後續 background heal queue。

> 你可以把這件事理解成：PutObject 會先盡力完成本次寫入；若發現某些 disk 狀態不一致，會把修復工作「內嵌」在 I/O 流程裡（read-repair / rewrite metadata），或把修復排到後台（MRF/Heal）。

---

## 詳細呼叫鏈（建議下斷點的節點）

### A. API → ObjectLayer

- `PutObjectHandler()`（HTTP entrypoint）
  - 解析 request / auth / bucket policy
  - 建立 `objectAPI := api.ObjectAPI()`
  - 呼叫 `objectAPI.PutObject()`

### B. ServerPools → erasureObjects

- `(*erasureServerPools).PutObject()`
  - 選擇 pool / set（依 bucket placement / erasure set 設計）
  - 取得對應的 `erasureObjects`

- `(*erasureObjects).PutObject()`
  - 走「single object put」主流程
  - 你在追 healing 時，通常要看：
    - 計算 write quorum / read quorum
    - 遇到 disk error 時的降級/重試

### C. 可能發生「修復/補齊」的幾個典型位置

> 下列函式名稱會依版本有差異；但概念上你要找的是：
> - **write metadata 失敗** → 是否有 rewrite / update / inline repair
> - **讀取 xl.meta / part 失敗** → 是否有 read-repair

1) `xl.meta` 讀取/驗證點
- 你要找包含以下關鍵字的函式：
  - `readXLMeta`, `readAllXLMetadata`, `readQuorum`, `reduceReadQuorumErrs`

2) 寫入分片與 metadata 的 quorum 決策
- 常見關鍵字：
  - `writeQuorum`, `reduceWriteQuorumErrs`, `countErrs`, `isQuorum`

3) Read-repair / 重建 metadata / 重建 part 的入口
- 常見關鍵字：
  - `heal`, `repair`, `reconstruct`, `rebuild`, `erasureDecode`, `putMetacache`

4) Background heal queue / MRF
- 若你看到 PutObject 路徑最後只「記錄」要修復，下一步就是去追：
  - `docs/trace/healing.md`
  - `docs/trace/peer-rest-healing.md`
  - `docs/troubleshooting/canceling-remote-connection-when-putobject-healing-hot.md`

---

## 實作：如何快速對齊你現在的 MinIO 版本

> 你不需要一次把整條鏈完全背起來；你需要能「快速定位」你要追的那一段。

### 1) 先找 PutObject handler → objectAPI.PutObject

```bash
rg -n "func \(.*\) PutObjectHandler" -S cmd/
rg -n "PutObject\(" -S cmd/object-handlers.go
```

### 2) 找 erasureServerPools / erasureObjects PutObject

```bash
rg -n "type erasureServerPools" -S cmd/
rg -n "func \(\*erasureServerPools\) PutObject" -S cmd/
rg -n "func \(\*erasureObjects\) PutObject" -S cmd/
```

### 3) 把 healing-ish 關鍵字掛上去

```bash
rg -n "(readQuorum|writeQuorum|reduce(Read|Write)QuorumErrs|heal|repair|reconstruct)" -S cmd/erasure-*.go cmd/xl-storage*.go
```

---

## 連結（本知識庫內）

- PutObject overview：`docs/trace/putobject.md`
- PutObject + Healing（主頁）：`docs/trace/putobject-healing.md`
- Healing 主頁：`docs/trace/healing.md`
- `canceling remote connection` 與 PutObject healing 關聯：
  - `docs/troubleshooting/canceling-remote-connection-with-putobject-healing.md`
  - `docs/troubleshooting/canceling-remote-connection-when-putobject-healing-hot.md`

---

## 待補（下一輪）

- 把本頁的函式清單改成「精確到 commit + line anchor」：
  - 方案：新增一個 `docs/trace/putobject-healing-anchors-<commit>.md`（沿用你現有命名習慣）
- 補上 PutObject 路徑中「內嵌修復」與「後台修復」的分界點：
  - 例如：哪裡會 enqueue heal、哪裡會直接 rewrite metadata。

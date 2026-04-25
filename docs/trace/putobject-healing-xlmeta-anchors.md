# Trace：PutObject / Healing 與 `xl.meta`（讀寫點、函式錨點、呼叫鏈）

> 目的：把 PutObject（寫入）與 Healing（補洞/重建）**在 `xl.meta` 上的讀寫點**釘死成可 grep 的錨點。
>
> 為什麼要單獨拉一頁：現場排查常卡在「到底是在讀 meta 還是在寫 data？」——而 `xl.meta`（metadata fan-out / quorum / choose reference）就是 PutObject tail latency、Healing 放大、以及後續 `canceling remote connection` 共振的常見起點。

延伸閱讀：
- `docs/trace/putobject-healing-callchain.md`（主流程 call chain）
- `docs/troubleshooting/canceling-remote-connection.md`

---

## 0) 你要先記住的 3 個觀念

1) **PutObject** 會先把 data shards 寫到 `.minio.sys/tmp`，最後做 rename/commit；在這段過程會產出/更新 `xl.meta`（以及版本/ETag/checksum 等）。

2) **Healing** 的第一步往往是「讀一圈 `xl.meta`」，做 quorum/選 reference；然後才是 RS rebuild + 對缺片 disks 寫回 + rename/commit。

3) 只要你看到：
- `readAllFileInfo(...)` / `pickValidFileInfo(...)` 這類 fan-out/quorum
- 或 `RenameData(...)` / `xlStorage.RenameData(...)`

那你其實已經非常接近「能用一句話把現象解釋清楚」的等級了：
- **卡 readAllFileInfo**：偏「讀 meta / list / 小檔 metadata I/O」
- **卡 RenameData**：偏「rename/fsync/metadata ops」

---

## 1) Healing：`readAllFileInfo()` 是 `xl.meta` fan-out 的第一個關鍵錨點

Healing 的 heavy path 入口通常在：
- `cmd/erasure-healing.go`
  - `func (er *erasureObjects) healObject(ctx, bucket, object, versionID string, opts madmin.HealOpts) ...`

而你要釘的第一個 meta 相關錨點通常是：
- `readAllFileInfo(...)`：對所有 disks 讀 `xl.meta`（或等價的 FileInfo metadata）

建議在你對應的 MinIO source tree 直接這樣釘：
```bash
cd /path/to/minio

# healing 入口
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head

# xl.meta fan-out
grep -RIn "readAllFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40

# 選 reference / quorum（常見會一起出現）
grep -RIn "pickValidFileInfo\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
grep -RIn "objectQuorumFromMeta\\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40
```

現場判讀：
- 若 `readAllFileInfo()` 花很久：通常是「很多小 I/O」+「部分 disk latency/queue」造成 tail latency。
- 如果這時 cluster 同步還在跑 scanner/MRF/admin heal：很容易把 peer RPC / grid mux 的長連線塞滿，最後把 `canceling remote connection` 放大成明顯 symptom。

---

## 2) PutObject：`putObject()` 內 meta/commit 的錨點（版本/versions disparity/partial）

PutObject 的主流程通常在：
- `cmd/erasure-object.go`
  - `func (er erasureObjects) putObject(...) (ObjectInfo, error)`

你要優先釘的 3 個點：

### 2.1 `renameData(...)` / `commitRenameDataDir(...)`

PutObject 的「tmp → 正式」與「可見性切換」通常在：
- `renameData(...)`
- `commitRenameDataDir(...)`

```bash
cd /path/to/minio

grep -n "func (er erasureObjects) putObject" cmd/erasure-object.go

grep -n "^func renameData" cmd/erasure-object.go
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 80

# 逐 disk 的 RenameData（src/dst bucket/entry + FileInfo）
grep -n "\\.RenameData(ctx" cmd/erasure-object.go | head -n 120
```

### 2.2 `addPartial(...)` / `globalMRFState.addPartialOp(...)`

當 PutObject 成功但留下洞（partial），常見會 enqueue 到 MRF：
- `cmd/erasure-object.go`：`addPartial(...)`
- `cmd/mrf.go`：`mrfState.addPartialOp(...)` / `healRoutine(...)`

```bash
cd /path/to/minio

grep -n "func (er erasureObjects) addPartial" cmd/erasure-object.go

grep -n "type partialOperation" cmd/mrf.go
grep -n "func (m \\*mrfState) addPartialOp" cmd/mrf.go
grep -n "func (m \\*mrfState) healRoutine" cmd/mrf.go
```

### 2.3（你最容易漏寫在筆記裡的）versions disparity

如果你看到同一個 object 在短時間被 heal 多次：
- 很可能是 PutObject 在 commit/rename 後偵測到 versions disparity，導致 enqueue 多個版本給 MRF。

```bash
cd /path/to/minio

# PutObject 端：commit 後處理 versions bytes 的痕跡
grep -n "commitRenameDataDir" cmd/erasure-object.go | head -n 50
grep -n "versions" cmd/erasure-object.go | head -n 160

# MRF 端：把 versions bytes 切成多個 VersionID
grep -n "len(u\\.versions" cmd/mrf.go
```

---

## 3) 一句話模板（方便你寫 incident note / postmortem）

- **Healing 放大（meta fan-out）**：大量 `HealObject()` 觸發後，`(*erasureObjects).healObject()` 先做 `readAllFileInfo()` 讀一圈 `xl.meta` 做 quorum/挑 reference；若部分 disks tail latency 升高，會放大背景任務耗時並堆積 peer RPC。

- **PutObject 尾端變慢（commit/rename）**：`erasureObjects.putObject()` 的 `renameData()` / `commitRenameDataDir()` 對各 disk 做 `RenameData()`（rename/fsync/metadata ops），在磁碟/FS latency 尖峰時容易拉高 tail latency，並與 healing/MRF 同時間窗共振。

---

## 4) 跟 `canceling remote connection` 的連結（你要在現場快速答的那句）

如果同一時間窗：
- PutObject commit/rename 很慢（`RenameData`）
- 或 healing/scanner 在跑（`readAllFileInfo` + RS rebuild + `RenameData`）

那 `canceling remote connection ... not seen for ~60s` 往往是「peer RPC / grid mux 的 ping handler 排不到」或「長連線被 backlog/節流」的結果。

（grid watchdog 的 code anchors 請直接看：`docs/trace/grid-canceling-remote-connection.md`）

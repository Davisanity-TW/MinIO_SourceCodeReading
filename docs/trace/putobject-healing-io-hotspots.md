# Trace：PutObject / Healing 的 I/O 熱點（實際函式 / 檔案 / 觀測對位）

> 目標：把「PutObject 寫入」與「Healing 補洞」最容易把 node 壓爆的 I/O 熱點，用**實際函式名 + 檔案路徑**釘死。
>
> 使用方式：
> 1) 先用這頁的 grep 把你線上跑的版本（tag/fork）對齊到同一批函式錨點
> 2) 再用 pprof / SIGQUIT stackdump / strace 把現象（latency / iostat / canceling remote connection）對回到同一段 code path

延伸：
- PutObject/Healing 完整 call chain：`docs/trace/putobject-healing-callchain.md`
- `canceling remote connection` code anchors：`docs/troubleshooting/canceling-remote-connection-codepath.md`

---

## 0) 先固定版本（避免跨 tag 比對失焦）

在你的 MinIO source tree：
```bash
cd /path/to/minio

git rev-parse --short HEAD
```

如果你要把錨點輸出貼進 incident note，建議一併貼：
- `git rev-parse --short HEAD`
- `go env GOPATH GOMOD GOROOT`（或至少 go version）

---

## 1) PutObject：最常見的「尾端慢」熱點

PutObject 常見現象：
- request 大量成功，但 tail latency 明顯拉長
- disk busy / metadata ops（await, util）尖峰
- 同時背景 MRF/Healing 在跑時，容易共振出 `canceling remote connection`

### 1.1 `.minio.sys/tmp` 寫入（encode + bitrot writer）

**典型落點：**
- `cmd/erasure-object.go`
  - `func (er erasureObjects) putObject(...)`
  - `newBitrotWriter(...)`
  - `erasure.Encode(...)`

釘死：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go

grep -RIn "newBitrotWriter\(" -n cmd/erasure-object.go | head -n 50
grep -RIn "\.Encode\(" -n cmd/erasure-object.go | head -n 50
```

觀測對位（現場）：
- pprof：goroutine/CPU 可能會看到 encode/hash/bitrot
- iostat：通常是 sequential write + metadata update 混在一起（視 disks/FS）

### 1.2 tmp → 正式：`renameData()` / `commitRenameDataDir()`（最常見的 tail 放大器）

**典型落點：**
- `cmd/erasure-object.go`
  - `func renameData(...)`
  - `commitRenameDataDir(...)`
  - 逐 disk 呼叫 `disk.RenameData(...)`（走到 storage layer）

釘死：
```bash
cd /path/to/minio

grep -RIn "^func renameData" -n cmd/erasure-object.go
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head -n 120

grep -RIn "\\.RenameData\(ctx" -n cmd/erasure-object.go | head -n 120
```

觀測對位：
- stackdump 常會停在 `xlStorage.RenameData` 或其下方 syscall（rename/fsync）
- strace 建議短窗對位（見 3.2）

### 1.3 partial / versions disparity → MRF enqueue（造成後續 healing 壓力）

**典型落點：**
- `cmd/erasure-object.go`：`addPartial()` → `globalMRFState.addPartialOp(...)`
- `cmd/mrf.go`：`(m *mrfState) healRoutine(...)` consumer

釘死：
```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "func healObject\(" -n cmd/mrf.go
```

實務意義：
- PutObject 本身可能不慢，但它留下 partial 後，MRF/Scanner 會在背景補洞 → I/O 放大

---

## 2) Healing：最常見的「IOPS 打滿 / metadata fan-out」熱點

### 2.1 `HealObject()` → `(*erasureObjects).healObject()`（重建主線）

**典型落點：**
- `cmd/erasure-server-pool.go`：`(z *erasureServerPools) HealObject(...)`
- `cmd/erasure-sets.go`：`(s *erasureSets) HealObject(...)`
- `cmd/erasure-healing.go`：`(er erasureObjects) HealObject(...)` / `(*erasureObjects) healObject(...)`

釘死：
```bash
cd /path/to/minio

grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd | head -n 50
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd | head -n 50

grep -RIn "func (er erasureObjects) HealObject" -n cmd | head -n 50
grep -RIn "func (er \\*erasureObjects) healObject" -n cmd | head -n 50
```

### 2.2 metadata fan-out：`readAllFileInfo()`（大量讀 xl.meta / list disk 狀態）

**典型落點：**
- `cmd/erasure-healing.go` 或同名拆檔（版本差異）

釘死：
```bash
cd /path/to/minio

grep -RIn "readAllFileInfo\\(" -n cmd | head -n 80
```

觀測對位：
- iostat：read latency 增加（尤其某幾顆 disk 異常慢時）
- pprof：大量 goroutine 卡在 disk 讀 meta（FileInfo/xl.meta）

### 2.3 RS rebuild：`func (e Erasure) Heal(...)`（真正重建缺片）

**典型落點：**
- `cmd/erasure-decode.go`：`func (e Erasure) Heal(...)`

釘死：
```bash
cd /path/to/minio

grep -RIn "func (e Erasure) Heal" -n cmd/erasure-decode.go
```

### 2.4 healing writeback / commit：`StorageAPI.RenameData()`（同 PutObject 的尾端放大器）

**典型落點：**
- `cmd/storage-interface.go`：`RenameData(...)`
- `cmd/xl-storage.go`：`func (s *xlStorage) RenameData(...)`
- `cmd/erasure-healing.go`：對缺片 disks 逐顆呼叫 `RenameData()`

釘死：
```bash
cd /path/to/minio

grep -RIn "RenameData\(ctx" -n cmd/storage-interface.go
grep -RIn "func (s \\*xlStorage) RenameData" -n cmd/xl-storage.go

grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/*.go | head -n 120
```

---

## 3) Troubleshooting 對位：如何把 `canceling remote connection` 跟 I/O 熱點串起來

> 常見誤判：看到 `canceling remote connection ... not seen for ~60s` 就先怪網路。
>
> 實務上，當 node 被 PutObject rename/fsync 或 Healing writeback 壓住時，grid 的 ping/pong handler 可能排不到 → 先表現成 grid mux disconnect。

### 3.1 grid watchdog 錨點（server 端 ~60s、client 端 ~30s）

釘死：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "clientPingInterval" -n internal/grid | head -n 80
```

### 3.2 strace：證明卡在 rename/fsync（最省事的現場證據）

> 只建議短時間窗（例如 10–20 秒）抓取，以免影響系統。

```bash
# 先找 pid
pgrep -fa "minio server" | head

# 再短窗觀察 rename/fsync 相關 syscall
sudo strace -fp <pid> -tt -T \
  -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,unlink,openat \
  -s 120
```

判讀：
- 如果你看到 `fsync(...) <10.000123>` 這種長尾，同時間又有 healing/mrf 活躍，`canceling remote connection` 幾乎一定只是結果。

---

## 4) 建議你在 incident note 裡固定貼的「三段最短證據鏈」

1) PutObject 尾端：
- `renameData` / `commitRenameDataDir` / `.RenameData(` 的 grep 結果

2) Healing 主線：
- `(*erasureObjects).healObject` / `readAllFileInfo` / `Erasure.Heal` 的 grep 結果

3) grid watchdog：
- `canceling remote connection` / `checkRemoteAlive` / `clientPingInterval` 的 grep 結果

這樣別人 review 你的筆記時，不用靠推測就能對齊 code path。

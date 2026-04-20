# Grep pack：PutObject / Healing 一鍵釘錨（不靠行號）

> 目的：在不同 MinIO RELEASE tag / fork 之間行號很容易漂移。
> 這份「grep pack」把 PutObject 與 Healing 的關鍵呼叫鏈用 *函式簽名 + 檔案* 固定下來，讓你在 incident note 裡可以貼出「可回溯」的 code anchors。

使用方式：
- 把下面的指令在「你線上跑的那個 MinIO source tree（對應 release tag/commit）」執行
- 把輸出的 `檔案:行號` + `git rev-parse --short HEAD` 貼進事件筆記

---

## 0) 先固定版本（必要）

```bash
cd /path/to/minio

git rev-parse --short HEAD

git status -sb
```

---

## 1) PutObject 主線（handler → ObjectLayer → erasureObjects.putObject）

```bash
cd /path/to/minio

# HTTP handler 入口
grep -RIn "PutObjectHandler" -n cmd/object-handlers.go

# ObjectLayer：pool / sets / object
grep -RIn "func (z \\*erasureServerPools) PutObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) PutObject" -n cmd/erasure-sets.go

# erasureObjects：putObject 主流程
grep -RIn "func (er erasureObjects) PutObject" -n cmd/erasure-object.go
grep -RIn "func (er erasureObjects) putObject" -n cmd/erasure-object.go
```

### 1.1 PutObject 的「落盤切換點」：tmp → rename/commit

```bash
cd /path/to/minio

# tmp → 正式路徑
grep -RIn "^func renameData\\(" -n cmd/erasure-object.go

# commit：DataDir 切換（讓新版本對外可見）
grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go | head -n 50

# storage 層 RenameData（PutObject / Healing 最後都會落到這個介面/實作）
grep -RIn "RenameData\\(" -n cmd/storage-interface.go cmd/xl-storage.go | head -n 50
```

---

## 2) PutObject 寫成功但留下缺片：partial → MRF queue

```bash
cd /path/to/minio

# PutObject 在哪裡決定要丟 partial（enqueue）
grep -RIn "addPartial\\(" -n cmd/erasure-object.go | head -n 80
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go | head -n 80

# MRF：partialOperation 結構 + queue 入口（注意 select default：滿了會 drop）
grep -RIn "type partialOperation" -n cmd/mrf.go
grep -RIn "func (m \\*mrfState) addPartialOp" -n cmd/mrf.go
```

---

## 3) MRF consumer：healRoutine → HealObject（ObjectLayer）

```bash
cd /path/to/minio

# MRF 背景消費端（出隊後會呼叫 healObject helper / HealObject）
grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "func healObject" -n cmd/mrf.go

# ObjectLayer HealObject（pool → sets → erasureObjects）
grep -RIn "func (z \\*erasureServerPools) HealObject" -n cmd/erasure-server-pool.go
grep -RIn "func (s \\*erasureSets) HealObject" -n cmd/erasure-sets.go
```

---

## 4) Healing 真正重建/寫回：(*erasureObjects).healObject → erasure.Heal → RenameData

```bash
cd /path/to/minio

# wrapper vs heavy path（兩個都抓，避免不同版本 receiver 變動）
grep -RIn "func (er erasureObjects) HealObject" -n cmd/erasure-healing.go
grep -RIn "^func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

# RS rebuild 核心（不同版本可能叫 Heal/HealData 等，先抓最常見）
grep -RIn "\\.Heal\\(ctx" -n cmd/erasure-healing.go cmd/*.go | head -n 50

# 寫回切換點（tmp → 正式 object dataDir）
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 80
```

---

## 5) 跟 `canceling remote connection` 交叉驗證（grid watchdog）

> 你在 incident 裡若同時看到 healing/MRF 很忙 + grid 斷線，建議把這個 watchdog 也一起釘死。

```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 20

grep -RIn "checkRemoteAlive" -n internal/grid | head -n 50

grep -RIn "clientPingInterval" -n internal/grid | head -n 50
```

---

## 6) 建議你在 incident note 固定貼的 3 個錨點（最省字但夠回溯）

1) `git rev-parse --short HEAD`
2) PutObject partial enqueue：`cmd/erasure-object.go` 的 `addPartial()` / `globalMRFState.addPartialOp(...)`
3) Healing writeback：`cmd/erasure-healing.go` 的 `(*erasureObjects).healObject()` + `RenameData(...)`

> 有了這三個點，你後續要把「PutObject 成功但留洞 → MRF/Healing 補洞 → I/O 壓力 → grid 心跳延遲」串起來，通常就不會缺關鍵證據。

# Troubleshooting：`canceling remote connection`（grid muxserver 精準錨點：檔案/函式/欄位）

> 目的：把 `canceling remote connection` 這句 log **精準釘到 MinIO code**（不靠行號），並補齊你在 incident note 最常需要的欄位：
> - 是誰印這句 log？（哪個檔案/哪個 function）
> - 斷線判定依據是什麼？（LastPing / threshold / timer loop）
> - 你要怎麼在「你線上跑的那個 RELEASE/commit」快速跳轉到同一段 code？

> 適用情境：你在 log 看到類似：
> - `canceling remote connection ... not seen for ...`
> - `canceling remote connection ...`（搭配 grid peer / mux / LastPing 相關訊息）

---

## 0) 先固定你要對照的版本（避免看錯 code）

在 MinIO source tree（**請用你線上 binary 對應的 commit/tag**）：

```bash
cd /path/to/minio

git rev-parse --short HEAD

git describe --tags --always --dirty
```

把輸出貼到 incident note 的最上方。後面所有 grep 錨點才有意義。

---

## 1) 一步到位：從 log 字串 → 檔案 → function

```bash
cd /path/to/minio

# 沒有 ripgrep 就用 grep -RIn
rg -n "canceling remote connection" internal/grid cmd 2>/dev/null || \
  grep -RIn "canceling remote connection" internal/grid cmd | head -n 50
```

常見命中位置（不同版本路徑可能略有變動，但多半在這一帶）：
- `internal/grid/muxserver.go`

> 若你命中的不在 `internal/grid/`，以你 grep 出來的檔案為準；本頁的重點是「用字串定位」而不是猜檔名。

---

## 2) 斷線判定的核心：`checkRemoteAlive()` + `LastPing`

在命中檔案內，優先釘這 3 個錨點（它們最能回答「為什麼被斷」）：

```bash
cd /path/to/minio

# (A) 斷線檢查的函式（名字通常很穩）
rg -n "checkRemoteAlive\(" internal/grid/muxserver.go 2>/dev/null || \
  grep -n "checkRemoteAlive(" internal/grid/muxserver.go

# (B) 判斷 ping 是否超時（LastPing/lastPing/seen for/not seen for）
rg -n "LastPing|lastPing|not seen" internal/grid/muxserver.go 2>/dev/null || \
  grep -n -E "LastPing|lastPing|not seen" internal/grid/muxserver.go

# (C) 真正 close/cancel 連線的地方（close/cancel/ctx）
rg -n "close\(|cancel\(|Close\(" internal/grid/muxserver.go 2>/dev/null || \
  grep -n -E "close\(|cancel\(|Close\(" internal/grid/muxserver.go | head -n 80
```

你在 incident note 想寫的「一句話可回鏈」通常長這樣（模板）：

- `internal/grid/muxserver.go`：`(*muxServer).checkRemoteAlive()` 週期性檢查 peer 的 `LastPing`；若距離上次 ping 超過 threshold，會印 `canceling remote connection ... not seen for ...` 並關閉該 remote 連線。

> **關鍵解讀**：
> - 這通常表示「在 *本端* 的觀測上，對方太久沒有成功 ping/pong」
> - 但根因不一定是網路：也可能是對方/本端被 I/O/CPU/GC/鎖卡住，導致 ping handler 跑不動。

---

## 3) 你要在同一時間窗一起對照的 code 鏈（PutObject/Healing → I/O 壓力 → grid ping 延遲）

如果 `canceling remote connection` 同時間也看到：
- Healing（MRF/scanner/admin heal）變多
- PutObject latency/QPS 變差
- disk await/util 飆高

那你要把事件筆記同時釘住這條鏈：

1) `cmd/erasure-object.go`：PutObject commit 後可能 `addPartial()` → enqueue 到 `globalMRFState`
2) `cmd/mrf.go`：`(*mrfState).healRoutine()` 背景消費 queue → `HealObject()`
3) `cmd/erasure-healing.go`：`(*erasureObjects).healObject()` 內 `erasure.Heal()` + `disk.RenameData()`（I/O 密集）
4) `internal/grid/muxserver.go`：`checkRemoteAlive()` 因 `LastPing` 超時而斷線

對應的 signature grep（避免行號漂）：

```bash
cd /path/to/minio

# PutObject → partial/MRF
grep -RIn "addPartial(" cmd/erasure-object.go cmd/*.go | head -n 50
grep -RIn "globalMRFState\.addPartialOp" cmd | head -n 50

# MRF consumer → HealObject
grep -n "func (m \*mrfState) healRoutine" cmd/mrf.go

# Healing I/O 熱點（讀 meta / 重建 / rename）
grep -RIn "readAllFileInfo" cmd/erasure-healing.go | head
grep -RIn "\.Heal\(ctx" cmd/erasure-healing.go cmd/*.go | head
grep -RIn "RenameData\(" cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head

# grid 斷線判定
grep -n "checkRemoteAlive(" internal/grid/muxserver.go
grep -n -E "LastPing|not seen" internal/grid/muxserver.go
```

---

## 4) incident note 建議欄位（最小可回溯）

建議每次遇到 `canceling remote connection`，至少記：

- time window：`T ± 2m`
- 受影響的 node pair：`local → remote`（或 remote endpoint）
- 同時間：
  - PutObject QPS/latency（或 S3 4xx/5xx）
  - Healing/MRF/scanner 是否活躍（heal objects、mrf queue depth 若有）
  - disk：`iostat -x` 的 `await/util%`（哪顆盤）
  - CPU/load、GC（若有 pprof/metrics）

---

## 5) 相關頁面

- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- `docs/trace/putobject-healing.md`

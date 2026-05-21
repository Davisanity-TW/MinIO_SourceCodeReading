# Trace：PutObject → MRF（partial）→ HealObject（補洞）最短呼叫鏈（含實際檔案/函式錨點）

> 目標：把現場最常見的「PutObject 成功但留下洞 → 背景補洞 → I/O 壓力 + grid watchdog (`canceling remote connection`)」串成**最短、可 grep 的 call chain**。
>
> 適用：erasure 模式（serverPools/sets/erasureObjects）。
>
> 參考：
> - `docs/trace/putobject.md`（PutObject 入口到 rename/commit）
> - `docs/trace/healing.md`（Healing 全景、包含 MRF/scanner/admin 三條入口）
> - Troubleshooting：`docs/troubleshooting/canceling-remote-connection-one-page-playbook.md`

---

## 快速錨點（以 workspace `/home/ubuntu/clawd/minio` 為準）

> workspace MinIO HEAD（寫這頁時）：`b413ff9fd`
>
> 若你不是用同一個 commit：**請用下面的 grep pack 重抓**（不要硬套行號）。

PutObject 入口（HTTP → ObjectLayer）：
- `cmd/object-handlers.go`：`func (api objectAPIHandlers) PutObjectHandler(...)`
- `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) PutObject(...)`
- `cmd/erasure-sets.go`：`func (s *erasureSets) PutObject(...)`
- `cmd/erasure-object.go`：`func (er erasureObjects) putObject(...)`（heavy path）

MRF 產生（留下 partial 的地方）：
- `cmd/erasure-object.go`：`func (er erasureObjects) addPartial(bucket, object, versionID string)`
- `cmd/erasure-object.go`：`globalMRFState.addPartialOp(partialOperation{...})`

MRF 消費（背景補洞調度）：
- `cmd/mrf.go`：`func (m *mrfState) healRoutine(z *erasureServerPools)`
- `cmd/mrf.go`：helper `healObject(...)`（名稱可能因版本略有差異）

真正修復（最後都會落到同一條 HealObject 重建/rename 路徑）：
- `cmd/erasure-server-pool.go`：`func (z *erasureServerPools) HealObject(...)`
- `cmd/erasure-sets.go`：`func (s *erasureSets) HealObject(...)`
- `cmd/erasure-healing.go`：`func (er *erasureObjects) healObject(...)`（heavy path；內含 `erasure.Heal(...)` + `disk.RenameData(...)`）

---

## 1) PutObject 哪裡決定「要記 partial」？（MRF enqueue 點）

核心語意：
- **client 看到成功**（write quorum 過了）
- 但仍可能有部分 disk：offline/timeout/rename 失敗
- MinIO 會把「哪些 disk 沒寫好」用 metadata/狀態留存，並把該 object/version 丟到 MRF，後續補洞

讀碼定位（建議直接從 `addPartial` 反推回 putObject）：

```bash
cd /home/ubuntu/clawd/minio

git rev-parse --short HEAD

# 找到 partial enqueue 的確切位置
grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\\.addPartialOp" -n cmd/erasure-object.go cmd/*.go

# 往上追：誰呼叫 addPartial（通常在 putObject commit 後）
grep -RIn "\\.addPartial(" -n cmd/erasure-object.go | head -n 80
```

### 1.1 重要特性：MRF enqueue 是 best-effort，滿了會 drop

`cmd/mrf.go` 的 `addPartialOp` 典型是 non-blocking channel write：

```go
select {
case m.opCh <- op:
default:
}
```

含意：
- queue 滿了 → **partial 可能被丟棄**（洞不一定會被補到）
- incident 時若看到「PutObject 後洞越來越多」但 healing 沒追上：除了 I/O，也要把 **MRF queue 是否 drop** 納入判讀

---

## 2) MRF healRoutine 怎麼把 partial 轉成 HealObject？

讀碼定位：

```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (m \\*mrfState) healRoutine" -n cmd/mrf.go

# 看 healRoutine 內到底呼叫哪個 helper，再追到 z.HealObject
grep -n "healRoutine" -n cmd/mrf.go | head -n 120

grep -RIn "HealObject\\(" -n cmd/mrf.go
```

你想確認的兩件事：
1) healRoutine 對每個 `partialOperation{bucket, object, versionID...}` 會不會做節流（dynamic sleeper）
2) 最終是否走：`z.HealObject(ctx, bucket, object, versionID, opts)`（opts 可能用 Normal/Deep scan）

---

## 3) HealObject heavy path 的兩個 I/O 熱點（最常跟 `canceling remote connection` 共振）

把補洞的 I/O 拆成兩段看，排障會快很多：

1) **Reed-Solomon 重建**（讀來源 shards → reconstruct）
- `cmd/erasure-healing.go`：`erasure.Heal(ctx, writers, readers, ...)`

2) **寫回/commit**（先寫 `.minio.sys/tmp` → 最後 rename 回正式路徑）
- `cmd/erasure-healing.go`：`disk.RenameData(ctx, minioMetaTmpBucket, tmpID, ...)`
- storage 層：`cmd/xl-storage.go`：`func (s *xlStorage) RenameData(...)`

快速 grep：
```bash
cd /home/ubuntu/clawd/minio

grep -RIn "func (er \\*erasureObjects) healObject" -n cmd/erasure-healing.go

# RS heal + rename commit
grep -RIn "erasure\\.Heal" -n cmd/erasure-healing.go
grep -RIn "RenameData\\(" -n cmd/erasure-healing.go cmd/xl-storage.go cmd/storage-interface.go | head -n 80
```

---

## 4) 最短心智模型（現場對照）

- PutObject：寫入成功（quorum）≠ 每顆 disk 都寫完
- 留洞：`addPartial()` → MRF queue
- 補洞：MRF `healRoutine()` → `HealObject()` → `healObject()`
- I/O 熱點：`erasure.Heal()`（重建）+ `RenameData()`（commit）

如果同時出現：
- `canceling remote connection ... not seen for ...`
- PutObject latency 飆高、healing/MRF 活躍

優先懷疑：**I/O/排程壓力讓 grid handler 處理 ping/pong 不及**，而不是單純網路先壞。

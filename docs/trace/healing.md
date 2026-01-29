# Healing 路徑追蹤（背景掃描 → heal 調度 → erasure heal）

> 目標：把 MinIO 的 **Healing**（修復/重建）從「觸發點」到「實際做哪些讀寫」串起來，讓你能定位：
> - 什麼情境會觸發 healing（啟動、磁碟掉線/回復、讀取時發現不一致、後台掃描）
> - healing 的工作單位（bucket/object/part）與佇列/節流
> - erasure heal 的 quorum 與資料重建方式

> 版本假設：MinIO RELEASE.2024-05-07（以你知識庫為準）；實際函式/檔名以當前 source 為準。

## 0) Healing 在 MinIO 裡大致分幾類？
- **啟動後的 background healing**：背景慢慢掃、慢慢補（避免啟動後立刻打爆磁碟）
- **online healing**：讀/寫路徑上發現損壞或缺片，觸發更即時的修復
- **admin/heal API**：管理者手動下指令（或 UI / mc admin heal）
- **disk/drive 事件驅動**：磁碟離線/回復後，針對缺失資料做補齊

> TODO：把每一類對應到的 code 入口（handler/worker）補上。

## 1) 觸發點（Trigger points）
常見入口方向（待逐條對照）：
- 啟動流程：`serverMain()` / `initBackground*` / `startBackground*`
- 背景掃描：bucket/object listing + 對應的 heal scheduler
- 讀取路徑：GetObject / GetObjectInfo / ReadFile 時遇到不一致
- 管理 API：`admin-heal` handler（或類似）

> TODO：定位「啟動後何時開始 heal」：是完全啟動後、或某些 subsystem ready 後？

## 2) Healing 的調度/佇列（Scheduler）
你在實務上最想知道的通常是：
- **會不會一直跑？**（背景 heal 是常駐 worker 還是定期 batch）
- **會不會影響前台 I/O？**（節流、優先權、速率限制）
- **掃描範圍與順序？**（全桶/部分桶、按 prefix、按物件新舊）

常見機制（概念）：
- 背景 worker pool（固定並行度）
- rate limiter / throttle（避免打滿磁碟）
- per-bucket / per-disk 的 heal queue

> TODO：補上實際 limiter 變數/設定（如果有 env/config）。

## 3) ObjectLayer / ServerPools 層：heal 入口
Healing 最終仍需要走到「對 set 做重建」的那層。
推測會在：
- `erasureServerPools`：決定 object 屬於哪個 pool/set
- `erasureObjects`：實際去讀 k 份 data + m 份 parity，重建缺片並寫回

關鍵問題：
- **heal 的 quorum 怎麼算？**（read quorum / write quorum）
- **只補缺片，還是整段重寫？**（取決於缺損型態與 meta 狀態）
- **如何避免 concurrent update？**（namespace lock / versioning / temp object）

## 4) Erasure heal 的核心動作（你要追的最底層）
概念上會包含：
- 讀 `xl.meta` 判斷 object parts、erasure layout、校驗資訊
- 選擇健康的 shards 讀取（滿足 k）
- 以 Reed-Solomon 重建缺的 shard
- 寫回缺失磁碟的 shard（與 meta 更新）

> TODO：對照 `cmd/erasure-healing*.go` / `cmd/erasure-object*.go`（實際檔名待查）把函式鏈貼出來。

## 5) 讀碼下一步（先把你最需要排障的點補齊）
- [ ] 找到 background healing 的啟動點（serverMain → startBackgroundHealing...）
- [ ] 找到 heal scheduler 的 queue/worker 設計與 throttle
- [ ] 找到 `erasureObjects` heal 入口函式（包含 quorum 與鎖）
- [ ] 把「常見告警/現象」對應到 code 路徑：
  - drive offline / online
  - healing stuck
  - insufficient read quorum
  - checksum mismatch

# 更新日誌

- 2026-02-15 20:00：Troubleshooting：`canceling remote connection` 新增「常見 log 長相」小節，快速判讀 local/remote（`local->remote`）並提醒先固定節點對照同時間窗資源/背景任務。

- 2026-02-15 08:00：Trace：PutObject vs Healing：補強 PutObject 端 rename/commit 的讀碼定位點（`renameData`/`commitRenameDataDir` → `StorageAPI.RenameData`/`xlStorage.RenameData`）；Troubleshooting：`canceling remote connection` 補充此 log 對應 streaming mux（MuxID!=0）存活檢查的語意。

- 2026-02-14 20:00：Trace：PutObject vs Healing：補齊 MRF（PutObject 成功但缺片）一路接到 `HealObject()`→`erasureObjects.healObject()` 的完整 call chain（含檔案/receiver）。

- 2026-02-13 08:00：Trace：PutObject 補上「server 尚未就緒（ObjectAPI==nil）」時的典型分支與 grep 定位；Trace：Healing 補上「auto drive healing vs background heal routine」兩條主線的讀碼分流說明。

- 2026-02-12 20:00：Troubleshooting：`canceling remote connection` 新增「MRF/Healing 交叉驗證」段落；Trace：Healing 頁補上「healing 高負載與 grid 斷線」的運維對照與最關鍵觀察點（`readAllFileInfo` / `erasure.Heal` / `RenameData`）。

- 2026-02-12 08:00：Trace：PutObject vs Healing 補上 `cmd/mrf.go: (*mrfState).healRoutine()` 的精準行為（skip `.minio.sys` 特定路徑、sleep/節流、scanMode、版本化物件 versions[] 的 healObject 迴圈），方便把「PutObject 成功但有洞」對到 MRF 背景補洞的實作細節。

- 2026-02-11 20:00：Trace：Healing 補上 `HealFormat/HealBucket/HealObject` 的 receiver/落地實作索引與快速 grep；Troubleshooting：`canceling remote connection` 補上「如何把 grid connection 間接對回上層功能」的實務手法（MRF/background healing/scanner/subroute）。

- 2026-02-11 08:00：Trace：PutObject vs Healing 追加「addPartial → MRF healRoutine → healObject」的精準檔案/函式串接（`cmd/erasure-object.go`、`cmd/mrf.go`）；Troubleshooting：`canceling remote connection` 補上與 MRF 補洞/queue 消費端的具體對照點。

- 2026-02-10 20:00：Trace：PutObject vs Healing 補上 PutObject 成功但有洞時的 MRF/partial 記錄點（`er.addPartial` / `globalMRFState.addPartialOp`）與讀碼定位；Troubleshooting：`canceling remote connection` 關聯段落補上 MRF 補洞情境。

- 2026-02-10 08:00：Healing：補齊 scanner 觸發 `HealObject()` 的精準落點（`cmd/data-scanner.go: (*scannerItem).applyHealing()`、`madmin.HealOpts{Remove,ScanMode}`）；Troubleshooting：新增建議在事件/工單先記下的「最小資訊」清單（方便快速判斷網路 vs 對端忙）。

- 2026-02-09 08:00：Trace：PutObject vs Healing 頁補齊 PutObject 端的 encode/tmp/rename/commit 精準函式名與檔案定位（`newBitrotWriter`、`erasure.Encode`、`renameData`、`commitRenameDataDir`）；Troubleshooting：`canceling remote connection` 補上 `defaultSingleRequestTimeout` 與「interval 是常數非調參」提醒。

- 2026-02-08 20:00：Trace：PutObject vs Healing 頁補齊 `cmd/erasure-healing.go: healObject()` 後半段的精準函式/呼叫點（`erasure.Heal()`、`.minio.sys/tmp/<tmpID>`、`disk.RenameData()`），方便把「重建」與「寫回」的瓶頸對準到可下斷點的位置。

- 2026-02-07 20:02：Trace：新增 PutObject vs Healing 對照頁（把 PutObject 的 tmp/rename/commit 與 healObject 的讀→重建→寫回串起來）；Troubleshooting：`canceling remote connection` 增加與 healing/scanner/rebalance 高負載的快速關聯段落；首頁修正「系統總覽」連結。

- 2026-02-07 08:00：Troubleshooting：補上 `canceling remote connection` 的 check loop（`checkRemoteAlive`）語意，讓 log 更容易對照到「server 端多久沒看到 ping 就會主動 close」。

- 2026-02-06 20:00：Trace：PutObject 補上 `renameData()`/`commitRenameDataDir()` 的實作跳轉點（方便定位卡在 encode/tmp/rename/commit 哪一段）；Healing：補上 `StorageAPI.RenameData()` → `xlStorage.RenameData()` 的實作位置；Troubleshooting：`canceling remote connection` 增加用 remote IP:port 做同時期 log 關聯與 RELEASE tag 版本差異提醒。
- 2026-02-13 20:00：Trace：PutObject vs Healing：補精準 `HealObject()` 入口呼叫鏈（pool→sets→objects→healObject）與 deep scan retry 行為；Troubleshooting：補強 `canceling remote connection` 對 `LastPing` 的語意判讀（訊息未到 vs 無法處理）。
- 2026-02-06 08:00：Healing：補齊 background healer worker 的精準分流（`cmd/background-heal-ops.go: (*healRoutine).AddWorker()` 的 switch 與 `healTask` path 語意），方便把「heal format/bucket/object」對應到實際呼叫點。
- 2026-02-05 08:00：Healing：補齊 `cmd/erasure-healing.go: (*erasureObjects).healObject()` 後半段的精準流程（`erasure.Heal` 重建 → `.minio.sys/tmp` 寫入 → `disk.RenameData` 寫回），方便定位 heal 是卡在讀來源盤還是寫目標盤。
- 2026-02-04 20:00：Healing：補齊 `cmd/erasure-healing.go: (*erasureObjects).healObject()` 前半段的精準步驟（lock → readAllFileInfo → objectQuorumFromMeta → listOnlineDisks → pickValidFileInfo → disksWithAllParts → NewErasure），方便排查 quorum/metadata 選擇與重建來源。
- 2026-02-04 08:00：Trace：PutObject 補齊 `erasureObjects.putObject()` 內部的精準落盤流程（`erasure.Encode` → `.minio.sys/tmp` → `renameData`/`commitRenameDataDir`）與 MRF partial 補洞線索；Healing 補充 `healObject()` 內兩段 `readAllFileInfo` 的意義與建議觀察點。
- 2026-02-03 22:58：Troubleshooting：擴充 `canceling remote connection` 的實務排查段落（ss/nstat/iostat/conntrack/MTU），更快判斷網路 vs 資源瓶頸。
- 2026-02-02 06:00：Trace/PutObject：補上從 `PutObjectHandler` 一路到 `erasureObjects.putObject()` 的精準呼叫鏈（含檔案與 receiver），方便快速 grep/下斷點。
- 2026-02-01 22:00：Trace/Healing：補上 `HealObject()` 實際呼叫鏈（erasureServerPools → erasureSets → erasureObjects → `healObject()`）與 deep scan/lock/quorum 等關鍵觀察點；Troubleshooting：`canceling remote connection` 補上「如何用同時間點 log/metric 串關聯」的小節。
- 2026-02-01 14:00：Trace/PutObject：補上 `erasureObjects.putObject()` 的 temp object/quorum/清理點；Trace/Healing：補上 `initBackgroundHealing` 與 scanner 觸發 `HealObject` 的來源；Troubleshooting：更新 `canceling remote connection`（補 `Connection.String()` 的 local->remote 解讀 + 用 grep 取代 rg 指令）。
- 2026-02-01 10:28：Admin heal：補上 Items[]（madmin.HealResultItem）產生/推送位置與『如何拿 heal 清單/如何 trigger』SOP
- 2026-02-01 06:00：Healing：補齊 `cmd/global-heal.go: (*erasureObjects).healErasureSet()` 的實際流程（先 HealBucket、worker 數量估算、來源 disks 選擇、metacache entry → HealObject 的關鍵呼叫）。
- 2026-01-31 22:38：新增 Trace：admin heal（server handler / JSON 欄位對照第一版）
- 2026-01-31 06:00：Trace/PutObject：補上 PutObjectHandler（cmd/object-handlers.go）更精準的 pipeline/函式定位；Trace/Healing：補上 `sets[setIdx]` 實際型別與 `healErasureSet` 的實作位置；Troubleshooting：新增 `canceling remote connection` 的 10 分鐘快速排查 SOP。
- 2026-01-30 22:00：PutObject/Healing：補齊本機 source tree 的具體函式/檔案對照（PutObjectHandler pipeline、erasureServerPools/erasureSets/erasureObjects PutObject；Healing 的 healErasureSet 實作在 cmd/global-heal.go），並修正 changelog 首行缺日期。
- 2026-01-30 14:00：補齊 PutObject 路由 matcher（Copy/Extract/Append reject/Multipart part）與 Healing 新盤自動修復呼叫鏈（initAutoHeal → healFreshDisk → healErasureSet）。
- 2026-01-30 09:01：補齊 `canceling remote connection`：追到 LastPing/LastPong 更新點與 ping/pong 呼叫鏈（grid）。
- 2026-01-30 08:51：新增 troubleshooting：`canceling remote connection`（grid ping timeout ~60s 的可能原因與排查）。
- 2026-01-30 08:08：手動更新（補上 06:00 漏跑）。開始補 PutObject/Healing 的實際檔案/函式對照點。
- 2026-01-29 22:22：手動補推（排程改為 06/14/22 後，22:00 之前未生效）。PutObject/Healing trace 補充『本輪進度』與下一步 TODO。
- 2026-01-29：新增 Trace 專區（PutObject / Healing）與側邊欄連結。
- 2026-01-28：初始化知識庫網站骨架。

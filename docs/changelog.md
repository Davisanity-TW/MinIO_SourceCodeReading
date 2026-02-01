# 更新日誌

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

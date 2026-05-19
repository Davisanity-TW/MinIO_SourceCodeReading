# `canceling remote connection` — 常見 log signature 與對應 code 錨點

> 目的：把現場最常見的 `canceling remote connection ... not seen for ...` 這類訊息，整理成「看到哪段 log → 先去哪個檔案/函式找原因 → 下一步怎麼證實」。
>
> 這頁刻意偏 **運維排障**（log → code → 指標），不重複解釋 healing/MRF 的大圖；大圖請搭配：
> - `docs/trace/healing.md`
> - `docs/trace/putobject-healing.md`

---

## 1) 你可能看到的幾種 log 形式

### 1.1 典型（最常見）
- 關鍵字：`canceling remote connection`
- 常伴隨：`not seen for`、`lastPing`、`grid`（不同版本字串可能不同）

你要做的第一件事不是「判斷網路壞了」，而是先回答：
- 這是 **連線層 idle timeout**？還是 **server 忙到 handler 來不及更新 ping**？
- 是否同時發生：PutObject latency 飆高 / Healing/MRF activity / disk await 飆高？

---

## 2) 最快收斂的三個假說（按常見度排序）

### H1) 磁碟 I/O 壓力（rename/fsync/metadata）導致 goroutine / handler 飢餓
**常見共振現象**
- 同時看到：Healing/MRF 在跑（或 scanner deep/heal）
- `.minio.sys/tmp` 寫入量暴增
- iostat `await` / `svctm` / `%util` 上升，或 ext4/xfs metadata 壓力（rename-heavy）

**快速驗證**
- pprof：`/debug/pprof/profile` 期間是否大量時間卡在 I/O syscalls / `RenameData` / `fsync`
- `iostat -x 1`：是否某幾顆盤尖峰很明顯

**Code 錨點（先釘住 3 個位置）**
- Healing 的重建與寫回：
  - `cmd/erasure-healing.go`：`(*erasureObjects).healObject()`
  - 你要看的點：`erasure.Heal(...)`、`StorageAPI.RenameData(...)`
- PutObject 的 rename/commit：
  - `cmd/erasure-object.go`：`renameData(...)` / `commitRenameDataDir(...)`

> 讀碼提醒：很多版本下 `canceling remote connection` 不是「網路斷線」，而是 grid/ping 的 goroutine 來不及跑到更新 `LastPing`，最後由 timeout path 主動 cancel。

### H2) CPU/GC 壓力造成 ping handler 延遲
**常見共振現象**
- CPU 逼近滿載、或 GC pause 變長
- 同時有大量 object heal（scanner/MRF）或大量小物件 PutObject

**快速驗證**
- pprof：hot path 是否在 RS reconstruct / checksum / encoding
- Go runtime：`GODEBUG=gctrace=1`（或看 metrics）

### H3) 真正的網路抖動或節點互通問題
**常見共振現象**
- 只有特定 node pair 出現（固定來源/目的）
- disk/CPU 指標正常
- tcp retrans / conntrack 問題、或 CNI/overlay 抖動

**快速驗證**
- node-to-node `mtr` / `ethtool -S` / `ss -s`
- 交換器/主機網卡錯誤計數

---

## 3) 一鍵 grep：把 log 對回 code（不靠行號）

> 注意：不同 RELEASE tag 字串會變；所以建議用「模糊關鍵字」去找。

```bash
cd /path/to/minio

# 先找 log 字串本體在哪個檔案
grep -RIn "canceling remote connection" -n cmd internal | head -n 50

# 再找 timeout / not seen / lastPing 相關字串（通常在同一區塊）
grep -RIn "not seen for" -n cmd internal | head -n 50
grep -RIn "lastPing" -n cmd internal | head -n 80

# 如果你的版本用的是 grid（常見在 internal/grid）
grep -RIn "package grid" -n internal/grid | head
```

你希望最後能定位到：
- 哪一個 connection/state struct 在維護 `LastPing`（或等價欄位）
- 哪一段 watchdog/timeout 在判斷「多久沒 seen」然後 cancel

---

## 4) 最小化現場紀錄（建議貼到 incident note）

每次遇到這類 log，建議至少留下：
- (A) 發生時間範圍（開始/結束）
- (B) 同期是否有：
  - Healing/MRF queue 活躍、或 `mc admin heal` 在跑
  - PutObject latency/5xx spike
  - `.minio.sys/tmp` 寫入暴增
- (C) 三個關鍵指標（同時間切片）
  - iostat（最慢的 1–3 顆盤）
  - CPU/Load/GC（若有）
  - node-to-node retrans / drops（若懷疑網路）

---

## 5) 與 PutObject / Healing 的關聯（只留最關鍵的一句）

如果同時看到 PutObject 與 Healing/MRF 活躍，最常見的實際原因是：
- PutObject 與 Healing 都會走「寫 tmp → rename commit」的安全模型；當 rename/fsync/metadata 成本上升時，grid ping handler 更容易延遲，最後表現為 `canceling remote connection`。

（延伸：請回 `docs/trace/healing.md` 的 `erasure.Heal()` / `RenameData()` 章節。）

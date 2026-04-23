# Trace：`canceling remote connection`（MinIO internal/grid mux）到底是哪條 call chain？

> 目標：把 production log 看到的：
> - `canceling remote connection <peer> not seen for ...`
> - `grid: ... ErrDisconnected` / peer RPC timeout
>
> 直接連到 MinIO `internal/grid` 的 **檔案/函式/欄位**，並提供一套「版本無關」的 grep 錨點。
>
> 本頁偏 trace/讀碼；現場處置流程請看：
> - `docs/troubleshooting/canceling-remote-connection.md`

---

## 0) TL;DR（你要在 incident note 寫的一句話）

`canceling remote connection` 多半是 **server 端 mux watchdog**（`internal/grid/muxserver.go`）檢查到某個 peer 的 `LastPing` 超過門檻（常見 ~60s）後主動 close 連線；在 healing/scanner/MRF 很忙的時段，常見根因是 **資源壓力（排程/CPU/GC/I/O/鎖）** 讓 ping handler 沒有即時更新 `LastPing`，而不是「網路先壞」。

---

## 1) 你要先分清楚：這句 log 是誰印的？

### 1.1 server 端：`muxserver` watchdog（最常見）

關鍵檔案/函式（不同版本函式名可能略調，但通常仍可 grep 到）：
- `internal/grid/muxserver.go`
  - `(*muxServer).checkRemoteAlive()`（或同義 watchdog loop）
  - 會讀某個 connection/remote 的 `LastPing` / `lastPing`，超時就：
    - `canceling remote connection ... not seen for ...`
    - `close()` / `Close()`

### 1.2 client 端：`muxclient`（常先報錯，但不一定印同一句）

常見現象是：
- client 端先回報 `ErrDisconnected` / peer RPC timeout
- server 端稍後（更長門檻）才印 `canceling remote connection`

關鍵檔案：
- `internal/grid/muxclient.go`

---

## 2) 門檻時間（例如 60s）通常怎麼算出來？

常見組合：
- `clientPingInterval` 例如 `15s`
- server 端門檻 `lastPingThreshold` 例如 `4 * clientPingInterval`（≈ `60s`）

版本無關 grep：
```bash
cd /path/to/minio

grep -RIn "clientPingInterval" -n internal/grid | head -n 50

grep -RIn "lastPingThreshold" -n internal/grid | head -n 80
```

---

## 3) 最小 code anchors（不靠行號、可貼 incident note）

```bash
cd /path/to/minio

# 1) 找到 log 字串（最穩）
grep -RIn "canceling remote connection" -n internal/grid | head

# 2) watchdog / alive check 的函式
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

# 3) watchdog 讀寫的核心欄位（LastPing/LastPong/lastPing 等）
grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 120

grep -RIn "LastPong" -n internal/grid/muxclient.go | head -n 120

# 4) client 端斷線錯誤
grep -RIn "ErrDisconnected" -n internal/grid/muxclient.go internal/grid/connection.go | head -n 120
```

---

## 4) 跟 PutObject / Healing 的關聯：為什麼常在補洞時一起爆？

你在現場常看到這種組合：
- healing / scanner / MRF 活躍（尤其大量 `RenameData()` / `fsync`）
- 同時間出現 `canceling remote connection`

最短因果鏈（可回鏈到 code）：
1) `PutObject` quorum 達成但留下 partial → `addPartial()` → enqueue MRF
2) MRF/scanner 觸發 `HealObject` / `healObject`
3) `healObject` 內部 `readAllFileInfo` / `erasure.Heal` / `RenameData` 放大 I/O 與排程壓力
4) mux 的 ping handler 沒被即時排程或被 syscall/鎖拖慢 → `LastPing` 更新延遲 → watchdog 斷線

對照讀碼：
- PutObject ↔ MRF ↔ healObject：`docs/trace/putobject-healing.md`
- `canceling remote connection` 現場處置：`docs/troubleshooting/canceling-remote-connection.md`

---

## 5) 你要蒐證「不是純網路」的 3 個快速指標

1) **磁碟 I/O latency / await** 與 log 時窗強相關（尤其 rename/fsync 高峰）
2) pprof/block profile 顯示大量時間卡在 syscall（rename/fsync/open）或 mutex contention
3) healing/MRF/scanner trace 指標在同時間窗明顯上升

> 如果 1~3 都成立，通常要先把 remediation 放在「降低背景修復壓力 / 限速 / 分流 / 釐清壞盤」而不是只換網路。

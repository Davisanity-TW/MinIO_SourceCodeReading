# Incident note：`canceling remote connection`（2026-05-08）

> 目的：把「我真的遇到過」的 `canceling remote connection` 現場，補成一份能快速復用的排查筆記。
>
> 這頁偏 *operational*，不追求完整；完整的理論/決策樹請回到總頁：
> - `docs/troubleshooting/canceling-remote-connection.md`

---

## 1) 症狀（Symptom）

在 MinIO server log（或 systemd journal）看到類似訊息：

- `canceling remote connection`

通常會伴隨（同一時間窗）以下任一類：
- peer/grid 相關：`ErrDisconnected`、RPC timeout、peer REST call 失敗
- healing 相關：bg heal / scanner / MRF queue activity 飆高
- disk 相關：rename/fsync/metadata latency 拉長、IO wait 高

---

## 2) 我怎麼判斷「這是結果」還是「根因」

`canceling remote connection` 在實務上常是 **grid/mux 連線存活檢查的結果**：
- 連線對端回不來（或 ping/pong handler 沒被排程）
- deadline/timeout 到 → server 端主動 cancel

所以第一個判斷點：
- 同時間窗有沒有 *大量* disk IO latency、goroutine backlog、GC pause、CPU steal、或 NIC packet loss

---

## 3) 快速 triage checklist（先找 80% 的那幾個）

### 3.1 Host / node 層

- `iostat -x 1`：util/await 是否爆掉（尤其 metadata disk）
- `pidstat -d -p $(pidof minio) 1`：minio 自己是否卡在 IO
- `ss -antp | grep :9000`：連線數是否異常
- `sar -n DEV 1` / `ethtool -S`：packet drop / error
- `dmesg -T`：NVMe reset、EXT4/XFS error、soft lockup

### 3.2 MinIO process 層

- goroutine dump（SIGQUIT）：是否看到大量卡在 rename/fsync、或 grid mux 的 read/write
- pprof（若可用）：`/debug/pprof/goroutine?debug=2`、block profile
- healing 指標：bg heal、scanner、MRF queue 是否在跑

---

## 4) Code anchors（把 log 釘到程式碼）

> 這段的目標是：你看到 log 就能立刻對齊到 `internal/grid`。

```bash
cd /path/to/minio

# log 文字本體在哪裡
grep -RIn "canceling remote connection" -n internal/grid | head

# muxserver 常見存活檢查路徑（不同版本可能有改名，但 muxserver.go 很穩）
grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "clientPingInterval|ping" -n internal/grid | head -n 120
```

---

## 5) 與 PutObject/Healing 的關聯（為什麼常一起發生）

當 PutObject/Healing（MRF/scanner/admin heal）把下列路徑推到 tail latency 爆炸：
- `renameData(...)` / `disk.RenameData(...)`
- `commitRenameDataDir(...)`
- metadata fan-out（`readAllFileInfo(...)` / writeAllDisks）

grid/mux 的 ping/pong handler 可能「排不到」或 deadline 設定過緊，最後就會出現 `canceling remote connection`。

PutObject/Healing 的實際函式/檔案/呼叫鏈錨點整理：
- `docs/trace/putobject-healing-real-functions.md`

---

## 6) 我會留下的 3 個「現場紀錄欄位」

為了讓後續能做 correlation（特別是和 healing spikes 對上），每次遇到建議至少記：

1) 發生時間窗（含時區）
2) 同時間段的 IO util/await（至少截圖或文字）
3) minio goroutine dump / pprof goroutine top（擇一）

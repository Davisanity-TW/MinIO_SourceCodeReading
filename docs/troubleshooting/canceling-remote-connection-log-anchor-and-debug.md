# `canceling remote connection`：log 來源錨點 + 快速 Debug Checklist

> 目的：把你在現場看到的錯誤訊息（例如：`canceling remote connection ... not seen for ...`）補成一頁「可落地排查」的筆記：
> 1) **log 這句話到底是哪個檔案/函式印出來的？**
> 2) **它通常代表什麼壓力來源？**（I/O / healing / MRF / rename/fsync / scheduler）
> 3) **怎麼用最小成本把原因縮小？**（pprof/trace/metric/strace 觀察點）

> 注意：不同 MinIO 版本（RELEASE tag）這句 log 文字可能有細微差異；本頁提供的是「你可以在自己的 source tree 直接 grep 釘死」的方法，而不是死背行號。

---

## 1) 先把 log 來源釘死（最重要的一步）

在你跑的 MinIO source tree（建議是你線上同版 tag）執行：

```bash
cd /path/to/minio

# 1) 直接用 log 文字反查
# 有些版本字串可能是 "canceling" / "cancelling"（美式/英式），兩個都搜
rg -n "cancel(l)?ing remote connection" cmd internal pkg -S

# 2) 如果你有完整 log（含 module/prefix），也一起搜關鍵字
rg -n "remote connection" cmd internal pkg -S

# 3) 若搜不到：改搜 "not seen for"（常見搭配字串）
rg -n "not seen for" cmd internal pkg -S
```

你要找到的通常會是某個「**連線維護/心跳**」或「**RPC/GRID**」相關元件，在判斷 peer 的 last-seen/last-ping 超過閾值後，主動取消/關閉連線並印 log。

> 實務：這句話本身通常不是 root cause，而是 **症狀**。

---

## 2) 最常見的 root cause 類型（以運維現場可觀測性分類）

### A) I/O 壓力（最常見）
特徵：
- 同一時間 PutObject latency 拉高、甚至出現 timeout
- `iostat`/磁碟延遲飆升、queue 深
- healing/MRF 正在跑（或剛有 disk offline/online）

對應你該先看的 code/路徑：
- Healing 的重建與寫回：`cmd/erasure-healing.go`：`readAllFileInfo` / `erasure.Heal` / `disk.RenameData`
- PutObject 的 tmp/rename/fsync：`cmd/erasure-object.go`（rename/commit）

### B) scheduler/CPU/GC 壓力
特徵：
- CPU 高或 GC pause 增加
- network 並沒有明顯丟包，但 handler 端「來不及處理」ping/pong

建議先做：
- `go tool pprof` 看 goroutine/heap（尤其 runnable goroutine 數）
- 對照是否有大量 background task（scanner/healing/MRF）

### C) 真正的 network 問題（相對少，但要排除）
特徵：
- 只有特定 node pair 出現
- 同時間有 NIC reset、bond flapping、switch error counter 增加

---

## 3) 一頁式排查 Checklist（你可以照順序跑）

### 3.1 確認是否與 healing/MRF 同步（先用現象交叉比對）
- `mc admin heal <alias> --json` 是否有 active sequence？
- 是否剛有 disk offline/online、或 healing tracker（`.healing.bin`）更新頻繁？
- 是否看到 `.minio.sys/tmp` 寫入暴增？

參考：
- Trace：`docs/trace/healing.md`
- Trace：`docs/trace/putobject-healing.md`

### 3.2 釘住「最重的 I/O 點」是 heal 還是 putobject
- 如果 pprof/goroutine 顯示大量卡在 `RenameData` / `fsync`：多半是 metadata/rename contention 或底層磁碟 latency
- 如果卡在 `erasure.Heal` / reader：多半是來源盤讀不到/bitrot 或 rebuild 量太大

### 3.3 用最少工具拿到證據
你可以用以下「低侵入」方式快速取樣：

```bash
# (1) pprof：CPU/heap/goroutine
# 依你的部署方式取得 pprof endpoint（有些是 debug port）
# curl -s http://127.0.0.1:9000/debug/pprof/goroutine?debug=2 | head

# (2) iostat / pidstat
iostat -x 1
pidstat -dru -p $(pidof minio) 1

# (3) 若懷疑 rename/fsync：抽樣 strace（短時間）
# strace -ff -tt -T -p <minio_pid> -e trace=fsync,fdatasync,renameat,renameat2,link,unlink -o /tmp/minio.strace
```

---

## 4) 建議你補到 incident note 的「結論模板」

當你下一次遇到這句 log，可以把結論寫成：

- **現象**：`canceling remote connection ... not seen for ...`（出現頻率/時間範圍）
- **同時事件**：healing/MRF/PutObject latency/磁碟延遲
- **最可能 root cause**：I/O 壓力造成 handler starvation（或 network）
- **證據**：pprof（goroutine/CPU）、iostat（await/util）、strace（fsync/rename latency）
- **下一步**：降 healing concurrency / 調整節流 / 針對慢盤做更換或排除

---

## 5) 本輪補充
- 新增本頁：提供 `canceling remote connection` 的 **log 來源反查方法**（grep/rg）與 **一頁式排查流程**。

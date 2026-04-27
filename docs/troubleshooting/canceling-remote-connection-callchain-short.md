# Troubleshooting：`canceling remote connection`（最短 code 呼叫鏈 + 你該先確認什麼）

> 目的：把你在 log 看到的 `canceling remote connection` 從「一句模糊的錯誤」變成可追的路徑：
> - 這句 log 大概率在哪些 code 區塊出現？
> - 它代表的是 remote 主動關？還是 local cancel/timeout？
> - 你要先查哪些指標/stack，才能在 5 分鐘內決定往哪一類根因收斂？

## 0) 先做一個重要釐清：這句通常不是「根因」而是「症狀」

`canceling remote connection` 多半代表：
- **某個 RPC / stream 連線正在被取消**（context cancel / deadline / conn close）
- 或 **本端判斷 peer 不健康而主動斷線**（避免卡住/資源耗盡）

所以你看到這句時，第一時間不要只 grep 這一句；要立刻同步抓：
- 同一時間點前後 1–2 分鐘的 **grid / peer / heal / mrf** 相關 log
- **SIGQUIT stackdump** 或 pprof goroutine（看卡點是在網路/鎖/磁碟/GC）

## 1) 最短 code 錨點（建議用「字串 → function → caller」三段式）

在 MinIO source tree：
```bash
cd /path/to/minio

# 1) 先把 log 字串釘到檔案
rg -n "canceling remote connection" .

# 2) 在命中的檔案附近找：logger/console 的包裝（依版本不同）
#    常見關鍵字：logger.LogIf / logger.Info / logger.Error / console

# 3) 往上追 caller：這句是在「關閉連線」的路徑、還是「timeout/cancel」的路徑？
```

> 若你 repo 沒有 `rg`：用 `grep -RIn` 取代。

## 2) 你該先確認的 5 件事（比追 code 更快收斂）

1) **是否同時有 grid/peer timeout**
   - 例如 `context deadline exceeded`、`errDisconnected`、`peer rpc timeouts`

2) **是否同時有 Healing/MRF 壓力升高**
   - 例如 PutObject partial 大量 enqueue、scanner healing 變密
   - 參考：`docs/trace/putobject-healing-callchain.md`

3) **remote 端是不是「忙到回不了」**（不是網路問題）
   - 觀察 remote node：CPU 100%？load 飆？IOPS 打滿？GC stop-the-world？
   - goroutine dump 若大量卡在：`os.File.Read` / `syscall` / `fsync` / `rename` → 偏磁碟

4) **本端是不是「先 cancel」**
   - 若 caller 端是 request-scoped context（HTTP handler / bucket scanner）
   - 會看到 context cancel / deadline 在上游先觸發

5) **是否存在長尾操作被卡住**（rename/commit/metadata lock）
   - 大量卡在 `renameData` / `commitRenameDataDir` 或 namespace lock → 會拖垮 peer RPC

## 3) 與 PutObject/Healing 的關聯（為什麼常一起出現）

PutObject + Healing 同時熱時：
- PutObject 在 erasure 層會做 encode/tmp/rename/commit（I/O 密集）
- Healing 也會做讀 quorum + RS rebuild + 寫回缺片（I/O 密集）
- 兩者一起把 disk queue 打滿時，peer RPC 會變慢，接著更容易出現 cancel/timeout，最後你就看到 `canceling remote connection`

建議你把「當下是否正在 heal」與「當下是否有大量 PutObject」一起記在事件筆記：
- PutObject 熱：S3 PUT QPS/bytes、4xx/5xx、latency
- Healing 熱：heal objects、mrf queue、scanner 速率
- Disk 熱：await、util%、iostat top devices

## 4) 連到既有筆記

- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/canceling-remote-connection-codepath.md`
- `docs/troubleshooting/grid-peer-rpc-timeouts.md`
- `docs/trace/putobject-healing-callchain.md`

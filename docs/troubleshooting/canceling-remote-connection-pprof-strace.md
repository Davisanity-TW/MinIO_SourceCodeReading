# Troubleshooting：`canceling remote connection`（pprof/strace 快速定位卡點）

> 目的：當你在 MinIO log 看到
>
> - `canceling remote connection ... not seen for ...`
>
> 你要能在 10–15 分鐘內回答：「它是根因？還是結果？」以及「remote 到底卡在哪一層？」
>
> 這頁提供 **pprof（goroutine/heap/profile）+ strace** 的最短操作清單，讓你把現場現象快速對回 code path。

延伸（讀碼錨點頁）：
- `docs/trace/putobject-healing-callchain.md`（PutObject / Healing / grid 的連結）
- `docs/trace/grid-canceling-remote-connection.md`（grid mux 的 code anchors）

---

## 0) 先下結論（現場最常見的判讀）

在大多數 incident 裡，`canceling remote connection` **比較常是結果**，不是根因：
- healing/MRF/scanner/rebalance 等背景 I/O 把節點壓到 tail latency 拉長
- 或某些 disk/FS 操作（rename/fsync、metadata lock）變慢
- grid 的 ping/pong handler 排不到（或 streaming mux 沒收到 ping/pong 更新）
- 最後被 watchdog 斷線，印出 `canceling remote connection`

例外（更像根因）的情況：
- node 間網路明顯丟包 / MTU mismatch / conntrack 爆掉
- 單一方向大量 `ErrDisconnected`，但 node 本身 I/O/CPU 並不高

接下來的目標就是：用 pprof/strace 把「remote 卡點」釘死。

---

## 1) 先確認這句 log 是哪一端印的（server vs client）

通常：
- `canceling remote connection ... not seen for ...` 是 **server-side mux watchdog** 印的（看 `internal/grid/muxserver.go` 的 `checkRemoteAlive()`）。
- client-side 常會先出現 `ErrDisconnected`（`internal/grid/muxclient.go`，看 `LastPong` watchdog）。

**實務**：你要同時抓兩端（發起 RPC 的 node + 被呼叫的 node）的時間窗 log，才不會只看到「結果」。

---

## 2) pprof：先用 goroutine dump 判斷卡在哪一層

### 2.1 取得 goroutine（最推薦，便宜又快）

如果你能在現場打到 MinIO 的 pprof：

```bash
# 例：導出 goroutine（調整你自己的 port / auth / endpoint）
# 常見：http://127.0.0.1:9000/debug/pprof/goroutine?debug=2
curl -sS "http://127.0.0.1:9000/debug/pprof/goroutine?debug=2" > /tmp/minio.goroutine.txt
```

### 2.2 你要在 dump 裡找什麼

把卡點分成四類（跟讀碼頁一致）：

1) **卡在 grid / net**（還沒進 object layer）
- 關鍵字：`internal/grid`、`RoundTrip`、`readLoop`、`writeLoop`、`quic`/`net`/`tls`

2) **卡在 ObjectLayer（HealObject/PutObject 上層）**
- 關鍵字：`erasureServerPools.*`、`erasureSets.*`、`nsLock` / `rwMutex`

3) **卡在 RS rebuild / disk read**
- 關鍵字：`erasureObjects.healObject`、`Erasure.Heal`、`readAllFileInfo`

4) **卡在 rename/commit（最常見放大器）**
- 關鍵字：`RenameData`、`commitRenameDataDir`、`renameData`

快速 grep：
```bash
rg -n "canceling remote connection|ErrDisconnected" /tmp/minio.goroutine.txt || true
rg -n "RenameData|commitRenameDataDir|renameData" /tmp/minio.goroutine.txt || true
rg -n "healObject\(|HealObject\(" /tmp/minio.goroutine.txt || true
rg -n "internal/grid" /tmp/minio.goroutine.txt || true
```

> 你只要能把 goroutine 的 top 5 熱點分類到上面其中一類，後續排查方向就會非常清楚。

---

## 3) pprof：CPU profile（判斷是 CPU 還是 I/O wait）

```bash
# 取 30 秒 CPU profile
curl -sS "http://127.0.0.1:9000/debug/pprof/profile?seconds=30" > /tmp/minio.cpu.pprof

# 需要 go tool pprof（或用你平常的分析環境）
go tool pprof -top /path/to/minio /tmp/minio.cpu.pprof
```

判讀：
- 若 CPU top 幾乎都在 RS/crypto/hash：偏「rebuild 計算」或「大量 checksum」。
- 若 CPU 不高但事件很嚴重：更常是 I/O wait、rename/fsync、或鎖/排程造成 ping 延遲。

---

## 4) strace：把卡在 RenameData 的 syscall latency 釘出來

當你在 goroutine dump 看到 `xlStorage.RenameData` / `RenameData` 相關堆疊時，用 strace 直接看 syscall 延遲最有效。

```bash
# 只追 metadata-heavy syscall（短時間窗就好，避免影響太大）
# 你需要先找到 minio pid：pgrep -f "minio server" 或 systemd
sudo strace -ttT -fp <PID> \
  -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,unlink,openat \
  -o /tmp/minio.strace.rename.txt
```

看什麼：
- `renameat2(...) <X.XXXXXX>` 時間很長
- `fsync/fdatasync` 長時間卡住
- `mkdirat/openat` 對 `.minio.sys/tmp` 或 bucket/object dataDir 延遲明顯

> 若 syscall latency 跟 `iostat await/%util` 同步飆高，幾乎可以確定：grid 斷線是結果（節點太忙）。

---

## 5) 對回修復方向（行動清單）

你把卡點分類後，修復方向通常會變得很「工程化」：

- **grid/net 類**：
  - 檢查 node 間 MTU、丟包（`ping -M do`）、conntrack、負載平衡器、QUIC/TLS error
  - 看是否是單向問題（固定某些 peers）

- **ObjectLayer/鎖 類**：
  - goroutine 是否大量卡在 nslock
  - 是否有某些 bucket/prefix 被高併發 heal/list/put 互相鎖住

- **RS rebuild / disk read 類**：
  - 對單一 disk 做健康檢查（SMART、bad sector、queue depth）
  - 限制 heal 并行（減少讀放大）

- **RenameData/fsync 類（最常見）**：
  - 檢查 filesystem/journal、RAID cache、磁碟 latency
  - 評估是否同一時間 window 讓 heal/scan/mrf 同時放大

---

## 6) （建議）把「診斷輸出」一起留在 incident note

我建議每次遇到 `canceling remote connection` 都至少留下：
- 事件時間窗（含 nodeA/nodeB）
- goroutine dump 的 top 10 stack（貼出關鍵片段）
- strace 中最慢的 5 個 syscall（含耗時）
- 對應到這份讀碼筆記的哪個 call chain 節點（PutObject / Healing / grid）

這樣下一次同樣事件發生，你不需要從零開始。

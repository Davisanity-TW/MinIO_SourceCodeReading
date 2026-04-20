# Troubleshooting：`canceling remote connection`（從 symptom → 反推最可能的原因）

> 目標：當你在 log 只看到一行
>
> ```
> canceling remote connection ... not seen for ...
> ```
>
> 要在 **5 分鐘內**把它分流到「最可能」的幾個方向，並且留下能複現/能對 code 的證據。

相關頁：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/canceling-remote-connection-root-causes.md`
- `docs/troubleshooting/canceling-remote-connection-code-anchors.md`
- `docs/trace/putobject-healing-callchain.md`（PutObject / Healing / peer-rest/grid 的關係）

---

## 1) 先確認：這句 log 是哪一端印的？

這句通常是 **server 端（被連線的一方）**印出來的 watchdog：
- 位置：`minio/internal/grid/muxserver.go`
- 函式：`(*muxServer).checkRemoteAlive()`
- 條件：`time.Since(time.Unix(LastPing, 0)) > lastPingThreshold`

也就是：server 端覺得「好一陣子沒有收到對方的 ping」，所以主動把那條 streaming mux connection 關掉。

> 注意：這不等同於「網路一定壞了」；更多時候是 **對方太忙**（handler 排不到、CPU throttling、卡在 disk I/O）導致 ping 沒送出/沒處理。

---

## 2) 用時間窗把 client/server 兩端對起來（±2 分鐘）

### 2.1 同一時間窗，client 端常見先出現的訊號
client 端可能會先看到（或先抱怨）
- `ErrDisconnected`
- `context deadline exceeded`
- `i/o timeout`

原因是：
- client 端 watchdog 常在 **~30s** 沒看到 `LastPong` 更新就先斷
- server 端 watchdog 常在 **~60s** 沒看到 `LastPing` 才印 `canceling remote connection`

可釘死 code anchors：
- `internal/grid/muxclient.go`：`LastPong` / `ErrDisconnected`
- `internal/grid/muxserver.go`：`LastPing` / `lastPingThreshold` / `checkRemoteAlive()`

---

## 3) 這條 connection 大概率在跑什麼？（最常見 3 類）

`canceling remote connection` 通常出現在 **長連線/串流**型的 peer REST（grid RPC）上。
你要優先懷疑：

### 3.1 Healing（MRF / scanner / admin heal）相關 RPC 被放大
線索：同一時間窗出現
- `HealObject` / `HealBucket`
- `BackgroundHealStatus`
- scanner / healing 相關 log

對照 call chain（把「現象」對回「吃 I/O 的地方」）：
- `HealObject()` → `(*erasureObjects).healObject()` → `readAllFileInfo()` → `Erasure.Heal()` → `StorageAPI.RenameData()`
- `PutObject()`（留下 partial）→ `MRF addPartialOp()` → `mrfState.healRoutine()` → `HealObject()`

### 3.2 大量 rename/fsync / metadata-heavy operations
線索：
- 同時間 node 上 `iowait` 上升
- `iostat -x` 某顆盤 `await`/`svctm` 明顯異常
- goroutine dump/pprof 顯示卡在 `xlStorage.RenameData` / `fsync` / `renameat`

### 3.3 網路層（MTU/conntrack/drops）
線索：
- 只在跨 AZ / overlay 路徑出現
- `dmesg` / `ethtool -S` 有 drops
- conntrack table 滿、`nf_conntrack` 丟包

---

## 4) 最快的「證據收集」清單（不靠猜）

> 目標：留下足夠證據讓你之後可以把原因分類，而不是每次都重查一次。

### 4.1 在發生當下（或重現時）
- `iostat -x 1 10`
- `pidstat -u -d 1 10 -p <minio-pid>`
- `ss -s`

### 4.2 如果你能抓到 goroutine dump / pprof
- goroutine 堆疊是否大量卡在：
  - `xlStorage.RenameData`
  - `readAllFileInfo`
  - `Erasure.Heal`
  - `net.(*conn).Read/Write`（網路/對端）

### 4.3 如果你要把問題釘到 syscall（判斷是否 rename/fsync 放大）
```bash
strace -fp <minio-pid> \
  -e trace=rename,renameat,renameat2,fsync,fdatasync,mkdir,mkdirat,unlink,openat \
  -tt -T
```

---

## 5) 建議的分流結論（你要在事件筆記寫的那一句）

你在 incident note 內可以用以下句型（不容易被 challenge）：

- **疑似 I/O 壓力導致 grid ping handler 延遲（結果）**：
  - 同時間 healing/MRF 活躍，且 iostat 顯示磁碟 await 飆高，goroutine/pprof 指向 `RenameData`/`readAllFileInfo`。

- **疑似 CPU throttling / 排程飢餓（結果）**：
  - 同時間 CPU throttling 或 runnable goroutines 暴增，ping handler 排不到；網路 counters 無明顯 drops。

- **疑似網路層（較少見，但需排除）**：
  - 同時間 NIC drops/MTU mismatch/conntrack saturation 有證據，且 I/O/CPU 指標正常。

# Trace：`canceling remote connection`（internal/grid muxserver 實際函式/檔案/呼叫鏈）

> 目的：把你在 MinIO log 裡看到的 `canceling remote connection` 這句話，**精準對回到 internal/grid 的實際檔案與函式**，並補一條「現場怎麼驗證」的最短 callchain。
>
> 適用情境：
> - PutObject / Healing 壓力上來後，節點開始噴 `canceling remote connection`
> - 你需要判斷：是 network 斷線？還是 **server goroutine 被 I/O / lock / CPU starvation 拖到 ping/keepalive 超時**？
>
> 注意：不同 release tag 可能微調檔名或常數命名；本頁刻意只給 **穩定 grep anchors**（不寫行號）。

---

## A) 先把 log 錨到 internal/grid

最短 grep：
```bash
cd /path/to/minio

grep -RIn "canceling remote connection" -n internal/grid | head -n 50
```

你通常會看到它出現在類似下列檔案（依版本不同而略有差異）：
- `internal/grid/muxserver.go`
- `internal/grid/muxclient.go`
- `internal/grid/handlers.go`（或 handler registry 類檔案）

---

## B) server 端：MuxServer 的「remote alive 檢查」鏈

### B.1 核心判斷：`checkRemoteAlive(...)`

Anchors：
```bash
cd /path/to/minio

grep -RIn "checkRemoteAlive\(" -n internal/grid | head -n 80

grep -RIn "canceling remote connection" -n internal/grid/muxserver.go internal/grid/muxclient.go | head -n 120
```

你要看的重點不是字串本身，而是 **觸發 cancel 的條件**，常見會包含：
- ping/pong 沒在 deadline 內完成
- remote 端 connection 狀態判定為 stale
- mux 的 per-connection watchdog 發現 stream 卡死/無回應

### B.2 時間參數（ping interval / deadline / jitter）

Anchors：
```bash
cd /path/to/minio

# 常見是這類常數/變數命名（不同版本略不同）
grep -RIn "ping" -n internal/grid | head -n 200

grep -RIn "interval|deadline|timeout" -n internal/grid | head -n 200
```

現場判讀技巧：
- 如果 timeout 值很短（例如秒級），在 **I/O tail latency** 大的時候更容易被誤判為 remote dead。
- 如果 timeout 值偏長，但你仍看到大量 cancel，多半是 connection/handler 端真的「卡到無法 forward/pong」。

---

## C) client 端：為什麼 Healing/Peer REST 會放大成大量 grid 流量

MinIO 在很多跨節點操作（包含 healing/status/調度）使用 grid/mux 之上的 RPC。

你可以用這組 anchors 把 healing 相關 handler 釘死：
```bash
cd /path/to/minio

# peer-rest 是最常見的入口
ls cmd/peer-rest-client.go cmd/peer-rest-server.go

grep -RIn "BackgroundHealStatus" -n cmd/peer-rest-client.go cmd/peer-rest-server.go | head -n 120

grep -RIn "HealBucketHandler|HealBucket" -n cmd/peer-rest-server.go | head -n 200

# internal/grid handler id（不同版本可能是 HandlerXxx / handlerXxx）
grep -RIn "HandlerBackgroundHealStatus|HandlerHealBucket" -n internal/grid cmd/peer-rest-*.go | head -n 200
```

判讀：
- healing 放大時：bg-heal 狀態查詢、bucket heal、object heal 會讓 **peer RPC 數量變多**。
- 如果同時 PutObject 在做大量 rename/fsync，會讓 server 端 goroutine/CPU 被拖慢 → ping/pong 不及 → `canceling remote connection`。

---

## D) 最短「現場驗證」流程（把 log → root cause 路徑釘死）

### D.1 先判斷是「網路」還是「資源 starvation」

1) **同一時間點**抓：
- MinIO log（含 `canceling remote connection` 前後 1–2 分鐘）
- `iostat -x 1` / `pidstat -w -u 1 -p $(pidof minio)`
- 若可：`strace -ttT -p <minio-pid> -f -e trace=fdatasync,fsync,rename,renameat2,openat,read,write`（短時間）

2) 若看到：
- disk `await` 飆高、`util` 接近 100%
- 或 goroutine stack/pprof 顯示卡在 `(*xlStorage).RenameData` / `fdatasync`

那通常是：**I/O tail latency → grid keepalive 超時 → cancel**（不是單純 network drop）。

### D.2 把 cancel 與 PutObject/Healing 連起來（最短 callchain 回憶法）

- PutObject：`PutObjectHandler` → `erasureObjects.putObject` → `renameData` → `disk.RenameData` → `(*xlStorage).RenameData`
- Healing：`mrfState.healRoutine` / scanner → `HealObject` → `(*erasureObjects).healObject` → `writeAllDisks` / `RenameData`
- 同時：peer REST/grid mux 需要 ping/pong 維持長連線

如果你要快速把兩條線放在同一個 grep 脈絡：
```bash
cd /path/to/minio

# PutObject/Healing 的 rename/fsync 端
grep -RIn "func \(s \*xlStorage\) RenameData" -n cmd/xl-storage.go

grep -RIn "commitRenameDataDir|renameData\(" -n cmd/erasure-object.go cmd/erasure-healing.go | head -n 200

# grid 的 cancel 端
grep -RIn "canceling remote connection" -n internal/grid | head -n 50
```

---

## E) 你要補進 troubleshooting 的最小結論（可直接引用）

> `canceling remote connection` 多數時候不是「網路線斷了」，而是 **server 端在 deadline 內無法回應 ping/pong 或 forward**。
> PutObject/Healing 把 rename/fsync/metadata 的 tail latency 拉高，是最常見的共振來源。

（對應的排查 checklist 建議放在：`docs/troubleshooting/canceling-remote-connection-quick-triage.md` 與 `...decision-tree.md`）

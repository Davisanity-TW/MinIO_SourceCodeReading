# Troubleshooting：`canceling remote connection` 與 PutObject/Healing（MRF/scanner/admin heal）共振時，怎麼快速證明「不是單純網路」？

> 目的：把你在事件現場最常遇到的組合——
> - server log 連續出現 `canceling remote connection ... not seen for ~60s`
> - 同時 PutObject latency 拉長、Healing/MRF/scanner 活躍
>
> ——整理成一個**可在 10~20 分鐘內產出「可驗證結論」**的 checklist。
>
> 本頁偏向「現場蒐證與因果鏈」；`internal/grid` 的精準 code anchors 請看：
> - `docs/troubleshooting/canceling-remote-connection-codepath.md`
> - `docs/trace/putobject-healing-callchain.md`

---

## 0) 先講結論格式（incident note 一段話就夠）

你最後通常需要寫成這樣（可直接 copy）：

> `canceling remote connection` 對應 MinIO `internal/grid` mux server watchdog：server 端基於 `LastPing` 超過門檻（常見 `15s * 4 ≈ 60s`）主動關閉 remote connection。
> 同時間窗 MRF/scanner/healing（或 admin heal）工作量上升、PutObject tail latency 變長、disk latency/IOPS/await 上升，推測主要是**資源壓力（排程/磁碟 I/O/metadata lock）導致 ping handler 無法準時更新**，而非單純網路斷線；後續以 network counters + pprof/goroutine dump + disk latency 交叉驗證。

---

## 1) 把這句 log 釘死：它是哪一端印的？門檻是多少？

### 1.1 code anchor（只要能釘到檔案/函式名）

```bash
cd /path/to/minio

# watchdog log
grep -RIn "canceling remote connection" -n internal/grid | head

# 追門檻（常見 15s*4=60s）
grep -RIn "clientPingInterval" -n internal/grid | head -n 50
grep -RIn "lastPingThreshold" -n internal/grid | head -n 80
```

如果你能在 source tree 直接看到 `lastPingThreshold = 4 * clientPingInterval`，那事件時間軸就會非常好寫：
- client 可能 ~30s 就先報 disconnect
- server 要到 ~60s 才會印 `canceling remote connection`

> 更完整解釋見：`canceling-remote-connection-codepath.md`

---

## 2) 先做「三分流」：網路 / 資源壓力 / 節點重啟

### 2.1 網路（純網路問題）通常長這樣

你會看到：
- `ss -ti`/NIC counters 明顯 re-transmit、packet loss、或 conn reset
- disk latency 沒明顯變化
- healing/MRF/scanner 沒特別活躍（或即使活躍也沒把 I/O 打上去）

### 2.2 資源壓力（最常見：I/O 或排程）通常長這樣

你會看到：
- **disk await/latency 飆高**（尤其 metadata-heavy：rename/fsync）
- PutObject 的 P99/P999 拉長（即使 QPS 沒變）
- healing/MRF/scanner/admin-heal 的工作量在同一時間窗上升
- goroutine dump/pprof 能看到 syscall/lock contention

### 2.3 節點重啟/過載（更像「結果」）

你會看到：
- OOM kill、kernel hung task、或 MinIO process 重啟
- 之後大量 healing（因為 disks/peers 短暫掉線後回來）

---

## 3) 最快的「共振證據鏈」：PutObject ↔ MRF ↔ HealObject ↔ grid peer RPC

### 3.1 PutObject 留洞 → MRF queue

把 PutObject 的 partial enqueue 釘死：

```bash
cd /path/to/minio

grep -RIn "func (er erasureObjects) addPartial" -n cmd/erasure-object.go
grep -RIn "globalMRFState\.addPartialOp" -n cmd/erasure-object.go cmd/*.go

grep -RIn "func (m \*mrfState) addPartialOp" -n cmd/mrf.go
```

關鍵語意（寫在事件筆記裡最好用的一句）：
- `addPartialOp()` 是 **non-blocking**：queue 滿會 drop（不會 block PutObject），所以你可能看到 PutObject 成功，但洞/缺片後續要靠 healing 才補回。

### 3.2 MRF 消費 → HealObject

```bash
cd /path/to/minio

grep -RIn "func (m \*mrfState) healRoutine" -n cmd/mrf.go
grep -RIn "HealObject\(" -n cmd/mrf.go | head -n 80
```

### 3.3 HealObject 真正 I/O 熱點（RS rebuild + RenameData）

```bash
cd /path/to/minio

grep -RIn "func (er \*erasureObjects) healObject" -n cmd/erasure-healing.go

# metadata fan-out / quorum
grep -RIn "readAllFileInfo\(" -n cmd/erasure-healing.go cmd/*.go | head -n 40

# RS rebuild
grep -RIn "func (e Erasure) Heal" -n cmd/erasure-decode.go

# commit（tmp → 正式）
grep -RIn "RenameData\(" -n cmd/erasure-healing.go cmd/storage-interface.go cmd/xl-storage.go | head -n 120
```

> 你要的核心因果鏈其實是：**healing / rename/fsync 壓力 → goroutine/handler 延遲 → grid ping handler 沒更新 LastPing → watchdog 60s 斷線**。

---

## 4) 現場最小蒐證包（你有 shell 就能做）

> 你不一定每次都能開 pprof；但以下這包至少能把事件「寫成能復盤的筆記」。

1) **抓出 log 的時間窗與頻率**（server 端）
- 目標：證明是「連續」而不是「偶發」

2) **同時間窗的 disk latency / iostat**
- 目標：證明 I/O 壓力是否同步上升

3) **同時間窗 healing/MRF/scanner 活躍證據**
- 目標：證明 background tasks 是否同步上升（admin heal status、或 MinIO metrics/log）

4) **同時間窗 PutObject tail latency**
- 目標：證明使用者感知/應用端 timeout 是否與 grid watchdog 同步

> 具體指令與模板可搭配：
> - `docs/troubleshooting/canceling-remote-connection-grep-pack.md`
> - `docs/troubleshooting/canceling-remote-connection-incident-note-template.md`

---

## 5) 下一步（當你已經判定「不是單純網路」）

- 若 I/O latency 高：優先查 `RenameData()`（metadata-heavy）與底層 disk/FS（fsync/rename/dirent lock）
- 若 CPU/排程高：看 goroutine dump/pprof（syscall、mutex、GC）
- 若 healing 非預期爆量：回頭查觸發來源（MRF vs scanner vs admin heal vs disk heal）

對照讀碼：
- PutObject/Healing 最短 call chain：`docs/trace/putobject-healing-callchain.md`
- healing 觸發來源總覽：`docs/trace/healing.md`

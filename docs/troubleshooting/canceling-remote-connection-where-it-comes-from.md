# Troubleshooting：`canceling remote connection ... not seen for ...` 這句 log 是哪裡印出來的？（MinIO）

> 目標：把你在現場看到的錯誤訊息對回 **實際檔案/函式**，並解釋這句話在 code 裡的語意。
>
> 這能幫你避免誤判成「一定是網路壞了」：很多時候它只是代表 **對端連線（或該連線上的 keepalive/ping）在一段時間內沒被處理到**，原因可能是 I/O/CPU/GC 壓力、goroutine backlog、或節點短暫 stall。

---

## 1) 原始碼落點（精準到檔案/行）

以本機 workspace `/home/ubuntu/clawd/minio` 為準（HEAD：`b413ff9fd`），這句 log 出現在：

- 檔案：`internal/grid/muxserver.go`
- 位置（約略）：`muxserver.go:246`
- 片段（字串本體）：

```go
fmt.Errorf("canceling remote connection %s not seen for %v", m.parent, last)
```

你可以用下列指令在不同版本上自行釘死（避免行號飄）：

```bash
cd /home/ubuntu/clawd/minio

git rev-parse --short HEAD

grep -RIn "canceling remote connection" internal/grid | head
```

---

## 2) 這句話在 code 語意上代表什麼？

從字面拆解：

- `remote connection %s`：某個 **grid 的遠端連線**（對應到特定 peer/endpoint；實際格式由 `m.parent` 的 `String()` 決定）
- `not seen for %v`：伺服器端「最後一次看到活動」到現在已經過了 `last` 這段時間
- `canceling`：伺服器端決定把這條連線 cancel 掉（通常代表該連線上的 context/handler 會被終止，然後重新建立或由上層重試）

關鍵點：它不是在說「TCP 一定斷了」，而是說 **這條連線在 MinIO 的 grid mux 管理器眼中太久沒被“看到/更新心跳”**。

---

## 3) 你在 incident 上最常需要的 3 個假設（由常見→較少見）

### A) 節點 stall / handler backlog（最常見）
**現象**：
- 同時間 PutObject latency 上升、MRF/Healing 活躍、或磁碟 latency 飆高
- 大量 `canceling remote connection`（尤其在尖峰）

**推論**：
- grid 的 ping/pong 或 mux handler 因為 CPU/I/O 壓力「排不到時間片」，導致 `last seen` 變大

**對應讀碼線索**：
- Healing：`cmd/erasure-healing.go`（`readAllFileInfo` / `erasure.Heal` / `RenameData`）
- MRF：`cmd/mrf.go`（queue drop / dynamic sleeper）

### B) 網路抖動/重傳/丟包（確實可能，但不是唯一）
**現象**：
- 單一節點或單一 pair 特別嚴重
- 同時有 link flap、errors、或 kernel TCP retrans 明顯增高

**建議**：
- 先用 node-level 指標確認：retrans、NIC errors、bonding/MTU、交換器 port error

### C) 時間/暫停（clock jump / VM pause / noisy neighbor）
**現象**：
- `not seen for` 的時間突然跳得很大
- 但整體 I/O 指標不一定對稱變差

**建議**：
- 檢查時間同步（chrony/ntpd）、是否有 VM pause（雲環境/Hypervisor）、或 host 層面 throttling

---

## 4) 你下一步要補哪兩個「最有用的證據」

1) **同時期 pprof / goroutine dump**：確認是否 goroutine backlog（尤其是 network handler / grid）
2) **磁碟 latency 與 rename/fsync**：對齊是否 PutObject commit 或 Healing rename 在卡（參考 `docs/trace/putobject.md` 與 `docs/trace/healing.md`）

---

## 5) 本輪進度

- 新增本頁：把 `canceling remote connection` 的 log 訊息對回 MinIO source 的實際位置（`internal/grid/muxserver.go`），並給出讀碼/排障方向。

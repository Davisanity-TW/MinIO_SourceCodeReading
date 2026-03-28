# Trace：Peer REST（grid RPC）與 Healing 的關聯（grep 錨點）

> 目的：當你在 incident 同時間看到：
> - `canceling remote connection ... not seen for ~60s`（grid streaming mux watchdog）
> - healing / MRF / scanner 很忙
>
> 你往往需要回答：**Healing 是不是正在透過 peer REST（grid RPC）跨節點打大量請求？**
>
> 這頁整理「最短可釘死」的檔案/函式/grep 錨點，方便你在不同 MinIO RELEASE tag 間快速對齊。

延伸閱讀：
- PutObject ↔ Healing 主線：`docs/trace/putobject-healing-callchain.md`
- `canceling remote connection` 排查：`docs/troubleshooting/canceling-remote-connection.md`

---

## 1) 先把概念拆開：peer REST 是什麼？跟 grid 什麼關係？

- **grid**：MinIO node-to-node 的 RPC transport（含 streaming mux / keepalive ping）。
- **peer REST**：建在 grid 上的一組「對 peer 打的 REST-ish RPC」（不同版本命名略有差，但檔名通常固定在 `cmd/peer-rest-*.go`）。

實務上：
- healing/scanner/rebalance 相關工作，常需要對 **持有某些 disks/parts 的 peer** 查詢/拉資料/下指令。
- 當背景任務很忙（或某些 disks latency 很高），peer REST 的 RPC backlog 會放大 grid 的壓力。

---

## 2) 一鍵釘死：你的版本是否有 peer REST server/client？

在你跑的 MinIO source tree（對應 release tag / commit）：

```bash
cd /path/to/minio

# 通常會看到 server/client 定義
ls cmd/peer-rest-*.go

# 找「peer REST server」註冊 handler 的地方
grep -RIn "type peerRESTServer" -n cmd/peer-rest-server.go 2>/dev/null || true

# 找「peer REST client」如何呼叫 peer
grep -RIn "type peerRESTClient" -n cmd/peer-rest-client.go 2>/dev/null || true
```

如果你的版本拆檔不同，改用字串搜尋也能快速對齊：

```bash
cd /path/to/minio

grep -RIn "peer rest" -n cmd | head -n 50
```

---

## 3) Healing 相關的 peer REST：你要抓哪些關鍵字？

不同版本的 peer REST handler 名稱會變，但「你想找的語意」通常落在這幾類：

- healing / background heal status
- scanner / metacache
- admin / drive status

建議直接用關鍵字掃：

```bash
cd /path/to/minio

# 先把 heal/scanner/rebalance 相關的 peer REST 端點或 handler 名稱列出來
grep -RIn "Heal" -n cmd/peer-rest-server.go cmd/peer-rest-client.go | head -n 200

grep -RIn "BackgroundHeal" -n cmd/peer-rest-server.go cmd/peer-rest-client.go | head -n 200

grep -RIn "scanner" -n cmd/peer-rest-server.go cmd/peer-rest-client.go | head -n 200
```

你在 incident note 最想釘死的，是這兩件事：
1) **server 端**：peer REST 有哪些 heal/scanner 相關 handler（peer 收到後做什麼）
2) **client 端**：哪些背景工作會呼叫 peer REST（誰在打、打多頻繁、是否有 retry/backoff）

---

## 4) 把「grid 斷線」跟「peer REST backlog」放在同一個視角

當你看到：
- `canceling remote connection ... not seen for ~60s`

不要只把它當成「網路問題」。在 healing/scanner/rebalance 忙的時段，它也常是：
- peer REST/背景工作造成 goroutine 排隊 + I/O/CPU 飆 → streaming mux ping/pong 來不及處理

你可以用這個最短關聯鏈來寫 incident note（可直接貼）：

- **PutObject 成功但留下洞**：`cmd/erasure-object.go: erasureObjects.addPartial()` → `globalMRFState.addPartialOp(...)`
- **MRF 背景補洞**：`cmd/mrf.go: mrfState.healRoutine()` → `z.HealObject(...)`
- **Healing 真正重建**：`cmd/erasure-healing.go: (*erasureObjects).healObject()` → `erasure.Heal(...)` + `disk.RenameData(...)`
- **跨節點協作**（可能）：`cmd/peer-rest-client.go` 透過 grid 對 peer 打 RPC（請用本頁第 3 節 grep 把實際 handler/端點釘死）
- **grid watchdog**：`internal/grid/muxserver.go: (*muxServer).checkRemoteAlive()`（~60s）

---

## 5) 本輪進度
- 新增本頁：提供 peer REST（grid RPC）與 healing/scanner 的快速 grep 錨點，方便把 `canceling remote connection` 與跨節點 RPC 壓力放在同一張圖裡看。

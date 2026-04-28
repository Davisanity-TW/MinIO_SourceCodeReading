# `canceling remote connection`：常見 log 片段與可直接 grep 的 pattern

> 目的：把我在現場最常見的 `canceling remote connection ... not seen for ...` 相關 log 片段整理成「一眼就能 grep」的 pattern，方便你把時間窗/節點對齊到：MRF/healing/scanner/renameData/RenameData/peer REST。

> 這頁刻意**不**重講完整 root-cause map（那在其他頁），只放：
> 1) log 長相模板
> 2) journald/grep pattern
> 3) 一組最小關聯關鍵字（同時間窗）

---

## 1) 單行 log 模板（incident note 建議直接照抄欄位）

你在 server 端最常看到的單行會長得像：

```
canceling remote connection (xxx) (local->remote) not seen for 1m0s
```

建議你在 incident note 直接拆成三欄：
- **time window**：log 發生時間 ±60–120s
- **local->remote**：把 local/remote 節點（IP:port 或 nodeName）固定下來
- **not seen for**：通常約 ~60s（對應 server 端 mux watchdog）；若偏離很多，優先懷疑 NTP/時間跳動或是版本差異

---

## 2) journald / grep patterns（最小可照抄）

### 2.1 先抓出 `canceling remote connection` 的頻率 + local->remote 組合

```bash
# 依你的 unit 名稱調整（minio.service / minio@.service / kubelet logs etc.）
journalctl -u minio --since "-2h" | \
  grep -E "canceling remote connection" | \
  sed -E 's/.*\(([^)]*)\) \(([^)]*)\) not seen for.*/id=\1 local_remote=\2/' | \
  sort | uniq -c | sort -nr | head
```

> 用意：先知道是不是集中在固定的 A→B，還是整個 cluster 都在噴。

### 2.2 同時間窗把 background/healing/MRF/scanner 的關鍵字一起拉出來

```bash
TS="2026-04-28 13:58:00"  # 事件時間（例）
DUR="5m"                  # 往前後抓多一點（例）

journalctl -u minio --since "$TS" --until "$TS + $DUR" | \
  grep -E "canceling remote connection|mrf|heal|healing|scanner|rebalance|RenameData|renameData|readAllFileInfo|Insufficient(Read|Write)Quorum" | \
  head -n 200
```

> 用意：你不需要先知道 root cause；只要同時間窗看到 heal/scanner/MRF/rename 的關鍵字在升溫，就能把方向先定成「對端忙」類型，而不是先去調 MTU。

---

## 3) 看到這些 log 時，優先把哪幾條線對齊？（最小關聯清單）

**A. healing/MRF/scanner 是否活躍**（通常是最常見共振來源）
- `mrf` / `partial` / `healRoutine`
- `HealObject` / `healObject`
- `data-scanner` / `applyHealing`

**B. rename/fsync 類 metadata-heavy 熱點**（PutObject 與 healing 都會打到）
- PutObject：`renameData()` / `commitRenameDataDir()`
- Healing：`StorageAPI.RenameData()` → `(*xlStorage).RenameData()`

**C. 資源壓力（CPU/GC/I/O latency）**
- `iostat` 高 await / util
- Go runtime：CPU throttling、GC 停頓（看 pprof / SIGQUIT stack）

---

## 4) 延伸閱讀（同 repo）

- Trace：`docs/trace/grid-canceling-remote-connection.md`（grid watchdog 印 log 的點 + LastPing/LastPong 錨點）
- Trace：`docs/trace/putobject.md`（PutObject 主要呼叫鏈）
- Trace：`docs/trace/healing.md`（MRF/scanner/admin 入口→HealObject/healObject→RenameData）
- Troubleshooting：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`（10 分鐘 SOP）

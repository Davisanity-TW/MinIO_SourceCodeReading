# Troubleshooting：`canceling remote connection`（最小可重現/驗證組合）

> 目的：把「你在現場到底要先驗證什麼」收斂成 **一張最小清單**。
>
> 這頁刻意不展開所有理論（那些已經在其他子頁有），只做：
> - **先用最少指令** 釘住「是網路問題」還是「是 server 忙到 ping/pong 排不到」。
> - 讓你能把這句 log 和 PutObject/Healing/rename/fsync 的壓力關聯起來。

相關主頁：
- 總覽：`docs/troubleshooting/canceling-remote-connection.md`
- code trace（grid/muxserver）：`docs/trace/grid-canceling-remote-connection.md`
- PutObject/Healing 的 rename/commit 熱點：`docs/trace/putobject-healing-real-functions.md`

---

## 1) 先釘住 log 的「時間密度」與「同時段背景負載」

### 1.1 在所有節點抓同一時間窗（例如前後 10 分鐘）

你要的是「同一分鐘內每個節點各出現幾次」：

```bash
# 視你的環境調整：journalctl / docker logs / k8s logs
# 目標：同時看 minio server log + kernel/dmesg（IO hang）

# Linux/journald 範例
journalctl -u minio --since "-10 min" | grep -F "canceling remote connection" | wc -l
journalctl -u minio --since "-10 min" | grep -E "(Drive offline|I/O error|rename|fsync|fdatasync)" | tail -n 200

dmesg -T | tail -n 200 | grep -E "(blocked for more than|I/O error|EXT4-fs error|XFS|nvme|sd )"
```

判讀：
- **每個 node 同時飆高**：更像是 cluster-level 壓力（healing/putobject/scan/compaction）或共用瓶頸（交換器、上游網路、共享 storage）。
- **只有特定 node 飆高**：更像是單點 IO hang、NIC/driver、或該 node 承載了熱 bucket/heal。

---

## 2) 最短的「網路 vs CPU/IO 壓力」二分法

### 2.1 直接看 RTT / packet loss（同機房也要做）

```bash
# 互 ping（挑 2~3 台互打，至少含出問題那台）
ping -c 50 <peer-ip>

# 更敏感的 jitter/延遲分佈（若有）
# mtr -rwzc 200 <peer-ip>
```

若 ping/mtr 明顯抖動/掉包：先走網路路徑（bonding、switch、MTU、TCP retrans）。

### 2.2 ping 很穩但錯誤仍爆：高度懷疑「server 忙到 mux ping/pong 排不到」

下一步要看：
- 同時段是否有 PutObject/Healing/MRF/scanner 的尖峰
- IO tail latency（fsync/rename/meta）

---

## 3) 把 PutObject/Healing 的壓力對到「可 grep 的函式錨點」

你要把「現場看到的 syscall 熱點」對回 MinIO 的 helper：
- `(*xlStorage).RenameData`（rename + sync）
- `commitRenameDataDir(...)`（可見性切換）

```bash
cd /path/to/minio

grep -RIn "func (s \*xlStorage) RenameData" -n cmd/xl-storage.go

grep -RIn "commitRenameDataDir" -n cmd/erasure-object.go cmd/erasure-healing.go | head -n 120
```

若你同時看到：
- rename/fsync/fdatasync tail latency 上升
- `canceling remote connection` 密度上升

那通常不是「網路本身壞掉」，而是「RPC 連線還活著，但 ping/pong handler 沒有被排程到（server busy）」。

---

## 4) 最小現場資料包（建議每次 incident 都蒐集）

- 發生前後 10 分鐘：
  - minio server log（含 `canceling remote connection`）
  - kernel log（I/O error、blocked tasks）
  - 一次 `SIGQUIT` goroutine dump（或 pprof goroutine）
- 同時段：
  - healing 狀態（bg heal / scanner）
  - bucket/object 變更量（PutObject rate）

把這包資料留存後，你再回到這些頁去做深挖會快非常多：
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- `docs/troubleshooting/canceling-remote-connection-pprof-goroutine-playbook.md`
- `docs/troubleshooting/canceling-remote-connection-root-causes.md`

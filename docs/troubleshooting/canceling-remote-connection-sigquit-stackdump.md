# canceling remote connection：用 SIGQUIT goroutine dump 快速判斷「對端忙」是哪一種忙

> 目的：當你看到
>
> `canceling remote connection A:9000->B:9000 not seen for ~60s`
>
> 但 `ss -ti` 看不出明顯 retrans/RTO、或現場也同時有 PutObject latency / healing/scanner/MRF 活躍時，最快的佐證方式之一是：
> - **對被 cancel 的那台節點（remote B）**送 `SIGQUIT` 拿一份 goroutine dump
> - 用關鍵字把 goroutine 大量卡住的點分類
>
> 這份筆記的目標不是「完整解讀 stackdump」，而是提供 **5 分鐘內可 grep 的 signature**，用來把方向快速分成：
> - (A) I/O rename/fsync 壅塞
> - (B) healing/scanner/MRF fan-out 壅塞
> - (C) grid ping handler 本身排不到（症狀，不是 root cause）
> - (D) GC / CPU throttling

---

## 1) 拿到 goroutine dump（建議在 remote B 執行）

### 1.1 systemd 環境（最常見）

1) 找 PID（或直接看 service 主 PID）：
```bash
systemctl status minio
```

2) 送 SIGQUIT：
```bash
sudo kill -QUIT <PID>
```

3) 到 log 裡找 dump（可能會很長）：
```bash
journalctl -u minio --since "-5min" | less
```

> 注意：SIGQUIT 會把 stackdump 印到 stderr/stdout（systemd journal）。

### 1.2 container/K8s

- 找到對應 container 後 `kill -QUIT 1`（或主程序 PID）。
- 若沒權限送 signal：用 `kubectl exec` 進去，再送。

---

## 2) 先做粗分類：最便宜的 grep signatures

把 dump 存成檔案（例如 `/tmp/minio.goroutines.txt`）後：

### 2.1 I/O：rename/fsync/fdatasync（PutObject / heal writeback 最常卡）

```bash
grep -nE "renameat2|rename\(|fdatasync|fsync|pwrite|write\(" -n /tmp/minio.goroutines.txt | head -n 80
```

對應讀碼錨點（把 syscall 對回 Go 路徑）：
- `cmd/xl-storage.go: func (s *xlStorage) RenameData(...)`
- `cmd/erasure-object.go: renameData(...) / commitRenameDataDir(...)`
- `cmd/erasure-healing.go: (*erasureObjects).healObject(...)`（writeback + commit）

> 若此類 signature 佔比很高，優先查：底層磁碟/RAID/檔案系統延遲、I/O throttling、資源競爭（同 host 上是否有其他 noisy neighbor）。

### 2.2 Healing/Scanner/MRF：大量 goroutine 卡在 fan-out/讀 meta

```bash
grep -nE "healObject\(|HealObject\(|applyHealing|readAllFileInfo\(|mrfState\)\.healRoutine" -n /tmp/minio.goroutines.txt | head -n 120
```

常見解讀：
- `readAllFileInfo(...)` 堆積：meta fan-out 讀 xl.meta 卡住（I/O 或單顆盤慢）
- `erasure\.Heal` 出現多：RS rebuild/讀取 shard 來源卡住（I/O 或 CPU）
- `mrfState.healRoutine` 很多：PutObject partial → MRF queue 在積壓

### 2.3 grid / ping / mux：症狀層，通常不是 root cause

```bash
grep -nE "internal/grid|muxServer\)\.ping|checkRemoteAlive|OpPing|handlePing" -n /tmp/minio.goroutines.txt | head -n 120
```

常見解讀：
- 看到很多 goroutine 卡在 grid mux 相關：
  - 可能是 **對端整體排程壓力**（CPU throttling / runqueue 高）
  - 或是 **I/O 壓力**讓整個程序卡住（包含 ping handler）

> 方向：不要只修 grid；要回去找「讓整個節點忙到 ping 排不到」的上游原因。

### 2.4 GC / CPU：Stop-the-world 或 throttling

```bash
grep -nE "runtime\.gc|GC worker|mark worker|scavenge|sysmon" -n /tmp/minio.goroutines.txt | head -n 120
```

搭配系統指標看：
- `top` / `pidstat -p <PID> 1` CPU 飆高？
- cgroup throttling（K8s：`container_cpu_cfs_throttled_seconds_total`）？

---

## 3) 最短結論模板（incident note 可直接貼）

> 在 remote 節點（B）同時間窗（T±5m）抓取 goroutine dump，觀察到大量 goroutine 卡在：
> - （填）`xlStorage.RenameData` / `renameData` / `readAllFileInfo` / `erasureObjects.healObject`
> 推測節點 I/O/背景修復壓力導致 grid 心跳（LastPing）更新延遲，觸發 `canceling remote connection ... not seen for ~60s`。

---

## 4) 延伸閱讀

- 快速分流主頁：`docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- PutObject ↔ Healing 實際函式/檔案錨點：`docs/trace/putobject-healing-real-functions.md`

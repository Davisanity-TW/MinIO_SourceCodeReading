# 快速蒐證：用 SIGQUIT 取得 MinIO goroutine stack dump（對齊 `canceling remote connection` 的「對端忙」假說）

> 用途：當你懷疑 `canceling remote connection ... not seen for ~60s` 不是網路掉包，而是 **remote 節點忙到 ping handler 跑不動**（I/O latency、GC、鎖競爭、healing/scanner/MRF/rebalance）時，最快、最不需要預先開 pprof 的蒐證方式之一，就是在 **remote 節點**對 MinIO process 送一次 `SIGQUIT`，讓它在 stderr/journald 打出 **所有 goroutine 的堆疊**。
>
> 你要的是：把同一時間窗（T±1m）內的 stack dump，跟 `iostat -x` / `mc admin trace --type internal` / healing 狀態一起貼進 incident note，讓後續可以直接從 stack 看到「卡在 I/O / rename / metadata fan-out / erasure heal / grid handler」哪一類。

延伸閱讀（本 repo）：
- `docs/troubleshooting/canceling-remote-connection.md`
- `docs/troubleshooting/canceling-remote-connection-field-checklist.md`
- `docs/trace/putobject-healing-callchain.md`

---

## 0) 風險與注意事項
- `SIGQUIT` 會讓 Go runtime **同步輸出大量文字**（goroutine dump），可能瞬間刷爆 log；但它不會像 `SIGKILL` 一樣直接殺掉 process。
- 若你是在 Kubernetes：建議先確認 log 收集/sidecar 不會因為爆量而出事（例如 rate limit / buffer overflow）。
- 只做 **一次** 通常就夠；不要連續狂打。

---

## 1) systemd / journald（主機上跑 minio service）

### 1.1 找到 PID
```bash
pidof minio || pgrep -x minio
```

### 1.2 送 SIGQUIT（goroutine dump）
```bash
sudo kill -QUIT <PID>
```

### 1.3 立刻在同一時間窗撈 journald（抓 dump）
```bash
# 取最近 2 分鐘的 log（依你的事件時間窗調整）
journalctl -u minio -S "2 min ago" -o short-iso | tail -n 800
```

> 建議做法：先在 incident note 記下 `canceling remote connection` 的 `local->remote`，然後在 **remote 節點**打 SIGQUIT；同時間窗再補抓 `iostat -x 1 3`。

---

## 2) Kubernetes（Pod 內跑 minio）

### 2.1 找到 minio process PID（在 Pod 內）
```bash
kubectl -n <ns> exec -it <minio-pod> -- sh -lc 'ps -o pid,comm,args | egrep "minio($| )"'
```

### 2.2 送 SIGQUIT
```bash
kubectl -n <ns> exec -it <minio-pod> -- sh -lc 'kill -QUIT <PID>'
```

### 2.3 抓 Pod logs（含 stack dump）
```bash
kubectl -n <ns> logs <minio-pod> --since=2m | tail -n 1200
```

---

## 3) 你在 stack dump 裡最常要找的 5 類線索（對應到「為何 60s 沒更新 LastPing」）

> 目標是把堆疊分類，快速判斷是「網路」還是「remote 忙」。若 dump 內大量 goroutine 都在忙某一類工作，`canceling remote connection` 很可能是結果。

1) **Healing / MRF / scanner**
- `cmd/erasure-healing.go`：`(*erasureObjects).healObject`、`readAllFileInfo`、`RenameData`
- `cmd/mrf.go`：`(*mrfState).healRoutine`
- `cmd/data-scanner.go`：`applyHealing`

2) **PutObject rename/commit（大量 metadata ops）**
- `cmd/erasure-object.go`：`renameData`、`commitRenameDataDir`
- storage 層：`cmd/xl-storage.go`：`(*xlStorage).RenameData`

3) **grid / peer REST handler**
- `internal/grid/*`：mux read/write loop、handler dispatch
- `cmd/peer-rest-server.go`：BackgroundHealStatus/HealBucket 等

4) **I/O latency：卡在 syscall（read/write/fsync/rename）**
- 堆疊底部常會看到 `syscall.*` / `runtime.netpoll` 之外的檔案 I/O 路徑

5) **鎖競爭 / runtime 壓力（mutex/blocking）**
- 大量 goroutine `semacquire` / `sync.(*Mutex).Lock` / channel receive 可能表示排程/鎖競爭把 handler 拖慢

---

## 4) 建議貼進 incident note 的最小模板
- 時間窗：`T ± 5m`
- log：`canceling remote connection A:9000->B:9000 not seen for ~60s`
- remote(B) iostat：`await=%s util=%s`
- SIGQUIT dump：`已抓（附截取片段/檔案連結）`
- 同時間背景任務：`healing/scanner/MRF/rebalance`（有/無）

> 後續回放時，把 SIGQUIT dump 內「最重的 10 條 goroutine 堆疊」摘出來就很夠用了；不需要整份全貼。

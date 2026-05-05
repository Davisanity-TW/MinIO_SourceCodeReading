# canceling remote connection：用 SIGQUIT 抓 goroutine dump（快速判斷是不是「對端忙」）

> 目標：當你看到
>
> `WARNING: canceling remote connection A:9000->B:9000 not seen for 1m2.3s`
>
> 想快速確認是否屬於「B 節點忙到 grid ping handler 排不到（LastPing 不更新）」而不是純網路掉包。
>
> 核心想法：**抓一份 B 的 goroutine dump**，看是不是大量卡在 `RenameData()` / `fsync` / `readAllFileInfo()` / `erasure.Heal()` 等 I/O heavy 路徑。

---

## 1) 最快做法：對 MinIO process 送 SIGQUIT

在 **B 節點**：

```bash
# 1) 找 PID（systemd / container 依環境調整）
pidof minio

# 2) 送 SIGQUIT（Go runtime 會把所有 goroutine stack dump 到 stderr）
kill -QUIT <PID>
```

你會在 MinIO 的 stdout/stderr（或 systemd journal）看到一大段類似：
- `goroutine 1234 [IO wait]:`
- `goroutine 5678 [semacquire]:`

若是 systemd：
```bash
journalctl -u minio -n 2000 --no-pager
```

若是 container：
```bash
docker logs --tail 2000 <container>
```

---

## 2) 你在 dump 裡最想找的幾類「指紋」

### 2.1 明顯 I/O 卡住（最常造成 LastPing 不更新）

常見關鍵字（任一命中就很可疑）：
- `RenameData(` / `xlStorage).RenameData`
- `fsync` / `fdatasync`
- `readAllFileInfo(`（大量讀 `xl.meta`）
- `erasure.Heal(`（背景補洞重建）
- `renameat` / `pwrite` / `pread`

這時通常要回到 trace 對照：
- `docs/trace/putobject-healing.md`（PutObject partial → MRF → HealObject → `RenameData()`）
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`

### 2.2 goroutine 爆量/排隊（CPU/GC/鎖競爭）

常見關鍵字：
- `runtime.gopark` / `semacquire` 大量出現
- `(*RWMutex).RLock` / `Lock` 大量等待
- `GC worker` 很多 + `STW` 痕跡（少見但有）

若偏這類，除了 I/O，也要查：
- CPU throttling（K8s requests/limits）
- goroutine 泄漏（長連線/slow consumer）
- 版本已知 bug（可再按版本去 upstream issues 搜）

---

## 3) 把 dump 與 log/trace 對齊（incident note 建議欄位）

建議你在事件筆記固定留：
- time window：`T ± 5m`
- canceling log 來源：`A->B` 與 `not seen for` 秒數
- B 的 goroutine dump 取樣時間點
- dump 中最顯眼的 1–3 條 stack（貼最上面幾行即可）
- 同窗 I/O 指標：`iostat -x` 的 `await/%util`

---

## 4) 讀碼錨點（用 grep 固定，避免行號漂移）

在對照的 MinIO source tree：

```bash
# grid watchdog（印出 canceling 的地方）
grep -RIn "canceling remote connection" -n internal/grid | head

grep -RIn "checkRemoteAlive\(" -n internal/grid/muxserver.go | head -n 80

grep -RIn "LastPing" -n internal/grid/muxserver.go | head -n 80

# 常見 I/O heavy 路徑（healing / rename）
grep -RIn "func \(s \*xlStorage\) RenameData" -n cmd/xl-storage.go

grep -RIn "readAllFileInfo\(" -n cmd | head

grep -RIn "\\.Heal\(ctx" -n cmd | head
```

> 實務判讀：如果 dump 裡大量卡在 `RenameData/fsync/Heal/readAllFileInfo`，而 `retrans/RTO` 又不明顯，通常可以先把方向從「網路」移到「對端忙/資源壓力」。

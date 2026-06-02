# Namespace scanner / full scan / bitrot scan

> 這頁針對「namespace scanner 是什麼、mc 裡的 full scan 是什麼、bitrot scan 又是什麼」做一次原始碼對照。
>
> Source baseline：
> - MinIO `/Users/davidlin/.openclaw/workspace/minio`：`7aac2a2`
> - mc `/Users/davidlin/.openclaw/workspace/mc`：`77f82e1`
> - madmin-go `/Users/davidlin/.openclaw/workspace/madmin-go`

## TL;DR

三個詞不要混在一起：

| 名稱 | 實際意思 | 是否同一套流程 |
| --- | --- | --- |
| namespace scanner / data scanner | MinIO server 背景掃描整個 object namespace，更新 usage cache、scanner metrics，並抽樣觸發 healing / lifecycle / replication 等動作 | 主流程 |
| full scan | mc UI 對 scanner cycle 完成時間的顯示/估算語；不是 mc 發起另一個完整掃描 | scanner metrics 的解讀 |
| bitrot scan | healing scan mode 的 deep scan；會從磁碟讀 shard 並驗 bitrot checksum | scanner / admin heal 都可用的 heavier check |

最重要的判斷：

- `mc admin scanner status` 只是讀 MinIO server 的 scanner metrics。
- `cycle_complete_times` 只有在 `runDataScanner()` 裡 `objAPI.NSScanner(...)` 成功完成後才 append。
- `full scan` 不是每分鐘都會完成，也不是 mc client 自己掃 bucket；它是 server scanner cycle 的完成歷史被 mc 拿來估算。
- `bitrot scan` 不是另一個「namespace scanner」。它是 `HealDeepScan`，會把每個 part/shard 從 disk 讀出來驗 checksum，比 normal scan 重很多。

## 1. Namespace scanner 是什麼？

MinIO server 端的入口在：

- `cmd/data-scanner.go:155`：`runDataScanner(ctx, objAPI)`
- `cmd/erasure-server-pool.go:735`：`(*erasureServerPools).NSScanner(...)`

`runDataScanner()` 的註解直接把它定義成 cluster 內應該只有一個 scanner runner：

```go
// runDataScanner will start a data scanner.
// The function will block until the context is canceled.
// There should only ever be one scanner running per cluster.
func runDataScanner(ctx context.Context, objAPI ObjectLayer) {
    ctx, cancel := globalLeaderLock.GetLock(ctx)
    defer cancel()
    ...
    err := objAPI.NSScanner(ctx, results, uint32(cycleInfo.current), scanMode)
    ...
    if err == nil {
        cycleInfo.next++
        cycleInfo.current = 0
        cycleInfo.cycleCompleted = append(cycleInfo.cycleCompleted, time.Now())
        ...
    }
}
```

所以 namespace scanner 的核心語意是：

1. server leader 拿 `globalLeaderLock`。
2. 載入 `.minio.sys/buckets/.bloomcycle.bin` 裡的 scanner cycle state。
3. 定期呼叫 `objAPI.NSScanner(...)`。
4. `NSScanner` 會跨 pools / sets 對 bucket namespace 做掃描。
5. 掃描過程更新 usage cache / metrics，也可能抽樣觸發 healing。
6. 只有整個 cycle 成功回傳 `err == nil`，才把完成時間 append 到 `cycleCompleted`。

`(*erasureServerPools).NSScanner()` 的重要行為：

```go
allBuckets, err := z.ListBuckets(ctx, BucketOptions{})
...
for _, z := range z.serverPools {
    for _, erObj := range z.sets {
        go func(i int, erObj *erasureObjects) {
            ...
            err := erObj.nsScanner(ctx, allBuckets, wantCycle, updates, healScanMode)
            if err != nil {
                ...
                cancel()
                return
            }
        }(...)
    }
}
```

也就是它不是 client 端 list object；它是 server 端直接在 erasure set / disk layout 上跑的 background scanner。

## 2. Scanner 在掃什麼？

比較貼近實作的入口是：

- `cmd/data-scanner.go:307`：`scanDataFolder(...)`
- `cmd/xl-storage.go:529`：`(*xlStorage).NSScanner(...)`

`scanDataFolder()` 建出 `folderScanner`，然後遞迴掃資料夾 / object metadata：

```go
s := folderScanner{
    root:              basePath,
    oldCache:          cache,
    newCache:          dataUsageCache{Info: cache.Info},
    scanMode:          scanMode,
    disks:             disks,
    disksQuorum:       len(disks) / 2,
}
...
err := s.scanFolder(ctx, folder, &root)
```

這套 scanner 同時做幾件事：

- 估算 bucket / prefix / object / version 的 usage。
- 維護 data usage cache，避免每次都完整展開所有 prefix。
- 記錄目前 active path、last minute、last day、lifetime ops 等 metrics。
- 依 cycle / hash 抽樣做 object healing check。
- 掃到 lifecycle / replication 規則時，會搭配相關 action。

原始碼註解很關鍵：

```go
// A leaf is only scanned once every dataUsageUpdateDirCycles,
// rarer if the bloom filter for the path is clean and no lifecycles are applied.
// Skipped leaves have their totals transferred from the previous cycle.
//
// When selected there is a one in healObjectSelectProb that any object will be chosen for heal scan.
```

這代表「scanner cycle」不等於「每一輪都把每個 leaf 都重讀到最深」。MinIO 會用 cache / compacted leaf / bloom cycle 來控制成本。

## 3. `full scan` 是什麼？

在 mc 裡，`full scan` 是 scanner metrics UI 的顯示語，不是另一個 client-side job。

有兩個地方容易混：

### 3.1 Bucket full scan

`mc cmd/admin-scanner-status.go:148-180` 對 bucket stats 做判斷：

```go
// Look for a bucket full scan inforation only if all
// erasure sets completed at least 16 cycles
for _, st := range b.Stats {
    if len(st.Completed) < 16 {
        fullScan = false
        break
    }
    ...
}
...
if fullScan {
    took := latestESScan.Sub(earliestESScan)
    ...
    "Full bucket scan: "
}
```

這裡的 full bucket scan 意思是：每個 erasure set 都累積到足夠的 completed cycle 資料，mc 才有辦法估一段完整 bucket scan 的時間窗。

### 3.2 Overall full scan time

`mc cmd/admin-scanner-status.go:416-440` 用 `CyclesCompletedAt` 估算：

```go
const wantCycles = 16
if len(sc.CyclesCompletedAt) < 2 {
    addRow("Last full scan time:             Unknown (not enough data)")
} else {
    sort.Slice(sc.CyclesCompletedAt, ...)
    if len(sc.CyclesCompletedAt) >= wantCycles {
        sinceLast := sc.CyclesCompletedAt[0].Sub(sc.CyclesCompletedAt[wantCycles-1])
        addRowF(title("Last full scan time:")+"   %s; Estimated %s/month", ...)
    } else {
        sinceLast := sc.CyclesCompletedAt[0].Sub(sc.CyclesCompletedAt[1]) * time.Duration(wantCycles)
        addRowF(title("Est. full scan time:")+"   %s; Estimated %s/month", ...)
    }
}
```

這個 `wantCycles = 16` 對應 MinIO 端的 `dataUsageUpdateDirCycles = 16`。所以 mc 的 `full scan time` 更像是：「以最近 scanner cycle 完成時間推估一輪完整 coverage 的時間」。

結論：**full scan 是 scanner cycle metrics 的人類可讀估算，不是 mc 另外打 API 叫 server 全量掃一次。**

## 4. Scanner 跟 healing 的關係

Scanner 不是只算 usage。它也會抽樣做 object heal check。

在 `scanDataFolder()` 內：

```go
if globalIsErasure && !cache.Info.SkipHealing {
    // Do a heal check on an object once every n cycles.
    s.healObjectSelect = healObjectSelectProb
}
```

掃到 object 時：

```go
item.heal.enabled = thisHash.modAlt(...) && f.shouldHeal()
item.heal.bitrot = f.scanMode == madmin.HealDeepScan
sz, err := f.getSize(item)
```

最後會落到：

- `cmd/data-scanner.go:952`：`(*scannerItem).applyHealing(...)`

```go
scanMode := madmin.HealNormalScan
if i.heal.bitrot {
    scanMode = madmin.HealDeepScan
}
healOpts := madmin.HealOpts{
    Remove:   healDeleteDangling,
    ScanMode: scanMode,
}
res, _ := o.HealObject(ctx, i.bucket, i.objectPath(), oi.VersionID, healOpts)
```

所以 scanner 觸發 healing 時，真正執行仍然是 object layer 的 `HealObject()`，不是 scanner 自己修資料。

## 5. Bitrot scan 是什麼？

madmin-go 定義非常直接：

```go
// HealNormalScan checks if parts are present and not outdated
HealNormalScan

// HealDeepScan checks for parts bitrot checksums
HealDeepScan
```

MinIO 裡的差異發生在：

- `cmd/erasure-healing-common.go:414-422`

```go
switch scanMode {
case madmin.HealDeepScan:
    verifyResp, verifyErr = onlineDisk.VerifyFile(ctx, bucket, object, meta)
default:
    verifyResp, verifyErr = onlineDisk.CheckParts(ctx, bucket, object, meta)
}
```

Normal scan 走 `CheckParts()`：

- `cmd/xl-storage.go:2363`：`checkPart(...)`
- `cmd/xl-storage.go:2398`：`CheckParts(...)`

它是 light check：看 part file 是否存在、是否是檔案、size 是否小於 expected shard size。註解明講：

```go
// checkPart is a light check of an existing and size of a part, without doing a bitrot operation
```

Deep scan 走 `VerifyFile()`：

- `cmd/xl-storage.go:3082`：`bitrotVerify(...)`
- `cmd/xl-storage.go:3100`：`VerifyFile(...)`

它會對每個 part 取 `checksumInfo`，打開 shard file，呼叫 `bitrotVerify(...)`：

```go
checksumInfo := erasure.GetChecksumInfo(part.Number)
partPath := pathJoin(volumeDir, path, fi.DataDir, fmt.Sprintf("part.%d", part.Number))
err := s.bitrotVerify(ctx, partPath,
    erasure.ShardFileSize(part.Size),
    checksumInfo.Algorithm,
    checksumInfo.Hash, erasure.ShardSize())
```

所以 bitrot scan 的成本差異很大：

- normal scan：metadata / stat / size check 為主。
- deep / bitrot scan：需要讀 shard 內容並驗 checksum，會產生實際 disk read I/O。

## 6. Bitrot scan 怎麼被啟用？

有兩條常見路徑。

### 6.1 Scanner background cycle 的 bitrot 設定

MinIO heal config：

- `internal/config/heal/heal.go:34`：`bitrotscan`
- `internal/config/heal/heal.go:39`：`MINIO_HEAL_BITROTSCAN`
- `internal/config/heal/heal.go:65-69`：`BitrotScanCycle()`
- `internal/config/heal/heal.go:102-107`：default 是 `off`

`parseBitrotConfig()` 的語意：

- `off` → `-1`：不啟用 background bitrot deep scan。
- `on` → `0`：continuous bitrot scanning，每個 scanner cycle 都用 `HealDeepScan`。
- `<N>m` → 每 N 個月跑一段 deep scan cycle，最小 1 month。

`runDataScanner()` 每輪會呼叫：

```go
scanMode := getCycleScanMode(cycleInfo.current, bgHealInfo.BitrotStartCycle, bgHealInfo.BitrotStartTime)
```

`getCycleScanMode()`：

```go
switch bitrotCycle {
case -1:
    return madmin.HealNormalScan
case 0:
    return madmin.HealDeepScan
}
...
if time.Since(bitrotStartTime) > bitrotCycle {
    return madmin.HealDeepScan
}
return madmin.HealNormalScan
```

### 6.2 Admin heal 的 `--scan deep`

mc 有 hidden flag：

- `cmd/admin-heal.go:57`：`--scan`
- `cmd/admin-heal.go:642`：`transformScanArg("deep") -> madmin.HealDeepScan`
- `cmd/admin-heal.go:710`：放進 `madmin.HealOpts{ScanMode: ...}`

所以手動 heal 時也可以走 deep scan。這跟 background namespace scanner 的 bitrot cycle 是同一種 `HealDeepScan` 語意，但觸發來源不同：

- background scanner：依 `heal bitrotscan` config 決定本輪 scanner 是否 deep。
- admin heal：由 `mc admin heal --scan deep` 直接指定。

## 7. 這三者的機制差異

### Namespace scanner

- 來源：MinIO server background goroutine。
- 範圍：整個 object namespace，跨 bucket / pool / erasure set。
- 主要用途：usage cache、metrics、lifecycle/replication/scanner actions、抽樣 healing。
- 成功完成後：更新 `cycle_complete_times`。
- 觀測：`mc admin scanner status`、scanner metrics、active paths。

### Full scan

- 來源：mc UI / metrics 解讀。
- 範圍：不是新流程；它指 scanner cycles 對 bucket / namespace 的完整 coverage 估算。
- 主要用途：讓人知道最近完整掃描耗時或估計多久能完整覆蓋。
- 成功完成條件：依 server 端 `CyclesCompletedAt` / bucket stats completed cycles 判斷。
- 觀測：`Last full scan time`、`Est. full scan time`、`Full bucket scan`。

### Bitrot scan

- 來源：`HealDeepScan` scan mode。
- 範圍：被 healing check 選中的 object parts。
- 主要用途：確認 shard 內容沒有 silent corruption。
- 成本：會讀 part/shard content 並驗 checksum，比 normal scan 重。
- 觀測：heal/scanner I/O、bitrot detected/healed metrics、`mc admin heal --scan deep` 或 `heal bitrotscan` config。

## 8. 現場判讀建議

看到 scanner / full scan / bitrot 相關現象時，我會這樣分流：

1. `cycle_complete_times` 很久沒更新：先查 namespace scanner 是否卡住或失敗，不要先怪 mc。
2. `Last full scan time` 很久：它是用最近完成 cycles 估的，先看 `current_cycle/current_started/active/last_minute` 有沒有進展。
3. I/O 突然變重，scanner active：查 `heal:bitrotscan` 是否開啟，或是否有人跑 `mc admin heal --scan deep`。
4. normal scan 和 deep scan 差異很大：normal 只做 presence/outdated/size 類檢查；deep 會讀資料驗 checksum。
5. 若同窗出現 healing backlog、PutObject latency、`canceling remote connection`，bitrot deep scan 會是重要共振候選，因為它會增加大量讀 I/O。

## 一鍵 grep

```bash
cd /Users/davidlin/.openclaw/workspace/minio

# scanner cycle / NSScanner
grep -RIn "func runDataScanner" cmd/data-scanner.go
grep -RIn "func (z \\*erasureServerPools) NSScanner" cmd/erasure-server-pool.go
grep -RIn "cycleCompleted\\|dataUsageUpdateDirCycles" cmd/data-scanner.go cmd/data-usage-cache.go

# scanner -> HealObject
grep -RIn "func (i \\*scannerItem) applyHealing" cmd/data-scanner.go
grep -RIn "item.heal.enabled\\|item.heal.bitrot" cmd/data-scanner.go

# normal vs deep / bitrot
grep -RIn "HealNormalScan\\|HealDeepScan" /Users/davidlin/.openclaw/workspace/madmin-go/heal-commands.go cmd
grep -RIn "CheckParts\\|VerifyFile\\|bitrotVerify" cmd/erasure-healing-common.go cmd/xl-storage.go
grep -RIn "BitrotScanCycle\\|bitrotscan\\|MINIO_HEAL_BITROTSCAN" internal/config/heal

# mc full scan UI / admin heal scan mode
cd /Users/davidlin/.openclaw/workspace/mc
grep -RIn "Full bucket scan\\|Last full scan time\\|Est. full scan time" cmd/admin-scanner-status.go
grep -RIn "scanNormalMode\\|scanDeepMode\\|transformScanArg" cmd/admin-heal.go
```

## Source anchors

- MinIO `7aac2a2`
  - `cmd/data-scanner.go:89-107`：`getCycleScanMode()` 決定 normal/deep。
  - `cmd/data-scanner.go:155-218`：`runDataScanner()`、leader lock、`NSScanner()`、成功後 append `cycleCompleted`。
  - `cmd/erasure-server-pool.go:735-815`：跨 pools / sets 啟動 `erObj.nsScanner(...)`。
  - `cmd/data-scanner.go:307-370`：`scanDataFolder()` 建立 folder scanner。
  - `cmd/data-scanner.go:506-507`：object healing 抽樣與 bitrot flag。
  - `cmd/data-scanner.go:952-968`：scanner item 轉成 `HealObject(... ScanMode ...)`。
  - `cmd/erasure-healing-common.go:289-431`：normal/deep 差異，`CheckParts()` vs `VerifyFile()`。
  - `cmd/xl-storage.go:2363-2420`：normal scan 的 light part check。
  - `cmd/xl-storage.go:3082-3130`：deep scan 的 bitrot verify。
  - `internal/config/heal/heal.go:34-118`：`bitrotscan` config 與 default off。
- madmin-go
  - `heal-commands.go:36-62`：`HealNormalScan` / `HealDeepScan` 定義。
- mc `77f82e1`
  - `cmd/admin-scanner-status.go:143-180`：bucket full scan 顯示條件。
  - `cmd/admin-scanner-status.go:416-440`：overall full scan time / estimated full scan time。
  - `cmd/admin-heal.go:41-59`：`--scan normal/deep` flag。
  - `cmd/admin-heal.go:642-714`：`--scan deep` 轉成 `madmin.HealDeepScan`。

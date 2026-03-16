# Troubleshooting：MRF queue drop（partialOperation 被丟棄）

> 症狀：你知道「PutObject 成功但有洞」已經發生（或你看到 `addPartial` 路徑被走到），但後續 healing 沒有如預期追上；或是 heal 事件看起來「斷斷續續」。
>
> 在 MinIO 裡，這很可能不是 bug，而是 **MRF (Most Recently Failed) queue 是 best-effort**：queue 滿的時候會直接 drop 新的補洞事件。

本頁以 workspace 的 MinIO source tree 為準：`/home/ubuntu/clawd/minio`

---

## 1) Code anchor：MRF queue 是 non-blocking，滿了就 drop

- 檔案：`cmd/mrf.go`
- method：`func (m *mrfState) addPartialOp(op partialOperation)`

典型實作（節錄）：
```go
func (m *mrfState) addPartialOp(op partialOperation) {
    select {
    case m.opCh <- op:
    default:
    }
}
```

語意：
- `m.opCh` channel 有緩衝（buffered）
- **滿了就走 `default:`，直接丟棄**

因此：
- 「產生 partial」≠「一定會被補洞」
- 當 cluster 正在重度 I/O（healing/scanner/rebalance）時，MRF 的消費速度跟不上，很容易發生 drop

---

## 2) partialOperation 代表什麼？

- 檔案：`cmd/mrf.go`
- struct：`type partialOperation struct { ... }`

常見欄位（不同版本略有差異）：
- `bucket`, `object`
- `versionID`：單一版本
- `versions []byte`：多版本 disparity（一次帶多個 VersionID）
- `queued time.Time`
- `scanMode madmin.HealScanMode`

---

## 3) 事件從哪裡來？（PutObject → addPartial → MRF）

最常見來源是 PutObject quorum 過但寫入當下有 disk offline/timeout：

- 檔案：`cmd/erasure-object.go`
- `erasureObjects.putObject()` 在 `commitRenameDataDir()` 之後可能呼叫：
  - `er.addPartial(bucket, object, fi.VersionID)`
  - 或（versions disparity）直接 `globalMRFState.addPartialOp(partialOperation{ versions: versions, ... })`

---

## 4) 怎麼判斷「是 drop 還是 heal 太慢」？

你可以把現象先分兩類：

A) **heal 很忙、但仍持續在補**
- 你會看到 healing trace/metrics 持續輸出
- 只是 backlog 很大

B) **heal 看起來沒在跑／或明顯補不動**
- 同時間 I/O/CPU 很高
- 但 heal 事件量不成比例
- 這時就要把「MRF queue drop」納入考量

在沒有額外 instrumentation 的情況下，最實務的做法是：
- 用同一時間窗（T±5m）對齊：PutObject error/latency、disk offline/timeout、healing/scanner 活躍度
- 如果你能重現：在測試環境把 `addPartialOp` 的 `default:` 加 debug log（production 不建議）

---

## 5) 下一步（如果你要更系統化）

- 釐清 MRF consumer 的節流：`cmd/mrf.go: (*mrfState).healRoutine(...)`（dynamic sleeper）
- 釐清 healing 的 I/O 熱點：`readAllFileInfo()` / `erasure.Heal()` / `RenameData()`

延伸閱讀（同 repo）：
- `docs/trace/putobject-healing.md`
- `docs/trace/healing.md`
- `docs/troubleshooting/canceling-remote-connection.md`（MRF/healing 高負載常見共振）

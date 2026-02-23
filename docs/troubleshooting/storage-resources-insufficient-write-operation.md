# Error: Storage resources are insufficient for the write operation（InsufficientWriteQuorum）

你看到的錯誤：

> `Storage resources are insufficient for the write operation <bucket>/<object>`

同樣不是「空間不足」，而是 **Erasure Write 無法達成 write quorum**（可用 drives/節點不足、timeout/錯誤太多、或為了安全性拒絕繼續寫）。

---

## 1) Source code：錯誤型別與 API 映射

在 MinIO source tree：`cmd/object-api-errors.go`

```go
// InsufficientWriteQuorum storage cannot satisfy quorum for write operation.
type InsufficientWriteQuorum GenericError

func (e InsufficientWriteQuorum) Error() string {
    return "Storage resources are insufficient for the write operation " + e.Bucket + "/" + e.Object
}

func (e InsufficientWriteQuorum) Unwrap() error {
    return errErasureWriteQuorum
}
```

在 API 層會被映射成：
- `cmd/api-errors.go`：`case InsufficientWriteQuorum: apiErr = ErrSlowDownWrite`

也就是：對 client 端常會表現成 **寫入變慢/503/需要重試** 類型的錯誤（HTTP code/內容依 API 與版本而定）。

---

## 2) 典型原因（依實務常見度排序）

### A) Online drives 不足 / timeout 太多（最常見）
- 部分 disks timeout、I/O error、或節點間 RPC 不穩
- MinIO fan-out 寫入 shards 時，成功回應數不足以達成 write quorum

常見伴隨訊號：
- `i/o timeout`、`disk not found`、`connection refused`
- `canceling remote connection ... not seen for ...`（grid 心跳跟不上）
- node 上 `iostat -x` 顯示 await/util 飆高

### B) 觸發保護機制：read quorum 有問題時，某些寫入/刪除會「保守拒絕」
這點很容易誤解：有些操作在寫入前需要先讀出 metadata/狀態；如果 **read quorum 不成立**，MinIO 會為了安全性直接回 `InsufficientWriteQuorum`。

例子（刪除/ILM/過期相關路徑）：
- `cmd/erasure-object.go` 裡，在處理 deletePrefix / lifecycle expiration 時，如果 `getObjectInfoAndQuorum()` 回 `InsufficientReadQuorum`，就會：
  - 先 `er.addPartial(...)` 丟進 MRF queue，等待後續 healing
  - 然後回 `InsufficientWriteQuorum{}`（避免在狀態不明時繼續 destructive write）

這類情況下，你雖然看到的是 *write* quorum error，但根因常常是：
- **read quorum / metadata 讀取不穩**
- 或 healing/scanner/rebalance 把 I/O 壓力推高

### C) 檔案描述符（FD）耗盡 / 資源限制
- 當 FD/連線/goroutine 壓力太大，會導致大量 request 失敗（進而影響 quorum）
- 重啟 pod 會暫時好，屬於典型特徵

---

## 3) K8s StatefulSet：為什麼重啟 pod 會讓 write quorum error 暫時消失？

跟 read quorum 類似，重啟常見改善原因：
- TCP/HTTP 連線與 FD 狀態歸零
- goroutine 堆積/卡住的狀態被清掉
- PV mount / I/O path 重新初始化
- CNI/conntrack 狀態刷新

若你看到「固定某個 pod 反覆需要重啟」，強烈建議把焦點放在：
- 該 pod 所在 node 的磁碟延遲（iostat/dmesg）
- FD 上限與實際使用量
- 同時間窗是否有 healing/scanner/rebalance/mrf 在跑

---

## 4) 建議的排查 checklist（最短路徑）

1) **同時間窗**抓 pod log（前後 30-50 行）
   - 尋找 timeout / disk error / grid cancel / too many open files 等

2) **node 層**抓 I/O 與 kernel log
   - `iostat -x 1 5`
   - `dmesg -T | egrep -i 'timeout|reset|I/O error|nvme|blk'`

3) **背景任務**
   - healing/scanner/rebalance 是否正在跑？

4) **若是 replication/ILM 相關操作**
   - 注意：有些情境會把 *read quorum 問題* 表現成 *write quorum error*（安全性拒絕寫入/刪除）

---

## 5) 後續可以補強的讀碼方向

如果你想把這個錯誤追到更精準的「是哪個底層 error 造成 quorum 崩掉」，通常要把 log/trace 對到：
- 哪些 disks 被標記 offline（或回錯）
- 以及是哪個操作（PutObject/Delete/Replication/ILM/Heal）觸發

你如果願意貼：
- 一段出問題時間窗的 server log
- 以及當時在跑的操作類型（Put? Delete? Replication?）

我可以把這頁補成「常見 log pattern → 對應 root cause」的索引表。

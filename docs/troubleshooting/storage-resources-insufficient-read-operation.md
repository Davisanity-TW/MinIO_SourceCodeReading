# Error: Storage resources are insufficient for the read operation（InsufficientReadQuorum）

你在 MinIO log / S3 回應看到：

> `Storage resources are insufficient for the read operation <bucket>/<object>`

這不是「磁碟空間不足」的意思，而是：

- **Erasure Read 無法達成讀取 quorum**（可用 drives/節點不足、或回應超時/錯誤太多）
- 或 **quorum 內的 metadata 不一致**（`xl.meta`/FileInfo 無法取得足夠一致的版本）

在 K8s（StatefulSet）環境常見現象是：
- 某個 pod 開始大量噴這個錯誤
- **重啟該 pod 後錯誤消失**

這篇把「錯誤在原始碼中的真正語意」與「為什麼重啟能暫時緩解」整理成可排查的 checklist。

---

## 1) Source code：錯誤型別與字串在哪裡？

在 MinIO source tree：`cmd/object-api-errors.go` 定義了錯誤型別。

```go
// InsufficientReadQuorum storage cannot satisfy quorum for read operation.
type InsufficientReadQuorum struct {
    Bucket string
    Object string
    Err    error
    Type   RQErrType
}

func (e InsufficientReadQuorum) Error() string {
    return "Storage resources are insufficient for the read operation " + e.Bucket + "/" + e.Object
}
```

它會被映射成 S3 API error：
- `cmd/api-errors.go`：`case InsufficientReadQuorum: apiErr = ErrSlowDownRead`

也就是：對 client 端常會表現成 **讀取變慢/503/需要重試** 的那一類錯誤（具體 HTTP code/內容取決於你呼叫的 API 與版本）。

---

## 2) 真正的語意：不是「空間不足」，是「讀取 quorum 不足 / 不一致」

`InsufficientReadQuorum` 內部有 `Type RQErrType`，用來區分大方向（不同版本可能略有調整，但概念一致）：

- `RQInsufficientOnlineDrives`
  - **線上的 drives 不夠**、或可用結果太少（例如多顆 disk timeout / error）
- `RQInconsistentMeta`
  - drives 看起來在線，但**讀到的 metadata/版本無法在 quorum 內形成一致**

### 2.1 `RQInsufficientOnlineDrives`：連 quorum 基礎都湊不齊

在 `cmd/erasure-metadata.go`（`findFileInfoInQuorum(...)`）中：

```go
if quorum < 1 {
    return FileInfo{}, InsufficientReadQuorum{Err: errErasureReadQuorum, Type: RQInsufficientOnlineDrives}
}
```

這代表：在呼叫鏈更上層（通常是 fan-out 去各個 disks/節點讀 `xl.meta`）時，**可用結果已經少到連 quorum 都算不出來**。

### 2.2 `RQInconsistentMeta`：結果夠多，但彼此對不上

同一個函式會對每顆 disk 回來的 `FileInfo` 計算 hash，統計「最大一致群」的數量；如果最大群仍然 `< quorum`，就回：

```go
if maxCount < quorum {
    return FileInfo{}, InsufficientReadQuorum{Err: errErasureReadQuorum, Type: RQInconsistentMeta}
}
```

這類常見於：
- 正在 healing/rebalance/scanner，短時間內版本/狀態轉換頻繁
- 部分磁碟有落後/損壞的 `xl.meta`
- 部分磁碟回來的資料其實是 stale/錯誤（但沒有明確 I/O error，而是回了「看起來 valid 但內容不同」）

---

## 3) 為什麼 K8s StatefulSet 裡「重啟 pod」常常會讓它暫時好？

重啟 pod 會做幾件很關鍵的「狀態重置」，因此很多 **暫時性** 的 quorum 問題會瞬間消失：

### 3.1 連線/檔案描述符（FD）/goroutine 狀態歸零

如果根因是：
- 連線大量堆積
- hit 到 `ulimit -n`（Too many open files）
- 某些 goroutine 長期卡住（disk I/O 或 internal RPC）

那麼一旦重啟，這些狀態會全部清掉，短期內就不再大量 timeout → drives 不會被判成 offline → read quorum 恢復。

> **重要提醒**：這種「重啟就好」常常表示 **症狀被 reset**，但底層原因（網路抖動、磁碟延遲、資源限制）仍在。

### 3.2 PV/檔案系統重新初始化（mount/IO path reset）

若底層磁碟或檔案系統有：
- 偶發 I/O timeout
- queue depth 飆高
- filesystem 卡住/回復

重啟 pod 後往往會重新 mount、重建 I/O path（依 CSI/driver 實作而定），也可能讓症狀暫時解除。

### 3.3 K8s 網路/iptables/conntrack 狀態刷新

如果問題在：
- pod 所在 node 的 conntrack 壓力
- overlay network（CNI）路徑抖動
- 中間設備 idle timeout / NAT

重啟 pod 會重建 TCP 連線與連線表狀態，也可能讓短期錯誤消失。

---

## 4) 你這種規模（多 pool、多節點）特別要注意什麼？

你的拓撲是：
- 多 pool
- 每個 pool 約 12 節點
- 總共約 10 個 pool（總節點數很大）

在這種規模，**單一 pod 出現大量 InsufficientReadQuorum** 通常代表：

1) **該 pod 自身的資源或 I/O 路徑出問題**（最常見）
   - 因為如果是全域/廣泛性問題，往往會擴散到多個 pod 同時發生。

2) 該 pod 所在 node/network segment 有問題
   - 例如：那台 node 的 disk latency 飆高、NIC errors、CNI MTU mismatch、conntrack 壓力。

3) healing/scanner/rebalance 在同一時間窗把系統推到邊界
   - 大型叢集背景工作造成的瞬間 fan-out、或磁碟/網路壓力尖峰，更容易觸發 quorum error。

---

## 5) 最有效的排查流程（把根因從「quorum error」落到「是哪一層」）

> 目標：判斷你遇到的是「OnlineDrives 不足」還是「Meta 不一致」，再往下追到 OS/網路/磁碟/背景任務。

### 5.1 先把「是哪一台 pod」與「時間窗」釘住

- 哪個 pool / 哪個 pod（hostname / pod name）
- 發生時間（至少 ±5 分鐘）
- 是否只發生在單一 pod？還是同 pool 多台？

### 5.2 同時間窗收集 3 類關鍵訊號（最便宜但最有用）

#### A) MinIO log（同 pod）
找這些關鍵字：
- `i/o timeout`
- `disk not found`
- `connection refused`
- `too many open files`
- `canceling remote connection`（grid inter-node RPC 心跳跟不上）

這些訊號常常會出現在 `InsufficientReadQuorum` 前後，直接指出是「disk I/O」還是「網路/RPC」。

#### B) Node/Pod 資源與 I/O
在出問題的 node 上看：
- `iostat -x 1 5`（await、util、queue depth）
- `dmesg -T | egrep -i 'timeout|reset|I/O error|nvme|blk'`（kernel I/O 問題）
- `ulimit -n` / `lsof | wc -l`（FD 是否爆掉）

#### C) 背景任務：healing/scanner/rebalance 是否正在跑？
背景任務很容易把 I/O 推高，讓 quorum fan-out 更常 timeout。

- healing 相關 trace（若有）
- 或用 `mc admin` 觀察 healing / drive 狀態（依你環境的 admin 存取方式）

### 5.3 如果你常同時看到 `canceling remote connection ... not seen for ...`
這代表 MinIO 內部的 **grid streaming mux** 心跳跟不上（不是 S3 client 端的錯誤本體）。

在 source code 中：
- `minio/internal/grid/muxserver.go`
  - `lastPingThreshold = 4 * clientPingInterval`（約 ~60s）
  - 超過閾值會印：`canceling remote connection ... not seen for ...`

如果同時出現：
- quorum error
- grid cancel
- disk latency 尖峰

那通常方向是：**資源/I/O 壓力 → handler 排隊/timeout → drives 被視為 offline → quorum 不足**。

---

## 6) 你貼的 replication log：為什麼會出現在「unable to replicate」？

你看到的 log：

```
unable to replicate to target http://storage-fz6.s3.fab.tsmc.com:9000 for mep-iqm/FAB18/MetaRecord/QC.csv(<version>):
Storage resources are insufficient for the read operation mep-iqm/FAB18/MetaRecord/QC.csv (*fmt.wrapError)
```

這段訊息在 source code 裡出現在：`cmd/bucket-replication.go`。

在 replication worker 裡，它會先用本地的 `objectAPI.GetObjectNInfo(...)` 取得要複製的 object reader：

```go
gr, err := objectAPI.GetObjectNInfo(... ObjectOptions{ReplicationRequest: true, VersionID: ri.VersionID, ...})
if err != nil {
    replLogIf(ctx, fmt.Errorf("unable to replicate to target %s for %s/%s(%s): %w", tgt.EndpointURL(), bucket, object, objInfo.VersionID, err))
    return
}
```

所以你看到的「unable to replicate」其實是在說：
- **replication 在「讀本地 object」這一步就失敗了**（還沒開始把資料 PUT 到 target）
- 根因是本地讀取時 hit 到 `InsufficientReadQuorum`（read quorum 不成立/metadata 不一致）

換句話說，這種 replication log 的診斷方向，應該先回到「本地叢集為什麼讀不到 quorum」：
- disk I/O / timeout
- inter-node RPC / grid cancel
- healing/scanner/rebalance 壓力
- 或特定 node/pod 資源耗盡

---

## 7) 建議的「永久修復」方向（比一直重啟更重要）

如果你已確認「重啟 pod 就會好」，我會建議優先做：

1) **把該 pod 的資源限制/requests 檢查一次**
   - CPU / memory 是否太緊（GC/排程壓力會反映在 RPC/磁碟延遲）

2) **確認檔案描述符上限（ulimit -n）與實際 FD 使用量**
   - 如果 hit `too many open files`，根因是資源上限，不是 MinIO data 本身。

3) **把「固定出問題的 node」標記出來**
   - 如果永遠是同一台 node 上的 pod 出現大量 quorum error，極可能是 node 的磁碟/網路/driver 問題。

4) **對照背景任務時段**（healing/scanner/rebalance）
   - 若錯誤集中在這些時段，需把瓶頸對準 I/O（磁碟 latency）與背景任務的壓力管理。

---

## 7) 你接下來可以提供我兩段資訊，我就能把「你的現場」補成更具體的原因推定

1) 出問題 pod 在錯誤爆發時的 log（前後 30~50 行）
2) 出問題 pod 所在 node 的 `iostat -x 1 5`（或至少一次快照）

拿到後，我可以在本頁追加「判讀例」：
- 哪些 log pattern 對應到 `RQInsufficientOnlineDrives`
- 哪些 pattern 更像 `RQInconsistentMeta`
- 以及在多 pool/多節點情境下，如何判斷是 node 問題、網路 segment 問題、還是 background pressure。

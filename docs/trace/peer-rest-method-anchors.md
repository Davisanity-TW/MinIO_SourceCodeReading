# Trace：peer-rest（grid RPC）方法常數與 client 初始化/快取 錨點

> 目標：在排查 `canceling remote connection` / grid peer RPC timeout 時，能快速把 internal trace 看到的 handler/method 對回 source：
> - peer REST method 常數（server 端會註冊哪些路由/handler）
> - client 端是怎麼建構 URL/簽名/重試
> - peer REST client 是否有全域 cache（連線/transport 重用）
>
> 注意：不同 RELEASE tag 之間檔案可能搬家/改名；本頁**以函式簽名 + 常數名**做錨點，避免依賴行號。

---

## 1) peer REST method 常數（先把「method 名稱」釘死）

常見 pattern 是：
- `const peerRESTMethodX = "..."`
- 或 `type peerRESTMethod string`
- 然後 server/client 共用這些常數來決定 handler/URL path。

在你要對照的 MinIO source tree：

```bash
cd /path/to/minio

# 先找 peer-rest 相關檔案（不同版本可能在 cmd/ 或 internal/）
find . -maxdepth 4 -type f \( -name '*peer*rest*' -o -name '*peerrest*' \) | sort

# 直接抓 method 常數
grep -RIn "peerRESTMethod" -n cmd internal | head -n 200

# 常見是 const 區塊
grep -RIn "^const (" -n cmd internal | grep -n "peerREST" | head -n 80
```

你要在 incident note 記下的最小資訊：
- method 常數名稱（例如 `peerRESTMethodHealObject`）
- 對應的字串值（例如 `"heal-object"`）
- 這個 method 的 server handler 實作位置（下一節）

---

## 2) server 端：peer REST handler 註冊點（method → handler）

server 端通常會在某個 `registerPeerRESTHandlers()` / `registerPeerREST*()` 的地方，把 method 對到 handler。

```bash
cd /path/to/minio

# 釘死「註冊 handler」的入口
grep -RIn "registerPeer" -n cmd internal | head -n 120

# 釘死 router/mux 掛 handler 的位置
grep -RIn "peer.*REST" -n cmd internal | head -n 200

# 直接找特定 method 常數被用在哪裡（用你上一節找到的常數名取代）
# 例如：peerRESTMethodHealObject / peerRESTMethodBackgroundHealStatus
grep -RIn "peerRESTMethod" -n cmd internal | head -n 200
```

實務上你會想追到：
- handler 是否走 streaming mux（長連線）
- handler 內是否會觸發 healing/scanner/renameData/RenameData 等 I/O-heavy 操作

---

## 3) client 端：peer REST client 建構點（URL/transport/cache）

排查 `canceling remote connection` 時，常見困惑是：
- 這個 peer RPC 是「短連線」還是「長 streaming」？
- client transport 是否共用（是否有全域 cache/單例）？
- timeout/deadline 在哪裡設定？（有沒有太長導致啟動 server watchdog）

用下面這組 grep 把 client 建構釘死：

```bash
cd /path/to/minio

# 找 client 的 type / 建構函式（常見：newPeerRESTClient / getPeerRESTClient 等）
grep -RIn "type .*peer.*REST.*Client" -n cmd internal | head -n 120
grep -RIn "new.*peer.*REST.*Client" -n cmd internal | head -n 120

# 找 cache（map / sync.Map / global 變數）
grep -RIn "peer.*REST.*cache|peer.*REST.*clients|sync\.Map" -n cmd internal | head -n 200

# 找 transport / http client 設定（TLS、IdleConn、KeepAlive、Timeout）
grep -RIn "Transport\:|http\.Transport|IdleConn|KeepAlive|TLSClientConfig|DialContext" -n cmd internal | head -n 200

# 找 request 的 deadline/timeout 設定
grep -RIn "context\.WithTimeout|context\.WithDeadline" -n cmd internal | grep -i "peer" | head -n 200
```

---

## 4) 把 peer REST 與 `canceling remote connection` 串起來（判讀提示）

### 4.1 streaming mux watchdog 的語意
如果 peer REST handler 走 grid streaming mux（MuxID != 0），server 端會有 watchdog：
- ~60s 沒看到對端 ping（LastPing 沒更新）就會印：`canceling remote connection ... not seen for ...`

因此你在現場要做的不是只問「網路掉包嗎？」而是同步問：
- 這條 peer REST handler 是否在做 I/O-heavy（RenameData/healObject/scan）導致 goroutine 飢餓？
- node 是否有 CPU throttling / GC pause / syscall block 造成 ping handler 來不及跑？

### 4.2 最短交叉驗證
- 同時間窗是否有 Healing/MRF/scanner/rebalance 事件？
- goroutine dump 是否常見 `(*xlStorage).RenameData` / `fdatasync` / `xfs_*` / `ext4_*`？
- `ss -ti` 是否顯示 retrans/RTO 異常？（偏網路）

延伸閱讀：
- `docs/troubleshooting/canceling-remote-connection-codepath.md`
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`
- `docs/trace/putobject-healing.md`
- `docs/trace/peer-rest-healing.md`

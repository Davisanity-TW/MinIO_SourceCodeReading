# Trace：PutObject（HTTP handler → ObjectLayer.PutObject → erasureObjects.putObject）實際檔案/函式呼叫鏈

> 目的：incident 現場看到 `PUT /bucket/object` latency / stackdump / pprof 時，能從 **HTTP handler** 一路釘到 **erasure 寫入 + rename/commit** 的實際函式與檔案。
>
> 這頁刻意只放「跨版本比較穩」的 **signature + grep anchors**；行號會漂移，建議每次都用 grep 重新定位。


## TL;DR（最短 6 跳）

1. `PutObjectHandler()`（HTTP）
2. 依 API router/mux 進到 object handler（一般 PUT / multipart / copy 會有不同分支）
3. `ObjectLayer.PutObject(...)`（介面）
4. pool/set/object 逐層 dispatch（multi-pool / multi-set）
5. `(*erasureObjects).putObject(...)`（主流程）
6. `.minio.sys/tmp` 寫入 → `renameData()` → `commitRenameDataDir()`（原子可見性切換 + 可能產生 partial → MRF）


## 1) HTTP handler：PutObjectHandler

最穩的入口 anchor：

```bash
git grep -n "func (.*) PutObjectHandler" -- cmd
# 常見落點：cmd/object-handlers.go
```

你會在 handler 內看到常見的前置 pipeline（版本差異很大，但關鍵字通常類似）：

- auth/permission：`isPutActionAllowed` / `checkRequestAuthTypeCredential`
- metadata：`extractMetadata` / `setPutObjHeaders`
- quota / policy：`enforceBucketQuota` / `isPutActionAllowed`
- reader：`NewPutObjReader` / `hash.NewReader` / chunked reader
- options：`putOptsFromReq` / `ObjectOptions{...}`

定位這些前置點的 grep anchors：

```bash
git grep -n "NewPutObjReader" -- cmd
git grep -n "putOptsFromReq" -- cmd
git grep -n "extractMetadata" -- cmd
```


## 2) ObjectLayer.PutObject：從 handler 進到底層

ObjectLayer 介面通常在這類檔案：

```bash
git grep -n "type ObjectLayer interface" -- cmd
git grep -n "PutObject(.*ObjectOptions" -- cmd
```

handler 會拿到 `ObjectAPI`（或類似命名）並呼叫 `PutObject(...)`。


## 3) pool / set / objects：多層 dispatch（multi-pool 時特別重要）

用關鍵字快速鎖定「選 pool / set」：

```bash
git grep -n "getPoolIdx" -- cmd
git grep -n "erasureServerPools" -- cmd
git grep -n "erasureSets" -- cmd
```

常見會看到：

- `(*erasureServerPools).PutObject(...)`
- `(*erasureSets).PutObject(...)`
- `(*erasureObjects).PutObject(...)`（wrapper）

這些 wrapper 最終會落到 `(*erasureObjects).putObject(...)`。


## 4) erasureObjects.putObject：真正的寫入主流程

最穩 anchor：

```bash
git grep -n "func (.*\\*erasureObjects\\) putObject" -- cmd
# 常見落點：cmd/erasure-object.go
```

### 寫入到 `.minio.sys/tmp` 的關鍵 anchor

```bash
git grep -n "\\.minio\\.sys/tmp" -- cmd
git grep -n "newBitrotWriter" -- cmd
git grep -n "Encode(" -- cmd | head
```

你通常會看到類似：

- 建立 bitrot writer / erasure encoder
- 把資料寫到 tmp 目錄（分散到多盤）
- 完成後進入 rename/commit


## 5) rename/commit：renameData / commitRenameDataDir

這兩個是 PutObject latency 常見熱點（尤其搭配 fsync/metadata-heavy FS）。

```bash
git grep -n "func renameData" -- cmd
git grep -n "func commitRenameDataDir" -- cmd
```

### 為什麼這裡常跟 Healing / `canceling remote connection` 共振

- PutObject 在 rename/commit 階段會做大量 metadata 操作（rename、mkdir、可能 fsync）。
- 若底層磁碟 tail latency 飆高，handler/背景 goroutine 可能被拖慢。
- grid streaming mux 的 ping/pong handler 若被拖慢，會更容易看到 `canceling remote connection`（尤其是同時間窗 healing/MRF 也在打 `RenameData()`）。

延伸：

- `docs/trace/putobject-healing-callchain.md`
- `docs/troubleshooting/canceling-remote-connection-quick-triage.md`


## 6) partial → MRF（Most Recently Failed）補洞：PutObject 成功但留下洞的來源

PutObject 即使成功（client 看起來 OK），仍可能因為部分 disk offline/timeout 留下 partial（缺片）。
這會進入 MRF queue，後續由 background routine 觸發 `HealObject()`。

建議從以下 anchors 把 partial/MRF 的寫入點釘死：

```bash
git grep -n "addPartial" -- cmd
git grep -n "globalMRFState" -- cmd
git grep -n "healRoutine" -- cmd
```


## 快速一鍵 grep pack（複製貼上）

```bash
(
  echo "### PutObject handler";
  git grep -n "PutObjectHandler" -- cmd;
  echo;
  echo "### ObjectLayer.PutObject interface";
  git grep -n "type ObjectLayer interface" -- cmd;
  git grep -n "PutObject(.*ObjectOptions" -- cmd;
  echo;
  echo "### erasure dispatch";
  git grep -n "erasureServerPools.*PutObject" -- cmd;
  git grep -n "erasureSets.*PutObject" -- cmd;
  echo;
  echo "### erasureObjects.putObject";
  git grep -n "func (.*\\*erasureObjects\\) putObject" -- cmd;
  echo;
  echo "### rename/commit";
  git grep -n "func renameData" -- cmd;
  git grep -n "func commitRenameDataDir" -- cmd;
) | sed -n '1,200p'
```


## Notes / caveats

- 不同 RELEASE tag 的命名會有差異（例如 wrapper 層級、options struct 欄位）；建議用 signature grep，而不是靠行號或固定檔名。
- 若你已經有現場 stack（SIGQUIT/pprof），可以反過來用 stack 上的 function name 當 grep anchor，通常更快。

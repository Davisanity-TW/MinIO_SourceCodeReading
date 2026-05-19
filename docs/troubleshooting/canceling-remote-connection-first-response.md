# `canceling remote connection` — First response (1-page)

> Goal: when you see MinIO log line like `canceling remote connection`, quickly narrow down **(a) which RPC path** (grid/peer-rest/heal) and **(b) whether it is a symptom of IO/CPU pressure** (most common), then collect the minimum artifacts to confirm.

This page intentionally overlaps other deep-dive notes, but is optimized for **first 10 minutes**.

---

## What this message usually means (mental model)

In MinIO, a **server-side goroutine decides to cancel/close** an established remote connection because the request is no longer useful or the server is under pressure/timeouts.

Common root buckets:

1) **Downstream is slow**
- disk IO latency (rename/fsync), erasure read/write stalls
- healing (MRF / background heal) contention

2) **Upstream gave up**
- client or peer canceled context / deadline exceeded
- load balancer / network middlebox closed the connection

3) **Internal queue/backpressure**
- grid RPC stream cannot be served fast enough
- goroutine pileup -> cascading timeouts

In practice, (1) is the #1: **tail latency spikes** on disks during heavy PutObject + healing.

---

## Triage decision tree (fast)

### Step 0 — correlate timeframe
- confirm the time window (±5 min)
- check if it clusters around: **healing bursts**, **PutObject spikes**, or **node CPU steal / throttling**

### Step 1 — identify which subsystem emitted it
Look around the log line for tags / surrounding messages:

- If you see **grid / peer RPC** adjacent:
  - go: `docs/trace/grid-canceling-remote-connection.md`
  - go: `docs/troubleshooting/grid-peer-rpc-timeouts.md`

- If you see **healing** adjacent (mrf/heal):
  - go: `docs/trace/healing.md`
  - go: `docs/trace/peer-rest-healing.md`

- If you see **PutObject** latency symptoms around the same time:
  - go: `docs/trace/putobject-handler-to-erasure-putobject.md`
  - go: `docs/trace/putobject-healing-real-functions.md`

### Step 2 — decide: network vs resource pressure
**Network-ish signals**
- only one peer pair affected
- errors like `connection reset by peer`, TLS alerts, LB resets

**Resource-pressure signals** (most common)
- multiple nodes show it within the same minute
- p99 PutObject / GET latency jumps
- `iowait` rises, disk queue depth rises
- goroutines increase rapidly

---

## Minimum artifacts to collect (copy/paste list)

### A) MinIO logs
- 50–200 lines around the first occurrence per node
- include node name + timestamp

### B) CPU / IO quick snapshot
On each affected node (Linux):

```bash
# 1) CPU / run queue
uptime
mpstat -P ALL 1 5

# 2) IO latency / saturation
iostat -x 1 5

# 3) Process-level IO hints
pidstat -d 1 5
```

### C) If goroutine pile-up suspected (very useful)

```bash
# if you have pprof enabled:
# curl -s http://127.0.0.1:9000/debug/pprof/goroutine?debug=2 | head

# or SIGQUIT stack dump (if you run MinIO under systemd, check journalctl after)
kill -QUIT $(pidof minio)
```

Then jump to:
- `docs/troubleshooting/canceling-remote-connection-sigquit-stackdump.md`
- `docs/troubleshooting/canceling-remote-connection-pprof-goroutine-playbook.md`

---

## “PutObject + Healing” hotspot checklist (most common path)

If you suspect it is triggered by **PutObject + healing contention**, verify:

- healing queue pressure
  - MRF queue size / processing rate (if exposed)
- disk tail latency
  - rename/fsync stalls (common for XFS/ext4 under pressure)
- erasure write paths
  - small objects -> metadata churn

Suggested reading (call-chain oriented):
- `docs/trace/putobject-healing-actual-callchain-map.md`
- `docs/trace/putobject-healing-callchain-verified-b413ff9fd.md`
- `docs/trace/putobject-rename-fsync-actual-functions.md`

---

## Stop conditions (when you can move on)

You can leave “first response” mode once you can answer:

1) Which subsystem produced the message? (grid / peer-rest / healing)
2) Is the dominant signal network or resource pressure?
3) What is the strongest correlated metric? (iowait / p99 latency / goroutines / queue depth)

Then continue with the deep-dive pages linked above.

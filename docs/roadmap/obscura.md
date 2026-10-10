> **STATUS: unverified third-party analysis, NOT a decision document.** Added by the owner 2026-10-03;
> it is ChatGPT output pasted wholesale, kept for reference.
>
> **It is right where it matters.** Checked against upstream the same day: `obscura serve --port 9222`
> is real (`CMD` in obscura's own Dockerfile, and `main.rs:910` prints `obscura serve --stealth`); the
> **worker model is real** — every release tarball ships both `obscura` *and* `obscura-worker`; sticky
> sessions and `--storage-dir` persistence are consistent with a CDP server holding page state.
>
> **It is wrong on its sourcing.** It cites `github.com/alksnd/obscura`. webrain installs from
> **`github.com/h4ckf0r0day/obscura`** — that literal URL is in `webrain-core/src/install.rs`. Treat any
> claim sourced to the other repo as unverified.
>
> **It omits the thing that actually bit us.** Obscura's Linux binaries are built
> `x86_64-unknown-linux-gnu` on Ubuntu 22.04, so they need **glibc ≥ 2.35**; upstream runs them on
> `distroless/cc-debian12`. None of the 1,200 lines below mention this, and it silently breaks any
> Alpine-based worker — including the one this project had already written.
>
> **Every number in the capacity model is an assumption, not a measurement.** `Concurrency = peak
> jobs/sec × average job duration` is a sound *template*; the inputs are invented. The benchmark matrix
> in section 8 is the useful part, because it says what to measure before trusting any of the rest.
>
> Where this file and `06-browser-sourcing-options.md` disagree, **`06` wins**. For the facts that were
> actually verified, see `.github/skills/browser-platform-skill/references/ground-truth.md`.

Yes — but **a lot of that architecture is generic Chrome-at-scale advice and is wrong or unnecessarily heavy for Obscura**.

I checked the current Obscura repository/docs. The important difference is that **Obscura is already designed around a lightweight Rust/V8 browser process with multiple worker processes and CDP**, rather than the traditional “one heavy Chromium per job” model. ([GitHub][1])

## The biggest correction

The statement:

> “1 million users → Kubernetes is mandatory → 50–100 Playwright contexts per browser”

is **not a sound architecture requirement**.

For your Webrain-style system, the real scaling variable is:

**browser jobs × job duration × peak concurrency × memory/CPU per page**

—not registered users.

1M monthly users could mean only a few hundred simultaneous browser jobs, or hundreds of thousands. Those are radically different systems.

Also, “10 concurrent users per second” mixes two different concepts. You want to measure **RPS/job throughput** and **active browser sessions**.

---

# What Obscura actually gives you

The current Obscura architecture is:

```text
                    Internet
                       │
                 API / Gateway
                       │
                Scheduler / Queue
                       │
          ┌────────────┴────────────┐
          │                         │
      Obscura Node A           Obscura Node B
          │                         │
   ┌──────┼──────┐            ┌──────┼──────┐
 worker  worker  worker      worker  worker  worker
    │       │       │           │       │       │
 pages   pages   pages        pages   pages   pages
```

Obscura's own production guide explicitly supports:

```bash
obscura serve --workers N
```

and says to use roughly **one worker per CPU core**, with sessions sticky to a worker. ([GitHub][2])

The architecture documentation says long-running navigation/evaluation work is dispatched asynchronously so the CDP server can continue handling other sessions. ([GitHub][3])

So the basic unit you should scale is:

**Obscura worker/node**, not “Chrome browser instance”.

---

# And there is an important catch with contexts

I would **not blindly implement 100 contexts per Obscura process**.

Obscura's Playwright documentation explicitly says:

> Multiple pages share one V8 isolate.

and CPU-bound JavaScript on one page can block the others. ([GitHub][4])

That's a very important difference from the simplified advice you pasted.

So this:

```text
1 browser
 ├─ context 1
 ├─ context 2
 ├─ ...
 └─ context 100
```

is **not automatically good scaling**.

You need to benchmark:

```text
1 worker
5 active pages
10 active pages
20 active pages
40 active pages
...
```

and determine where:

* CPU saturation occurs
* memory grows
* p95 navigation latency explodes
* V8 contention appears
* one pathological SPA hurts neighboring sessions

Then set your concurrency limit.

---

# Obscura is much lighter than Chromium

The current project README reports approximately:

|            | Obscura | Headless Chrome |
| ---------- | ------: | --------------: |
| Memory     |  ~30 MB |         200+ MB |
| Binary     | ~70 MiB |         300+ MB |
| Startup    | instant |            ~2 s |
| JavaScript |      V8 |              V8 |
| CDP        |     yes |             yes |
| Playwright |     yes |             yes |

Those are **Obscura's own benchmark/marketing figures**, so treat them as starting measurements rather than capacity guarantees. ([GitHub][5])

This changes the economics considerably.

You don't need to assume:

> “every browser job costs a full Chromium process.”

---

# Your architecture should look more like this

For **Webrain**, I would build:

```text
                        ┌──────────────────┐
                        │     Webrain API  │
                        │   Auth / Billing  │
                        └────────┬─────────┘
                                 │
                         ┌───────▼────────┐
                         │ Job Scheduler  │
                         │ Session Router │
                         └───────┬────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Queue / Event Bus       │
                    │ Redis Streams / NATS     │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
   Obscura Fleet A       Obscura Fleet B       Obscura Fleet C
     4–8 CPU                4–8 CPU                4–8 CPU
        │                      │                      │
   ┌────┼────┐            ┌────┼────┐            ┌────┼────┐
   W1   W2   W3            W1   W2   W3            W1   W2   W3
   │    │    │             │    │    │             │    │    │
 pages pages pages        pages pages pages        pages pages pages
```

Then separately:

```text
Session metadata
      │
      ▼
Redis / Postgres
      │
      ├── session → node
      ├── session → worker
      ├── proxy assignment
      └── task state
```

That is much more important than Kubernetes.

---

# The really important problem: session affinity

Obscura supports persistent cookies/localStorage through `--storage-dir`. ([GitHub][3])

That means you cannot casually do:

```text
request 1 → node A
request 2 → node F
request 3 → node C
```

for a long-lived authenticated browser session.

You need something like:

```text
session_9281
     ↓
worker/node A
     ↓
Obscura
     ↓
cookies + localStorage + page state
```

Your scheduler remembers that assignment.

For Webrain this is **critical**, because your agent model includes persistent browser sessions.

And Obscura's Playwright `storageState` support still has limitations; its documentation recommends `--storage-dir` for persistence instead. ([GitHub][4])

So I would explicitly divide workloads into two types.

### Stateless jobs

Examples:

```text
fetch URL
scrape URL
extract page
crawl page
summarize page
```

These should be:

```text
queue → any available Obscura worker → execute → destroy
```

Extremely scalable.

### Stateful agent sessions

Examples:

```text
logged-in browser
shopping session
CMS session
dashboard interaction
multi-step workflow
```

These need:

```text
session_id
   ↓
session router
   ↓
sticky worker
   ↓
Obscura process
```

That's the difficult part.

---

# Kubernetes is NOT mandatory

This is probably the biggest piece of bad advice in the text you pasted.

You don't need:

```text
1M users
   ↓
Kubernetes
```

You need:

```text
queue depth
active sessions
CPU
RAM
latency
error rate
```

and a mechanism that adds/removes Obscura nodes.

You can start with:

```text
Docker
+
VMs
+
load balancer
+
Redis
```

and horizontally add Obscura nodes.

Obscura's official production documentation itself describes Docker/systemd deployment and multiple workers; it does **not** say Kubernetes is required. ([GitHub][2])

For your current stage, jumping directly to Kubernetes would probably be overengineering.

---

# What I would do for Webrain

### Stage 1 — development

```text
Webrain API
   ↓
Redis
   ↓
1 Obscura server
   ↓
2–4 workers
```

Something like:

```bash
obscura serve \
  --workers 4 \
  --stealth \
  --storage-dir /data
```

The exact worker count should be benchmarked rather than assumed. Obscura recommends roughly one worker per CPU core. ([GitHub][2])

---

### Stage 2 — production

```text
             Load Balancer
                    │
             Webrain API
                    │
                  Redis
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
    Obscura-1   Obscura-2   Obscura-3
      4 cores     4 cores     4 cores
        │           │           │
       W×4         W×4         W×4
```

Each node:

```text
Docker
  └── obscura serve --workers 4
```

Then scale **nodes horizontally**.

---

### Stage 3 — large fleet

Only when you actually have enough traffic to justify it:

```text
                Global API
                    │
             Global Scheduler
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
     EU fleet     US fleet     ASIA fleet
       │            │            │
    Obscura       Obscura       Obscura
    cluster       cluster       cluster
```

At that point Kubernetes becomes useful because you now have a real fleet-management problem.

Not because the number “1 million users” magically requires Kubernetes.

---

# Queue-based architecture matters more than K8s

For your system I would use a queue between the API and browser workers.

Something like:

```text
POST /agent/run
       │
       ▼
   Scheduler
       │
       ▼
Redis Streams / NATS
       │
       ▼
Obscura worker
       │
       ├── navigate
       ├── interact
       ├── extract
       └── result
```

This gives you:

* backpressure
* retry
* cancellation
* quotas
* concurrency control
* priority queues
* tenant isolation
* autoscaling signals

That is the real foundation of a million-user system.

---

# Don't use "one browser context = one user" blindly

For Webrain I'd use three levels:

```text
Tenant
  ↓
Browser Session
  ↓
Context
  ↓
Page(s)
```

But the relationship depends on the workload.

For example:

```text
User
 └── Agent Session
      └── Browser context
           ├── page
           └── page
```

rather than:

```text
1 user = 1 permanent browser
```

A huge number of permanently alive sessions would be a resource leak disguised as architecture.

---

# Obscura also removes a major assumption from the original design

The original recommendation says:

> GPU-enabled VMs if doing heavy rendering.

That's not something I'd assume for Webrain.

Obscura is a Rust/V8 browser engine and now has its own rendering engine; it does not require Chromium to perform rendering. ([GitHub][5])

For your scraping/agent workload, I'd start CPU-only.

Only add GPU infrastructure after actual profiling proves that your workload benefits from it.

---

# Proxy architecture

This part of the original text is also too simplistic.

Don't build:

```text
every request
    ↓
random residential IP
```

as your default.

For Webrain you want:

```text
Target
  ↓
Proxy policy
  ├── direct
  ├── datacenter
  ├── ISP
  ├── residential
  └── mobile
```

because many sites don't require expensive residential traffic.

And Obscura already has proxy configuration plus a stealth transport/fingerprinting layer. ([GitHub][1])

That doesn't mean “undetectable”; it means the browser has mechanisms specifically intended for automation traffic. Detection resistance should still be measured target-by-target.

---

# One thing the original answer gets absolutely right

You **must not** expose Obscura's CDP port directly to the Internet.

Obscura's production documentation warns that CDP has no built-in authorization in the basic architecture and recommends binding locally or putting it behind authenticated infrastructure/network isolation. ([GitHub][2])

Your production topology should therefore be:

```text
Internet
   │
   ▼
Webrain API
   │
   ▼
private network
   │
   ▼
Obscura
```

not:

```text
Internet
   │
   ▼
:9222
   │
   ▼
Obscura
```

The current README also shows a CDP token mechanism in Docker, which is another useful security layer. ([GitHub][5])

---

# What “1 million users” should mean for your capacity planning

This is the equation I'd use:

```text
Peak concurrent browser jobs
    =
Peak jobs/sec
×
Average browser-job duration
```

Example:

```text
1,000,000 monthly users

2 browser jobs/user/month
= 2,000,000 jobs/month

≈ 0.77 jobs/sec average
```

Suppose your peak is 10× average:

```text
≈ 7.7 jobs/sec peak
```

and each job averages 15 seconds:

```text
7.7 × 15
≈ 116 concurrent jobs
```

That's **~116 active browser jobs**, not 1 million browsers.

That's a completely different infrastructure problem.

And if users perform 100 operations each, then the calculation changes dramatically.

---

# The architecture I'd choose for your project

For **Webrain + Obscura**, my target architecture would be:

```text
                    ┌───────────────┐
                    │    Angular    │
                    │    Webrain    │
                    └───────┬───────┘
                            │
                            ▼
                     ┌─────────────┐
                     │ API Gateway │
                     └──────┬──────┘
                            │
                    ┌───────▼────────┐
                    │ Agent Scheduler │
                    │ Session Router  │
                    └───────┬────────┘
                            │
                 ┌──────────▼──────────┐
                 │ Redis / NATS Queue  │
                 └──────────┬──────────┘
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
       ▼                    ▼                    ▼
  Obscura node         Obscura node         Obscura node
       │                    │                    │
   workers×N            workers×N            workers×N
       │                    │                    │
       └──────────────┬─────┴──────────────┬─────┘
                      │                    │
                  Proxy pool           Session store
```

And then:

```text
autoscale based on:
    queue depth
    active sessions
    CPU
    RSS
    p95 latency
    browser error rate
```

—not simply CPU utilization.

---

## My verdict on the text you pasted

| Claim                                     | Reality with Obscura                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| Cloud browser is required for 1M users    | **No**                                                          |
| Kubernetes is mandatory                   | **No**                                                          |
| Playwright is required                    | **No** — Obscura can be driven through CDP/Puppeteer/Playwright |
| 50–100 contexts/browser                   | **Bad assumption**                                              |
| Browser pooling is useful                 | **Yes**                                                         |
| Queue system                              | **Yes, strongly recommended**                                   |
| Horizontal scaling                        | **Yes**                                                         |
| Residential proxy for every request       | **No**                                                          |
| GPU required                              | **No**                                                          |
| Session affinity                          | **Yes for persistent sessions**                                 |
| Benchmark before choosing concurrency     | **Absolutely**                                                  |
| Start with a giant K8s cluster            | **No**                                                          |
| Obscura is suitable for this architecture | **Potentially yes**, but you need load testing                  |

The most important Obscura-specific fact is that **its own documented scaling model is worker-based: multiple CDP workers, roughly one per CPU core, with sticky sessions, while individual pages can share a V8 isolate.** ([GitHub][2])

So for your project, I would **not design around “Playwright browser pools” anymore**. I'd design around an **Obscura worker fleet + session router + queue**, with Playwright merely being one client protocol.

### The next thing we should do

The valuable next step is not more theoretical architecture. We should build a **real Obscura capacity model** for Webrain: e.g. `4 CPU / 8 GB`, `8 CPU / 16 GB`, determine pages/worker, jobs/sec, memory per active session, and derive what **100k / 1M / 10M users** actually cost. That would tell us whether you need 10, 50, or 500 Obscura nodes instead of guessing.

[1]: https://github.com/alksnd/obscura?utm_source=chatgpt.com "GitHub - alksnd/obscura · GitHub"
[2]: https://github.com/h4ckf0r0day/obscura/wiki/Run-in-production-at-scale?utm_source=chatgpt.com "Run in production at scale · h4ckf0r0day/obscura Wiki · GitHub"
[3]: https://github.com/h4ckf0r0day/obscura/wiki/Architecture-overview?utm_source=chatgpt.com "Architecture overview · h4ckf0r0day/obscura Wiki · GitHub"
[4]: https://github.com/h4ckf0r0day/obscura/wiki/Use-with-Playwright?utm_source=chatgpt.com "Use with Playwright · h4ckf0r0day/obscura Wiki · GitHub"
[5]: https://github.com/alksnd/obscura "GitHub - alksnd/obscura · GitHub"

# Webrain + Obscura: Production deployment strategy

For your project, I would choose a hybrid, queue-driven architecture, starting with Fly.io or Hetzner and keeping the option to migrate the browser fleet to Google Cloud later.

I would not deploy the entire platform on Coolify, nor would I start with Kubernetes.

Your system has three different workloads, and they should not share the same deployment strategy:

* Webrain API: authentication, billing, job creation, agent orchestration.

* Obscura browser fleet: CPU-intensive browser execution, CDP, persistent sessions.

* Background workers: discovery, crawling, extraction, LLM processing, retries.

The mistake would be deploying all three as one Docker Compose application and expecting the platform to scale them independently.

## My platform recommendation

Fly.io

---

My starting choice

Best fit for your initial Obscura production fleet.

* Docker-based deployment

* Machines for long-running browser processes

* Private networking

* Machine start/stop capabilities

* EU deployment regions

Important: Fly's built-in autostart/autostop does not create additional Machines automatically. You must provision capacity or build an autoscaler.

![](https://www.google.com/s2/favicons?domain=https://fly.io\&sz=32)

Fly Docs

+1

Official documentation

Hetzner

---

Cost optimization

Best candidate for predictable, always-on browser capacity.

* Dedicated CPU/RAM options

* European infrastructure

* Docker and Coolify compatibility

* Strong option for fixed browser worker pools

Cloud servers

·

Dedicated servers

Google Cloud

---

Best candidate for a mature, managed scaling platform.

* Cloud Run for stateless APIs

* Cloud Run Jobs for finite batch workloads

* GKE for advanced orchestration

* Managed queues, monitoring and autoscaling

Cloud Run supports scale-to-zero and configurable concurrency, but persistent CDP sessions require deliberate lifecycle and routing design.

![](https://www.google.com/s2/favicons?domain=https://docs.cloud.google.com\&sz=32)

docs.cloud.google.com

+2

Cloud Run documentation

Coolify

---

Use as your deployment control plane, not your browser autoscaler.

Excellent for deploying APIs, dashboards, databases and a small number of Docker services. It does not remove the need to engineer worker scheduling, capacity provisioning, session affinity or failover.

Official documentation

# Webrain / Obscura capacity and cost model

We will model three production sizes:

* 100,000 monthly active users (MAU)

* 1,000,000 MAU

* 10,000,000 MAU

The objective is to estimate:

1. Browser jobs per second.

2. Peak simultaneous Obscura sessions.

3. Active pages per worker.

4. RAM and CPU requirements.

5. Number of browser nodes.

6. Monthly infrastructure costs.

7. When Fly.io, Hetzner, Coolify or Google Cloud becomes appropriate.

One important distinction: these will be engineering estimates, not measured Obscura benchmarks. We should not pretend that an advertised 30 MB process footprint means 30 MB per fully loaded, JavaScript-heavy web page.

We will model two workload types:

* Stateless scraping: navigate, extract, return result, release browser resources.

* Persistent agent sessions: authenticated browser, multiple actions, cookies, session state and longer lifetimes.

The second workload is more expensive and has different scheduling requirements.


## 1. Obscura's actual scaling constraints

The current production documentation establishes several important facts:

* `obscura serve --workers N` starts multiple CDP workers.

* The recommended starting point is approximately one worker per CPU core.

* Sessions are sticky to their worker.

* Pages within a process share a single V8 isolate, so JavaScript execution is serialized through a shared lock.

* The documented default V8 heap is 4 GB on 64-bit systems, which must be considered when setting memory limits.

  ![](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

  GitHub

  +1

This changes the capacity model.

We cannot simply multiply the number of pages by the advertised 30 MB engine footprint.

### Initial engineering capacity assumptions

These are conservative planning targets to test, not guaranteed Obscura limits.

| Node configuration | Workers | Initial active page budget | Use                 |
| ------------------ | ------- | -------------------------- | ------------------- |
| 4 vCPU / 8 GB      | 4       | 8–12                       | Small production    |
| 8 vCPU / 16 GB     | 8       | 16–24                      | Standard fleet node |
| 16 vCPU / 32 GB    | 16      | 32–48                      | Larger worker node  |

Why these limits?

Because the relevant resource is not just memory. JavaScript evaluation, navigation, DOM processing, network activity and rendering compete for resources.

I would initially reserve 30–40% of node memory for the OS, native allocations, caches and operational headroom, and avoid running the browser fleet at 100% CPU.

Important: If your agent workflow requires real Chromium compatibility, Obscura's own rendering and Web API compatibility must be tested against representative sites before making it the exclusive production browser. Its README identifies differences from Chromium in parts of the web platform.

![](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub

## 2. User-to-browser workload model

We need to establish a concrete usage profile.

For the baseline, assume:

| Parameter                   | Assumption                            |
| --------------------------- | ------------------------------------- |
| Monthly active users        | 100k / 1M / 10M                       |
| Browser jobs per user/month | 2                                     |
| Average job duration        | 15 seconds                            |
| Peak-to-average ratio       | 10×                                   |
| Capacity headroom           | 50%                                   |
| Average browser job         | One navigation + extraction           |
| Persistent sessions         | Excluded from initial stateless model |

These are assumptions, not measured Webrain analytics.

### Monthly volume

| MAU        | Browser jobs/month | Average jobs/sec | Peak jobs/sec | Peak simultaneous jobs |
| ---------- | ------------------ | ---------------- | ------------- | ---------------------- |
| 100,000    | 200,000            | 0.077            | 0.77          | 12                     |
| 1,000,000  | 2,000,000          | 0.77             | 7.72          | 116                    |
| 10,000,000 | 20,000,000         | 7.72             | 77.2          | 1,158                  |

The calculation is:

Concurrency=Peak jobs/sec×Average duration\text{Concurrency} = \text{Peak jobs/sec}\times\text{Average duration}Concurrency=Peak jobs/sec×Average duration

This is the first capacity model we can use for sizing.


## 3. How many Obscura nodes do we need?

For the standard 8 vCPU / 16 GB node, we will budget 24 active pages and retain 50% capacity headroom.

This gives:

N=⌈Peak concurrency×1.524⌉N=\left\lceil\frac{\text{Peak concurrency}\times1.5}{24}\right\rceilN=⌈24Peak concurrency×1.5⌉

## 100,000 MAU

# 2 nodes

4 vCPU / 8 GB configuration

* 8–12 active jobs per node

* 4 workers per node

* 2 nodes for redundancy

* Approximately 8–16 total worker processes, depending on configuration

* Queue-based execution

  Small production fleet

## 1,000,000 MAU

# 8 nodes

8 vCPU / 16 GB configuration

* 192 nominal active page slots

* 116 modeled peak jobs

* 8 Obscura nodes

* 64 worker processes

* Multi-node failure tolerance requires additional capacity

  Production fleet

## 10,000,000 MAU

# 73 nodes

8 vCPU / 16 GB configuration

* 1,752 nominal active page slots

* 1,158 modeled peak jobs

* 584 worker processes

* Multiple regions recommended

* Dedicated fleet orchestration and capacity management

  Large-scale infrastructure

These are planning numbers, not demonstrated throughput. The concurrency per node must be validated under load.

## 4. Monthly infrastructure cost

### Option A: Fly.io

Fly's October 2026 published pricing lists:

| Machine                | Monthly compute |
| ---------------------- | --------------- |
| Performance 4x / 8 GB  | $132.01         |
| Performance 8x / 16 GB | $264.01         |

Storage and network egress are additional.

![](https://www.google.com/s2/favicons?domain=https://fly.io\&sz=32)

Fly

Using those prices:

| MAU  | Nodes   | Browser compute/month |
| ---- | ------- | --------------------- |
| 100k | 2 × 4x  | $264                  |
| 1M   | 8 × 8x  | $2,112                |
| 10M  | 73 × 8x | $19,272               |

This is the browser compute baseline, not your complete SaaS bill.

### Option B: Hetzner

Hetzner's current published CPX42 configuration provides 8 vCPU and 16 GB RAM. Its June 2026 pricing table lists €69.49/month, excluding VAT, for that configuration.

![](https://www.google.com/s2/favicons?domain=https://docs.hetzner.com\&sz=32)

Hetzner Docs

+1

| MAU  | Nodes                  | Approx. monthly compute |
| ---- | ---------------------- | ----------------------- |
| 100k | 2 × 4 vCPU equivalent* | €70–€140                |
| 1M   | 8 × CPX42              | €556                    |
| 10M  | 73 × CPX42             | €5,073                  |

The 100k row is a planning allowance, not a quote for an exact 4-vCPU SKU. The CPX42 price is the actual listed 8-vCPU configuration.

Hetzner's shared-vCPU performance and CPU availability must be benchmarked. For sustained high browser throughput, compare dedicated CPU instances as well.

### Option C: Google Cloud Run

Google Cloud publishes active-use pricing for CPU and memory, with different rates by region and billing model.

![](https://www.google.com/s2/favicons?domain=https://cloud.google.com\&sz=32)

Google Cloud

+1

For a rough compute-only illustration, suppose each job consumes:

* 1 vCPU for 15 seconds

* 1 GiB RAM for 15 seconds

At the published default rate of $0.000024 per vCPU-second and $0.0000025 per GiB-second:

| MAU  | Illustrative compute |
| ---- | -------------------- |
| 100k | ~$80/month           |
| 1M   | ~$795/month          |
| 10M  | ~$7,950/month        |

This is a theoretical active-compute calculation, not a production quote. It excludes instance startup, minimum instances, storage, networking, queues, logging and the costs of persistent WebSocket sessions. It also assumes the workload fits Cloud Run's execution and lifecycle model.

## 5. Full Webrain monthly budget

For budgeting, add API, database, queue, monitoring, storage and operational reserve to the browser compute.

These are planning allowances rather than vendor quotations.

| MAU  | Hetzner-oriented architecture | Fly-oriented architecture |
| ---- | ----------------------------- | ------------------------- |
| 100k | €200–€600                     | $500–$1,000               |
| 1M   | €1,000–€2,500                 | $2,500–$5,000             |
| 10M  | €8,000–€15,000                | $22,000–$40,000           |

Not included:

* Residential/ISP proxy traffic

* LLM inference

* High-volume screenshots and video

* Premium managed databases

* Dedicated 24/7 operations staff

* VAT and currency conversion

At 10M MAU, a high percentage of persistent browser sessions could invalidate these estimates. We must measure actual resource use before treating the numbers as a budget commitment.

## 6. The hidden cost multiplier: persistent agent sessions

Our baseline assumes 15-second stateless jobs.

But imagine Webrain users run agents for 3 minutes instead.

Share

Chart options

Concurrency sensitivity at 1M MAU

Assumes 2 jobs per user monthly and 10× peak-to-average traffic. Illustrative calculations.



At three minutes, the same million users require approximately 12 times the concurrency of the 15-second baseline.

This is why Webrain needs separate capacity pools:

```
                  Webrain Scheduler
                         │
             ┌───────────┴────────────┐
             │                        │
             ▼                        ▼
       Stateless Fleet          Stateful Fleet
             │                        │
        Short jobs              Persistent sessions
        15–30 sec               1–30 minutes
             │                        │
       Aggressive reuse          Sticky assignment
       Fast scale-out            Session recovery
             │                        │
             ▼                        ▼
        Obscura nodes             Obscura nodes
```

Do not let long-running agent sessions starve ordinary scraping jobs.

## 7. How I would actually deploy this

# Recommended Webrain production topology

Initial deployment

Angular / Webrain frontend

Firebase Hosting or your existing frontend hosting

API Gateway / Go or Bun API

Authentication · Stripe · quotas · job submission

Redis / queue

Job state · retries · rate limits

PostgreSQL/Firestore

Tenants · sessions · billing metadata

Obscura Fleet

Private network

Node A

4–8 vCPU

Obscura workers

Node B

4–8 vCPU

Obscura workers

Scale by adding nodes, not by allowing unlimited contexts.

Object storage

Crawl results · screenshots · exported data

### Deployment choices

| Component                    | Platform                                |
| ---------------------------- | --------------------------------------- |
| Angular frontend             | Existing Firebase Hosting               |
| API                          | Fly.io or existing backend              |
| Redis                        | Managed Redis / Upstash                 |
| PostgreSQL/Firestore         | Managed PostgreSQL/Firestore            |
| Obscura fleet                | Fly Machines initially                  |
| Cost-optimized browser fleet | Hetzner                                 |
| Deployment dashboard         | Coolify for self-hosted services        |
| Large-scale orchestration    | Kubernetes or a custom fleet controller |

One detail: use Coolify to deploy and manage services, but build a separate controller for browser node provisioning, health checks and drain operations.

## 8. The benchmark we need before production

This is the most important part of the entire exercise.

We need a benchmark using the exact Obscura release and the same page types Webrain will process.

### Benchmark matrix

| Test | CPU | RAM   | Workers | Active pages |
| ---- | --- | ----- | ------- | ------------ |
| A    | 4   | 8 GB  | 4       | 4            |
| B    | 4   | 8 GB  | 4       | 8            |
| C    | 4   | 8 GB  | 4       | 12           |
| D    | 8   | 16 GB | 8       | 8            |
| E    | 8   | 16 GB | 8       | 16           |
| F    | 8   | 16 GB | 8       | 24           |

Test each workload for at least 15–30 minutes, then run a longer soak test.

Measure:

* Jobs completed per second

* p50 / p95 / p99 navigation duration

* Peak and average RSS

* CPU utilization

* V8 heap usage

* Failed navigations

* Timeout rate

* Memory growth over time

* Recovery after worker termination

### Acceptance criteria

I would initially require:

| Metric                    | Target                                |
| ------------------------- | ------------------------------------- |
| Sustained CPU utilization | Below 70%                             |
| Memory utilization        | Below 75%                             |
| Job success rate          | At least 99% on controlled test sites |
| Queue wait p95            | Below 5 seconds at target load        |
| Memory growth             | No sustained upward trend             |
| Worker failure            | Automatic task recovery               |

These are proposed engineering SLOs, not current Obscura performance claims.

## 9. What I would implement first in Webrain

The initial production release should include:

* `obscura-worker` Docker image pinned to a specific release.

* Worker registration and heartbeat.

* Queue with job leases and retries.

* Session-to-worker affinity.

* Per-tenant concurrency limits.

* Worker draining before deployment.

* Graceful handling of node loss.

* Autoscaling from queue age and active jobs.

* Metrics for CPU, RSS, V8 heap, jobs/sec and p95.

* Load testing and a reproducible benchmark report.

Do not start by deploying 73 nodes. Start with two, validate the numbers, and only then derive the next capacity tier.

## Final capacity decision

For the assumptions in this model:

| Stage            | Deployment                 |
| ---------------- | -------------------------- |
| Development      | 1 Obscura node             |
| First production | 2 nodes                    |
| 100k MAU         | 2–3 nodes                  |
| 1M MAU           | Approximately 8–12 nodes   |
| 10M MAU          | Approximately 73–100 nodes |

The upper end adds operational redundancy and room for imperfect workload distribution.

My recommendation: start with Fly.io for the first production fleet, then benchmark equivalent Hetzner dedicated or cloud machines. Keep Google Cloud as a later option for managed infrastructure and global fleet orchestration.

The biggest unknown is not the cloud provider. It is actual Obscura throughput per worker under Webrain's real browser-agent workloads.

Once that is measured, node counts and costs become engineering calculations rather than guesses.

### Sources

* Obscura — Production at scale

* Obscura — Architecture overview

* Fly.io — October 2026 pricing

* Hetzner — June 2026 pricing

* Google Cloud Run pricing


Concurrency sensitivity at 1M MAU

Assumes 2 jobs per user monthly and 10× peak-to-average traffic. Illustrative calculations.

Average job duration	concurrency
15 sec	116
30 sec	232
60 sec	463
180 sec	1,389
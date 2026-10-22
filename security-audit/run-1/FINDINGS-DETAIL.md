# FINDINGS-DETAIL — run-1

All records below are schema-validated (validate-findings.cjs PASS) and independently record-verified.

---

## [NEEDS-VALIDATION] api/direct-port-3000:no-xff-direct-local-allow-all

**Any request without X-Forwarded-For receives 'direct-local' mutation authority — full anonymous control if port 3000 is reachable outside the gateway**

The gate treats absence (or whitespace) of X-Forwarded-For as proof of a loopback local process and allows the request (operator.ts:87-89). Only Caddy stamps XFF; the Next servers themselves (package.json:6 'next dev -p 3000', :8 'bun .next/standalone/server.js') are not configured in source to bind loopback-only, and next.config.ts sets no bind option. If :3000 (or the standalone port) is reachable from any external network, every mutating route is anonymous-open with 'direct-local' authority — the entire operator-key law is bypassed. A direct connection that self-supplies a private XFF also passes (first hop decides, :88).

- claimed_root_cause: Trust decision keyed on a header's absence rather than on the socket's actual locality; binding/firewall configuration is not present in the repository to enforce the loopback assumption.
- blockers: deployment_topology: whether port 3000 is bound to loopback and/or firewalled from external networks is not determinable from source (Next dev/standalone default to all interfaces absent -H/HOSTNAME, but that default behavior is not in-repo source) | sandbox_unavailable: no target-controlled execution in this environment to observe the listening socket or probe from an untrusted network
- local: On the host, record the bind address of the :3000 process (ss -tlnp equivalent): if it listens beyond 127.0.0.1 without an external firewall, the bypass is live
- deployment: From an untrusted network, send POST http://<host-ip>:3000/api/worker/tick without x-operator-key: a 200 response (vs the gateway path's 401) confirms anonymous full-mutation access; remediate by binding to 127.0.0.1 (HOSTNAME=127.0.0.1) or host firewall

### Trace

- entrypoint — `package.json:6` (runtime): dev script 'next dev -p 3000' with no HOSTNAME/loopback restriction; start script (:8) likewise
- propagation — `src/lib/operator.ts:89` (authority gate): if (!first) return { allowed: true, via: 'direct-local' } — no XFF means allowed
- propagation — `src/proxy.ts:13` (authority gate): verdict.allowed -> request proceeds to any POST handler
- sink — `src/app/api/worker/tick/route.ts:22` (state): representative sink: POST executes queued tasks via executeTaskOnce; all other mutating routes equally reachable

### Evidence

- `src/lib/operator.ts:89` — no-XFF = allowed
- `package.json:6` — no loopback bind restriction in run scripts

---

## [LOW] api/health:GET-public-organ-spawn-and-guardian-boot

**Anonymous GET /api/health boots the organ-guardian loop and spawns organ processes — a state-changing GET the central gate classifies as public**

GET /api/health (src/app/api/health/route.ts:94-107) unconditionally calls ensureOrganGuardian() (:97) — which boots a setInterval(60s) guardian loop (organ-guardian.ts:108-114) — and reviveOrgans() (:104), which probes all organs and spawn()s '/usr/local/bin/bun run dev' for any DOWN organ (health/route.ts:63-85, spawn at :81, 90s per-organ backoff), logging revival events to guardian.log (:42). Because isMutatingRequest returns false for plain GETs without ?force (operator.ts:74-82), the central proxy (the only authority control in the app) passes this route to the public internet through Caddy's default handle (Caddyfile:15-22): an anonymous external caller can force-respawn organs against the operator's process-state decisions (throttled only by the 90s backoff), read revival details including PIDs from the response, and drive guardian.log writes.

- root_cause: Method-based mutation classification in src/proxy.ts (GET=public) does not match the actual side effects of GET /api/health; the revival logic was embedded in the health read path without adding a force/key condition.
- intended_behavior: Public GETs are read-only; process spawning and background-loop booting are owner actions requiring direct-local/loopback origin or x-operator-key (or an explicit ?force, which would key-gate them).
- likelihood: high — any external GET
- impact: low — forced organ respawns, disk log writes, PID disclosure; fixed argv
- remediation: Split public health read from guarded revival: perform ensureOrganGuardian/reviveOrgans only when resolveOperator grants the request (loopback/direct-local or key), keeping the health data itself public.
- confidence: high

### Trace

- entrypoint — `Caddyfile:16` (gateway): default handle reverse_proxies any external request to localhost:3000 — external anonymous user is the lower-trust principal
- propagation — `src/proxy.ts:8` (authority gate): isMutatingRequest(GET,'/api/health') = false -> NextResponse.next() with no authority check
- propagation — `src/app/api/health/route.ts:97` (handler): every GET calls ensureOrganGuardian()
- propagation — `src/app/api/health/route.ts:104` (handler): every GET awaits reviveOrgans() (probe of all organs)
- propagation — `src/app/api/health/route.ts:81` (process): spawn('/usr/local/bin/bun', ['run','dev'], {cwd: organ dir}) — process creation reachable from a public request
- sink — `src/lib/organ-guardian.ts:111` (process): setInterval(60s) guardian loop booted from the public GET; same spawn at line 90

### Evidence

- `src/proxy.ts:8` — GET without ?force bypasses the operator-key gate
- `src/app/api/health/route.ts:81` — spawn of bun per down organ, no key/locality condition
- `src/lib/operator.ts:73` — the design's own law: mutating GET (?force) requires key — health mutates without it

---

## [MEDIUM] api/mutations:private-net-xff-csrf-no-origin-binding

**Mutating API endpoints accept cross-site requests using only the private-network source IP as the ambient credential — no Origin/Sec-Fetch-Site binding anywhere**

resolveOperator grants full mutation authority ('private-net') to any request whose XFF first hop is a private-range IP (operator.ts:87-90). Caddy stamps X-Forwarded-For from remote_host (Caddyfile:18, replace not append), so a browser inside the private network acquires owner-level mutation authority on every /api route with no cookie, no token, and no Origin/Referer/Sec-Fetch-Site validation anywhere in src (grep: zero matches). Any website such a browser visits can silently fire state-changing POSTs: the strongest sinks need no body at all — /api/sovereign/chain-repair?confirm=repair-fork-1045 rewrites ledger tail hashes and the export file (chain-repair.ts:41,143-147,74-77) via a plain HTML form POST; /api/sovereign/ops/tick auto-approves and executes pending handoffs (ops/tick/route.ts:55,183,196); /api/tasks parses req.json() regardless of content-type (tasks/route.ts:15) creating QUEUED tasks that worker/tick later executes (LLM spend).

- root_cause: Network position (source IP) is treated as an authentication credential for mutations; browsers present that credential ambiently to cross-site requests, and the central proxy performs no origin check to distinguish first-party from cross-site use of it.
- intended_behavior: Per the gate's own doctrine (operator.ts:1-3), mutations should require a local process (loopback) or the owner key; a browser-issued cross-site request should be rejected via an Origin/Sec-Fetch-Site allowlist in proxy() or by requiring x-operator-key even for private-net callers.
- likelihood: medium — any private-net browser visiting an attacker page
- impact: medium — owner-level mutations: ledger rewrite, handoff execution, LLM spend
- remediation: In proxy(), for mutating requests allowed via 'private-net', reject when a browser-origin signal indicates cross-site use (Sec-Fetch-Site: cross-site, or Origin present and not same-origin); non-browser clients without these headers keep working.
- confidence: high

### Trace

- entrypoint — `Caddyfile:18` (gateway): header_up X-Forwarded-For {remote_host} — a LAN browser's request carries its private-range IP as its identity
- propagation — `src/lib/operator.ts:90` (authority gate): isPrivateIp(first) -> {allowed:true, via:'private-net'} with no other proof of intent
- propagation — `src/proxy.ts:13` (authority gate): verdict.allowed -> NextResponse.next(); no Origin/Referer/Sec-Fetch-Site comparison exists in proxy() or any handler
- propagation — `src/lib/chain-repair.ts:143` (state): POST ?confirm=repair-fork-1045 (static token, chain-repair.ts:41) -> runChainRepair() rewrites ledger tail hashes via $transaction and rewrites the export file (:74-77) — triggerable by a plain HTML form POST
- sink — `src/app/api/sovereign/ops/tick/route.ts:183` (spend/state): tick auto-approves + executes pending handoffs via internal fetches; /api/tasks JSON sink adds LLM-spend task creation

### Evidence

- `src/lib/operator.ts:90` — private-range XFF alone grants mutation authority
- `src/lib/chain-repair.ts:41` — static confirm token usable verbatim in a cross-site form action
- `src/app/api/tasks/route.ts:15` — body parsed regardless of content-type — cross-site text/plain JSON POST is accepted

---

## [NEEDS-VALIDATION] fabric-heartbeat.pull-restart.unverified-origin-code-exec

**fabric-heartbeat pull-and-restart pipeline executes origin/main code with zero in-repo integrity verification, under a PAT-backed push identity**

Every 15 minutes (and 20s after boot, GIT_PULSE_FIRST_MS) gitPulse runs 'git pull --rebase origin main' (index.ts:657) with no commit pinning, no author/committer or signature check, and no path allowlist on fetched content. The pipeline then deliberately makes fetched code execute: the Task-119 law touches any organ's index.ts whose state files the rebase replaced (:692-709), forcing bun --watch to load the fetched modules inside organ processes; appGuard respawns 'bun run dev' from the same tree (:771); the only in-repo gate ('node .zscripts/leak-scan.mjs --staged', :635) is itself origin-sourced across pulses (it runs pre-pull on a tree shaped by prior pulls, so a landed commit can disable the secret gate at a later cycle) and scans secret patterns only — never code provenance. The heartbeat auto-commits and pushes any working-tree change ('git add -A' → commit → push origin main) under the GitHub PAT from upload/pat.env (name only) via the credential helper (.zscripts/git-credential-pat.sh), and on non-superset heals replaces the live db/custom.db with origin/main's blob (:528-538). Organs and the app run with the Steem WIF env names, OPERATOR_KEY, and vault files on disk — so executed fetched code reaches every secret the machine holds.

- claimed_root_cause: No integrity handoff exists between origin/main and execution: the privileged automation treats origin as trusted-by-definition without commit pinning, author allowlist, signature verification, or a path allowlist, and its one gate (leak-scan) guards secret patterns — not code provenance — while being fetched code itself.
- blockers: Write access to origin/main — branch protection rules, collaborator list, and the scope/ACL of the PAT stored at upload/pat.env (name only) — is a deployment fact not observable in source | Whether the sandbox's own automation (LLM worker/orchestrator flows) can land commits on origin/main without human approval is runtime behavior not visible in source
- local: Re-read heartbeat gitPulse/bounce/appGuard code paths to confirm no verification control exists (established by this review)
- deployment: Owner observes origin repo settings: branch protection on main, collaborator list, and the PAT at upload/pat.env (name only) — confirm it is scoped to this single repo and that no lower-trust principal holds contents:write Owner confirms whether any automated flow (worker/evolution/orchestrator) can create commits that reach origin/main without human review

### Trace

- entrypoint — `mini-services/fabric-heartbeat/index.ts:657` (gitPulse (15min + 20s after boot)): git pull --rebase origin main — sole gate is .git/index.lock; no verification of fetched commits anywhere in the file
- propagation — `mini-services/fabric-heartbeat/index.ts:704` (Task-119 organ bounce): touch of organ index.ts forces bun --watch reload onto replaced files — fetched organ code executes inside organ processes
- propagation — `mini-services/fabric-heartbeat/index.ts:635` (leak-scan gate): secret-leak gate runs from the pulled tree; gate replacement takes effect at a later cycle
- propagation — `mini-services/fabric-heartbeat/index.ts:771` (appGuard): after failed health checks, pkill next-server + 'bun run dev' from PROJECT_DIR — fetched app code executes
- propagation — `mini-services/fabric-heartbeat/index.ts:536` (resyncFromOrigin): when the local ledger chain is not a superset of origin, the live db/custom.db is replaced with origin/main's blob — remote content becomes live state
- sink — `mini-services/fabric-heartbeat/index.ts:717` (gitPulse push): git add -A → commit → push origin main under the upload/pat.env PAT via credential helper — the same channel that delivered the code also grants it push authority

### Evidence

- `mini-services/fabric-heartbeat/index.ts:657` — pull --rebase with no verify/pin/author/path controls
- `mini-services/fabric-heartbeat/index.ts:704` — touch of organ index.ts intentionally forces reload onto replaced files
- `.zscripts/leak-scan.mjs:48` — the only in-repo verification control scans secret patterns, not code provenance

---

## [NEEDS-VALIDATION] gateway:XTransformPort-open-passthrough:81

**Caddy :81 forwards any caller to any loopback port via ?XTransformPort= with no authentication or allowlist**

The root Caddyfile (:2-13) matches every request carrying query XTransformPort and reverse-proxies it to localhost:{query.XTransformPort} (:7), preserving method, path, remaining query and the attacker-supplied Host header (XFF overwritten to real client). There is no basic_auth/forward_auth/IP restriction and no port allowlist, so every organ port (dex 3010, witness 3050, keeper 3051, metrics 3060, grid 3070, arb 3071, council 3072, vault 3080, app 3000, and any other loopback listener) is reachable by unauthenticated external callers of :81 — the port the repo's own threat model calls the single public door (docs/SURVIVAL.md:112). Behind it sit zero-auth mutating endpoints (grid POST /halt /resume /cycle, arb POST /halt /resume, council POST /cycle /deliberate, vault-guardian POST /census /heal /drill, chain-witness GET /witness + /bench), and arb/metrics/heartbeat/keeper/witness additionally bind 0.0.0.0 — a second, gateway-independent external path. The dex repo's deploy/Caddyfile.public documents the intended hardened posture ('no public XTransformPort'; passthrough confined to 127.0.0.1:8081 with a {3010,3003} allowlist).

- claimed_root_cause: Query-parameter-controlled upstream selection exposed on the public listener; the organs' loopback binds — the only isolation — are intentionally traversed by this rule, and the known hardening pattern (allowlist + loopback-only operator site) was applied in the dex repo but not to the root Caddyfile.
- blockers: gateway_deployment_reachability: source shows the proxy rule, but whether the deployed Caddy runs this Caddyfile and whether :81 is exposed past the host firewall are deployment facts | caddy_version_capability: whether the running Caddy version supports {query.XTransformPort} placeholder upstreams is a runtime fact | targets_running: whether the organ services are running at a given exploitation time is a runtime fact
- local: Static: no auth/allowlist directive exists in Caddyfile and no organ handler (except dex operator routes) checks any secret — already established by this review
- deployment: Confirm the deployed Caddy runs this Caddyfile and that :81 is reachable from an external network position; then in an authorized non-producing environment POST http://<gateway>:81/halt?XTransformPort=3070 and observe the halt meta row + {ok:true,halted:true} Verify whether Caddy's default admin API (localhost:2019, no 'admin off' in the Caddyfile) accepts requests proxied via ?XTransformPort=2019 — if yes the passthrough additionally enables gateway config takeover

### Trace

- entrypoint — `Caddyfile:3` (gateway): matcher query XTransformPort=* accepts any non-empty value from any caller on :81
- propagation — `Caddyfile:7` (gateway): reverse_proxy localhost:{query.XTransformPort} — upstream port fully caller-chosen; method/path/query preserved
- propagation — `mini-services/saos-grid/index.ts:74` (saos-grid): POST /halt (and /resume:78, /cycle:82) execute engine mutations with no authority check
- propagation — `mini-services/vault-guardian/index.ts:129` (vault-guardian): POST /heal triggers the key-recovery pipeline with no authority check
- sink — `mini-services/chain-witness/index.ts:300` (chain-witness): GET /witness runs a full O(ledger) dual verification and appends to /tmp log; GET /bench runs up to 60 passes

### Evidence

- `Caddyfile:1` — :81 site with no auth directives; default handle proxies to :3000 (lines 15-22)
- `repos/saos-dex/deploy/Caddyfile.public:9` — documented intended behavior: no public XTransformPort — public surface GET-only whitelist
- `docs/SURVIVAL.md:112` — :81 declared the single public door; app-level gate lives in src/proxy.ts for :3000, nothing equivalent guards the passthrough branch

---

## [MEDIUM] saos-arb.halt-resume.no-authority.kill-switch-override

**saos-arb /resume unconditionally lifts the manual kill-switch and both halt/resume run with zero authority checks**

saos-arb (:3071) exposes POST /halt (:608-613) and POST /resume (:614-620) with no credential, no shared token and no header inspection. /halt writes the halt file with reason 'manual' — the owner's emergency stop. /resume sets halted=false, resets the error counter and unlinkSync(HALT_PATH) UNCONDITIONALLY, so a single unauthenticated POST defeats a manual kill-switch that cycle() explicitly treats as an owner decision auto-revival must not override (:468-486, esp. 472-474) and that healthJson promises stays (:581). The organ binds 0.0.0.0 (Bun.serve without hostname, :589) and the Caddyfile passthrough reaches :3071 from outside. The platform's own organ-mutation control pattern (repos/saos-dex operator-auth fail-closed x-saos-operator) is simply absent here. The dex book the arb trades on is declared simulation (index.ts:14), which limits financial blast radius but the explicit control defeat is complete.

- root_cause: Mutating handlers implemented without any authorization mechanism, and /resume does not distinguish manual halts from auto-halts, contradicting the organ's own Task-115 doctrine.
- intended_behavior: Manual kill-switch may only be lifted by the owner (operator key or loopback-local process); /resume must refuse reason==='manual' halts exactly like the auto-revival path does.
- likelihood: medium — one request when gateway/host reachable
- impact: medium — emergency-stop control fully defeated (simulated-book blast radius)
- remediation: Apply the platform's organ-mutation gate: require a shared operator token (fail-closed when unconfigured) on /halt and /resume; make /resume refuse to lift reason==='manual' halts.
- confidence: high

### Trace

- entrypoint — `Caddyfile:7` (gateway): external caller selects :3071 via ?XTransformPort=3071; the organ also binds 0.0.0.0 directly (index.ts:589)
- propagation — `mini-services/saos-arb/index.ts:608` (POST /halt): sets halted=true and writes the kill-switch file with reason 'manual' — no auth check of any kind
- sink — `mini-services/saos-arb/index.ts:614` (POST /resume): halted=false, consecErrors=0, unlinkSync(HALT_PATH) unconditionally — lifts a manual kill-switch with zero checks

### Evidence

- `mini-services/saos-arb/index.ts:614` — POST /resume handler: unconditional statements, zero authority checks
- `mini-services/saos-arb/index.ts:472` — cycle() honors reason==='manual' as owner decision — /resume contradicts it
- `mini-services/saos-arb/index.ts:589` — Bun.serve without hostname — binds all interfaces
- `repos/saos-dex/src/lib/operator-auth.ts:12` — in-repo intended control for organ mutations that saos-arb omits

---

## [MEDIUM] saos-council.deliberate.unauth-llm-spend.no-concurrency-guard

**saos-council POST /deliberate fires an unpaid-gate LLM deliberation per call with zero authority checks and no concurrency guard**

saos-council (:3072, bind 127.0.0.1, index.ts:157) exposes POST /deliberate (:217-220) which fires void councilCycle() — a full evidence→ruling→Director-LLM deliberation persisted to council.db — with no authority check, no running-guard (councilCycle :107-152 contains none, contrast vault-guardian's state.running), and none of the pacing that governs the timer path (COUNCIL_MS=600000 gates only the setInterval, :19/:235). Each POST triggers up to two LLM calls (deliberate() retry loop, council.ts:87-104) of operator-owned spend plus a council_cards INSERT (:141-143); replays are non-idempotent and can run concurrently. The app-level operator-key proxy gates /api/* only (src/proxy.ts:33); organ ports are reached via the Caddy XTransformPort passthrough.

- root_cause: Mutating organ endpoint with zero authority checks and no concurrency/budget guard; gateway passthrough converts loopback-trust into anonymous reachability.
- intended_behavior: LLM-spending mutations require the operator token and a running-guard (single flight) so spend is bounded by the owner's pacing.
- likelihood: medium — one request when gateway reachable
- impact: medium — operator-owned LLM spend amplification + DB write concurrency
- remediation: Require the shared operator token on /deliberate and add a running-guard so only one councilCycle executes at a time.
- confidence: high

### Trace

- entrypoint — `Caddyfile:7` (gateway): external caller selects :3072 via ?XTransformPort=3072 — bypasses the 127.0.0.1 bind
- propagation — `mini-services/saos-council/index.ts:217` (POST /deliberate): void councilCycle() fired per request; no busy flag, no rate limit, no caller credential
- sink — `mini-services/saos-council/council.ts:87` (LLM spend): deliberate() Director-LLM call with up to 2 attempts (operator-owned spend); result persisted to council_cards (index.ts:141-143)

### Evidence

- `mini-services/saos-council/index.ts:217` — handler fires councilCycle per POST with zero checks
- `mini-services/saos-council/council.ts:87` — attempt loop 1..2 with 1.5s backoff — up to 2 LLM calls per POST
- `src/proxy.ts:33` — matcher '/api/:path*' — the app's operator gate never covers organ ports

---

## [MEDIUM] saos-dex:desk-ledger-unkeyed-sig8-unauthenticated-write

**POST /api/dex/desk-ledger accepts unauthenticated receipt inserts because its 'signature' is an unkeyed public hash**

The only POST route on the dex without operatorAuth (38 of 57 sibling route files are gated). Its 'independent fail-closed verification' is sig8 = sha256(canonical(payload)).slice(0,8) — deterministic, keyless (canonical.ts:52-54), fully documented in the file itself — so any caller can compute a valid sig for any payload and insert rows of kind deposit/escrow_lock/settle/withdraw into deskLedgerReceipt with verified:true (route.ts:27-92, insert :76-87). The table is referenced nowhere else in the tree, so balances/kernel/AMM state are untouched; the blast radius is the desk→dex receipt anchor itself ('the only legal bridge from the desk to economic sovereignty') whose GET reports forged entries as verified and whose /contiguous flag can be kept contiguous by chaining prevSig from GET (:97-113). The only limit is the 240/min public rate budget (middleware.ts:40, applied :273-274).

- root_cause: An unkeyed hash mistaken for a signature plus a DB-writing POST shipped without the operatorAuth gate applied to its sibling mutation routes.
- intended_behavior: Every DB-writing POST route carries the operatorAuth gate; integrity anchors are keyed (HMAC) or digest-verified against a secret.
- likelihood: medium — one request when gateway reachable
- impact: medium — forged verified receipts in the integrity anchor table (no balances move)
- remediation: Add the operatorAuth gate (or replace sig8 with a keyed HMAC) so receipt inserts require authority, matching the 38 gated sibling routes.
- confidence: high

### Trace

- entrypoint — `repos/saos-dex/src/app/api/dex/desk-ledger/route.ts:27` (POST handler): no operatorAuth/consoleGuard call (imports only db and canonical, :1-3)
- propagation — `repos/saos-dex/src/app/api/dex/desk-ledger/route.ts:57` (sig8 recompute): sha256 of canonical public payload, attacker-computable, no secret involved (canonical.ts:52-54)
- sink — `repos/saos-dex/src/app/api/dex/desk-ledger/route.ts:76` (db write): db.deskLedgerReceipt.create(... verified:true) — durable unauthenticated write

### Evidence

- `repos/saos-dex/src/app/api/dex/desk-ledger/route.ts:8` — docstring claims 'independent fail-closed verification' via sig8 — but sig8 has no key
- `repos/saos-dex/src/lib/dex/canonical.ts:52` — sha256(s) with no key material
- `repos/saos-dex/src/middleware.ts:273` — middleware only rate-limits this path (240/min public), no auth

---

## [LOW] saos-grid.grid_events.grid_orders.unbounded-no-retention

**saos-grid ledger/event tables grow without any runtime retention; consumers full-scan the accumulated rows**

The grid organ appends to grid_events on decisions/cancels/places/fills/errors/adoptions (event() :217-221) and inserts a new grid_orders row for every place/requote/adoption (:550,:730,:830,:858,:866), but no code path ever deletes or rotates these tables at runtime — the only DELETE is the one-time Task-116 duplicate cleanup (:179). Row production is partly externally driven: any chain participant filling the public headcorner account's orders generates fill events, fill_ledger rows and counter-plans (:561-617). Consumers degrade as the tables grow: engine boot scans the entire grid_events place history (:192-208), summary() runs unindexed GROUP BY aggregates over grid_orders (:899-900) and an unindexed ORDER BY filled_at scan (:904-906) (recent/lastLiveFills are LIMIT-bounded, :901-902). Contrast: saos-metrics enforces 7-day retention on pulse.db (saos-metrics/index.ts:29, :306-311).

- root_cause: Missing retention/rotation on append-only sqlite tables whose write rate is bounded per-cycle but unbounded over time, with full-scan consumers.
- intended_behavior: Event history has a retention bound (like the sibling organ's 7d policy); hot aggregates are indexed or bounded.
- likelihood: high — certain over time during normal operation
- impact: low — slow-burn DB bloat degrading reads; eventual disk pressure
- remediation: Add a retention policy to grid_events (e.g., 30 days, pruned on the existing loop like saos-metrics does) and add an index on grid_orders.filled_at (or bound the filled-pairs scan).
- confidence: high

### Trace

- entrypoint — `mini-services/saos-grid/index.ts:162` (cycle timer): engine.cycle() every 45s; decision events written whenever the exposure governor blocks a side
- propagation — `mini-services/saos-grid/engine.ts:561` (external fill ingestion): external counterparty trades become events, fill_ledger rows and counter-plans — rows created by cheapest-possible external input
- propagation — `mini-services/saos-grid/engine.ts:217` (event()): unconditional INSERT INTO grid_events; the only runtime DELETE is the one-time Task-116 dedup (:179)
- sink — `mini-services/saos-grid/engine.ts:899` (summary()): unindexed GROUP BY over grid_orders + unindexed filled-pairs scan on every GET /grid

### Evidence

- `mini-services/saos-grid/engine.ts:179` — the single DELETE statement in the file — one-time historical cleanup, not retention
- `mini-services/saos-grid/engine.ts:217` — event() writes a row per decision/action with no cap or rotation
- `mini-services/saos-grid/engine.ts:904` — unindexed ORDER BY filled_at scan
- `mini-services/saos-metrics/index.ts:29` — sibling organ's contrast: pulse.db keeps 7 days with per-loop DELETE maintenance — the grid has none

---

## [MEDIUM] saos-grid:engine-shadow-to-live-migration-bypasses-anchor-fail-closed

**Shadow→live migration broadcasts sell orders while the external-value anchor is unavailable, bypassing the Task-117 absolute no-sell fail-closed**

engine.cycle() enforces 'no anchor → absolutely no sells' by forcing skipSide='sell' when floor===null (engine.ts:466) and gating ladder sells (:676), counter sells (:593) and requotes (:804) on it. The shadow→live migration loop (§4.6, engine.ts:480-515) is the one sell path outside that gate: it cancels a shadow sell only when `floor !== null && o.price < floor` (:492); when the anchor is unavailable (floor===null) that condition is false and the shadow sell falls through to broadcastLimitOrder (:504) at its recorded price — no anchor check, no skipSide guard (the buy side got the skipSide guard at :498, the sell side did not). Keys auto-restore via vault-guardian censusCycle auto-heal (vault-guardian/index.ts:73-78 → recover.ts:302-319, landSteemEnv :256), flipping engine mode to live (engine.ts:117-119), and the anchor-collapse scenario was measured live (Task-117: binance IP-reset + coingecko 429 → sells below parity 0.1029 < 0.1101).

- root_cause: Migration sell guard is cancel-only-if-below-floor (`floor !== null && o.price < floor`) instead of failing closed when floor is null; the skipSide==='sell' guard applied to buys (engine.ts:498) was never applied to sells in this loop.
- intended_behavior: Task-117 doctrine (engine.ts:415-425, 464-466, 802-804): with no external-value anchor, no sell may ever go live — the migration loop must cancel-or-hold shadow sell rows when floor===null, exactly as it already does for below-floor rows when the floor exists.
- likelihood: low — uncommon precondition: anchor outage while shadow sells are open and keys auto-restore
- impact: medium — live sells below external value = real on-chain loss
- remediation: Treat a missing anchor like a below-floor price in the migration loop: change the sell guard to `o.side === 'sell' && (floor === null || o.price < floor)` and add the symmetric `o.side === 'sell' && skipSide === 'sell'` hold mirroring the buy guard at engine.ts:498.
- confidence: high

### Trace

- entrypoint — `mini-services/saos-grid/engine.ts:476` (engine.cycle §4.6): live-mode migration loop iterates open shadow rows for accounts holding a WIF
- propagation — `mini-services/saos-grid/engine.ts:492` (migration sell guard): sell cancel conditioned on `floor !== null && o.price < floor` — with floor===null the guard is inert; buy guard at 498 uses skipSide for contrast
- sink — `mini-services/saos-grid/engine.ts:504` (chain broadcast): broadcastLimitOrder signs and broadcasts the shadow sell live with no anchor check (limit_order_create, engine.ts:305-345)

### Evidence

- `mini-services/saos-grid/engine.ts:424` — doctrine string: no anchor ⇒ absolute sell prohibition (Task-117 fail-closed)
- `mini-services/saos-grid/engine.ts:466` — floor===null forces skipSide='sell' — the gate the migration loop ignores for sells
- `mini-services/saos-grid/engine.ts:804` — requote path deliberately requires floor!==null for the sell exception — consistent doctrine the migration loop lacks
- `mini-services/saos-grid/market.ts:361` — anchor returns null when all sources fail and no valid disk anchor exists (stale >24h)
- `mini-services/vault-guardian/index.ts:73` — censusCycle auto-heal when !steemOk||!allClear — flips mode shadow→live without human action

---

## [MEDIUM] saos-grid:market-single-source-anchor-no-cross-validation-or-bounds

**Identity-line anchor accepts any single-source positive value with no cross-check or plausibility bounds — hostile/corrupted feed steers the live sell floor**

getExternalMarks() takes the first responding source (sticky first-wins, market.ts:302-313), validates only `p > 0` after parseFloat of the raw JSON field (parsers at :276/:283/:291 — NaN/negative rejected, but no Number.isFinite anywhere in the feed path so parseFloat('1e999')=Infinity passes, no upper bound, no plausibility clamp), then identityLine=steemUsd/sbdUsd and floor=identity×(1+50bps) (engine.ts:417-418) directly price live sell orders (engine.ts:682-685, broadcast :863-869) and drive the below-floor purge (re-anchoring orders onto the new floor). The 0.4% deadband (:270, applied :337-340) only suppresses small moves; one lying/compromised source can move the anchor (and rewrite state/marks.json, :341/:345) arbitrarily in a single refresh and stays first in the probe order while it responds. No median-of-sources, no deviation-vs-previous-mark bound beyond the deadband, no absolute plausibility band. Infinity produces an absurd floor (trading freeze); finite wrong values are the loss-bearing case (below-parity sells — exactly the measured Task-117 incident).

- root_cause: Single-source trust with minimal validation (>0) and sticky first-wins ordering; the sell-floor policy is defined by an unvalidated feed value with no robust aggregation or sanity band.
- intended_behavior: Anchor values must be finite, absolutely plausible, and bounded per step: reject non-finite and values outside an absolute plausibility band; reject single-refresh moves beyond a bound vs the previous anchor (freeze last-good anchor instead); on disagreement → hold last-good or fail closed (no sells).
- likelihood: low — requires a misbehaving/compromised feed source
- impact: medium — live sell orders priced below external value or trading freeze
- remediation: Surgical hardening now: Number.isFinite check in every parser, absolute plausibility band on identity inputs, and a single-refresh step bound (freeze last-good anchor on oversized moves). Full median+MAD aggregation across all sources as the follow-up (the dex price-proof module already implements that discipline for the same data class).
- confidence: high

### Trace

- entrypoint — `mini-services/saos-grid/market.ts:276` (feed parsers): binance/coingecko/coinpaprika parse one JSON field each and validate only p>0 (:276,:283,:291); Infinity passes; no finite/bounds check
- propagation — `mini-services/saos-grid/market.ts:302` (source selection): sticky first-wins ordering; first positive value wins; deadband (337-340) only holds sub-0.4% moves
- propagation — `mini-services/saos-grid/market.ts:341` (state): unvalidated value assigned to marksCache and persisted to marks.json (:345)
- sink — `mini-services/saos-grid/engine.ts:683` (trade pricing): floor consumed directly as live sell price lower bound (sellPrice2=max(target,floor), broadcast :863-869); below-floor purge re-anchors old orders onto the hostile floor

### Evidence

- `mini-services/saos-grid/market.ts:276` — binance: parseFloat(json.price) with only `p > 0`; no Number.isFinite in the feed path
- `mini-services/saos-grid/market.ts:337` — deadband compares candidate vs previous identity and only holds sub-0.4% moves
- `mini-services/saos-grid/engine.ts:683` — floor consumed directly as live sell price lower bound
- `mini-services/saos-grid/market.ts:345` — unvalidated value persisted to state/marks.json

---

## [MEDIUM] vault-guardian.heal-census-drill.zero-auth-custody-ops

**vault-guardian key-custody operations (/census, /heal, /drill) are triggerable by any caller with zero authority checks**

vault-guardian (:3080, bind 127.0.0.1, index.ts:104) exposes POST /census, POST /heal and POST /drill (:125-140) with no authority check. /heal forces heal() — the vault restoration pipeline that re-derives key material and lands upload/steem.env ONLY when the census failed (recover.ts:306-319; on an intact vault it is a key-file no-op, :321, but still re-runs the in-memory recovery drill); /census runs censusCycle which auto-invokes heal() when !steemOk||!allClear (index.ts:73-78); /drill runs the recovery drill. All three publishReceipt-append to upload/vault-guardian-log.jsonl (:22, :53-54) with no rotation. Responses expose booleans/fingerprints only (no secret disclosure), but the custody state machine itself is invocable anonymously via the gateway passthrough.

- root_cause: Sensitive custody actions on a loopback-trust organ with no authority check; gateway passthrough makes the loopback assumption false.
- intended_behavior: Custody state transitions require the operator token (fail-closed), matching the platform's organ-mutation pattern.
- likelihood: medium — one request when gateway reachable
- impact: medium — custody state machine invocable anonymously; key landing still census-gated
- remediation: Require the shared operator token on /census /heal /drill (fail-closed when unconfigured).
- confidence: high

### Trace

- entrypoint — `Caddyfile:7` (gateway): ?XTransformPort=3080 reaches vault-guardian despite hostname '127.0.0.1' (vault-guardian/index.ts:104)
- propagation — `mini-services/vault-guardian/index.ts:129` (POST /heal): await heal() — the vault restoration pipeline; zero checks before invocation (key-file rewrite only when census failed, recover.ts:306-319)
- sink — `mini-services/vault-guardian/index.ts:73` (POST /census): censusCycle auto-invokes heal() whenever the vault is not all-clear

### Evidence

- `mini-services/vault-guardian/index.ts:125` — three POST handlers (census/heal/drill) with no header/token check
- `mini-services/vault-guardian/index.ts:53` — publishReceipt appends a jsonl line per call — replayable writes, unbounded log
- `repos/saos-dex/src/lib/operator-auth.ts:12` — in-repo intended control pattern for organ mutations, absent here

---

## [NEEDS-VALIDATION] vault-guardian.single-repo-key-recovery-envelope

**Complete Steem key-recovery envelope (ciphertext + passphrase + seal wallet) co-located in one repository — repo read access equals Steem active-key access**

vault-guardian/recover.ts reconstructs the headcorner Steem active/posting/memo WIF51 private keys fully automatically from GitHub repo roshpinacare-sys/Saosmartwallet: the archive passphrase is read from recovery-meta-2026-09-12.json stored in the same repo (:159), used to decrypt KEYS-ACCESS-2026-09-12.tar.enc (openssl aes-256-cbc-pbkdf2, 300k, :162); the decrypted vault.json WIFs open GateConfig.keySeals (wallet DB — local-first at upload/vault-rescue/wallet.db with the same repo's git history as fallback, :100-113) via scrypt(N=32768)→AES-256-GCM (:127-142); the recovered master decrypts VaultEntry rows into WIFs, chain-verified (:191-218), then lands upload/steem.env 0600 (:238-259, chmod :257). The cipher, its passphrase, and the seal metadata all live in the same repository/host, so the only boundary protecting the Steem active key and wallet master key is that repo's read ACL (plus the read-only PAT at upload/pat.env, name only). The zero-human design law is stated at index.ts:8.

- claimed_root_cause: Split-knowledge is absent: the encrypted key archive's passphrase is co-located with the ciphertext and with the keySeal wallet DB in the same repository, nullifying the archive's AES-256-CBC-PBKDF2 envelope for any principal with repo read access; the intended control is solely the repo's privacy/ACL.
- blockers: Visibility and read-ACL of GitHub repo roshpinacare-sys/Saosmartwallet (private/public, collaborator list, organization membership) and the read scope of the PAT at upload/pat.env (name only) are deployment facts not observable in source
- local: Re-read recover.ts pipeline to confirm no secret input exists beyond repo blobs + PAT (established by this review: drill exposes fingerprints only because none other exist)
- deployment: Owner confirms Saosmartwallet repo visibility=private and enumerates every principal with read access (collaborators, org members, PATs including the upload/pat.env token — name only); if read access extends beyond the single operator, that principal can autonomously recover the Steem active/posting/memo keys and wallet master key Owner decides whether to accept the single-repo-envelope design or move the archive passphrase out of the repo (external KMS/secret store), updating recover.ts step 2 accordingly

### Trace

- entrypoint — `mini-services/vault-guardian/recover.ts:33` (recover.ts constants): REPO roshpinacare-sys/Saosmartwallet with ARCHIVE_PATH agent/vault/KEYS-ACCESS-2026-09-12.tar.enc and META_PATH agent/vault/recovery-meta-2026-09-12.json — the sole external source
- propagation — `mini-services/vault-guardian/recover.ts:159` (openVaultAndRecover): archive passphrase read from repo-stored recovery-meta JSON and passed to openssl -pass file:
- propagation — `mini-services/vault-guardian/recover.ts:127` (openSeal): vault.json WIFs from the decrypted archive open the keySeals (scrypt N=32768 → AES-256-GCM) to recover the 64-hex master key
- sink — `mini-services/vault-guardian/recover.ts:256` (landSteemEnv): recovered WIFs written to upload/steem.env 0600 — the entire recovery consumes only repo blobs plus the repo-read PAT

### Evidence

- `mini-services/vault-guardian/recover.ts:159` — passphrase for the encrypted key archive is stored in the repo (recovery-meta JSON)
- `mini-services/vault-guardian/recover.ts:100` — keySeal wallet DB local-first, repo git history fallback
- `mini-services/vault-guardian/index.ts:8` — stated design law: keys regenerate from git automatically — repo read access is the single intended boundary

# Architecture — my-project (SAOS sovereignty platform)

## Product, principals, protected resources
SAOS is a self-hosted autonomous trading + governance platform for the STEEM/HIVE-chain account `headcorner`, run by a single owner (the operator). Protected resources: (1) the STEEM account's **active/posting keys** (real on-chain value authority), (2) organ state DBs (`mini-services/*/state/*.db`, `db/custom.db`) holding the fill ledger and decisions, (3) the trading engine's order placement authority, (4) the git repository itself (fabric-heartbeat auto-commits/pushes), (5) the internal organ HTTP fleet. Principals: the owner (browser), unknown external internet users (the preview gateway is publicly reachable), the cloud STEEM runner (same account, different process — monitor-only law), external market feeds (binance/coingecko/coinpaprika/fixedfloat), the STEEM chain itself.

## Stack, deployment, limits
Next.js 16 App Router + TypeScript (port 3000), Caddy gateway (:81 → 3000, or any internal port via `?XTransformPort=`), 8 bun mini-services (loopback ports 3010, 3020, 3030, 3031, 3070, others), Prisma/SQLite state. No Docker, no OS sandbox for target-controlled execution (recorded in run-metadata). Build: `bun run lint`; dev server `bun run dev`. Offline analysis fully possible; no target execution in this run.

## Entry surfaces (source-verified)
1. **Caddy gateway** (`Caddyfile`): `:81`, matcher `XTransformPort=*` reverse-proxies to `localhost:{query.XTransformPort}` — any external caller can reach ANY loopback port by query param. Default handle → :3000.
2. **Next.js API**: `src/app/api/**` — 28 route families incl. control-plane-sounding ones: admin (admin/db-reconnect), operator, github, drill, worker/tick, sovereign/build, sovereignty, tasks, hub, evolution. **No `src/middleware.ts` exists** (verified: no file). `operator/route.ts` uses `ensureOperatorKey()`/`resolveOperator(req.headers)` (src/lib/operator.ts) — per-route operator-key checking exists but coverage across families is unverified (unit U2).
3. **Organ HTTP APIs**: saos-grid :3070 (/health, grid ops), saos-dex :3010 (wrap/mint/burn, price-proof), saos-council, saos-metrics, fabric-heartbeat :3031 — all externally reachable via surface 1.
4. **Outbound trust surfaces**: market feeds (market.ts multi-source anchor), FixedFloat probe, STEEM chain RPC (broadcast + history reads), git remote (origin/main auto-pull via fabric-heartbeat), LLM calls (saos-council, src/lib/llm-chain.ts).

## Trust boundaries and strongest source-visible controls
- External internet → gateway: Caddy :81 (no TLS on :81 itself; no allowlist on XTransformPort values — no source-visible auth).
- Gateway → Next.js API: per-route handler code only (no middleware). Operator-key check present at least in operator/route.ts.
- Gateway → organs: none visible from organ source (organs bind loopback; reachability is granted by the gateway itself).
- Organs → state DBs: local file SQLite, single-writer bind-guard (saos-grid index.ts), inode-orphan laws (doctrine comments).
- Organs → STEEM chain: key custody via env/.env + vault-guardian (names/paths only — secret values excluded from this audit by law).
- Market feeds → engine floor: multi-source anchor + deadband + marks.json last-known-good + fail-closed sell-ban (market.ts, engine.ts — Tasks 117/120).
- Chain content → app UI: React rendering (auto-escaping assumed, verify in U5).
- origin/main → running organs: fabric-heartbeat `git pull --rebase` + organ bounce (code-execution-by-merge path).

## Starting paths
Caddyfile; src/app/api/**; src/lib/{operator,executor,claims,llm-chain,secretscan,chain-export,chain-repair,fixedfloat,github,githubPolicy}.ts; mini-services/{saos-grid,saos-dex,saos-council,saos-metrics,fabric-heartbeat,vault-guardian,survival-keeper,chain-witness,saos-arb}; src/app/page.tsx; src/components/**.

## Prior coverage gaps
No prior runs. First coverage baseline: 14 units seeded (see coverage-ledger.json). This statement must not be read as "everything else is fine" — a single run is partial by definition.

## Companion selection summary
Selected because reconnaissance found the matching source-visible boundary: ATTACK-CLASSES.md (all units, core classes Access control / Injection / Business logic / Cryptography and secrets / Feature abuse and data leakage); WEB-PROTOCOL-AND-AUTH.md (gateway framing, Host-header trust, CSRF on state-changing app routes); AI-AND-LLM.md (council LLM ingests untrusted chain content with tool authority); SUPPLY-CHAIN-AND-RELEASE.md (heartbeat pull-and-restart pipeline, dependency trust); DATA-ISOLATION-AND-LIFECYCLE.md (state DB export/restore paths, chain-export); RESOURCE-EXHAUSTION-AND-AVAILABILITY.md (ledger growth, /proc scans, retry storms in probe loops); CLIENT-SIDE.md (chain-derived content rendering); PROTOCOLS-RPC-AND-MESSAGING.md (organ-to-organ loopback trust blurred by gateway passthrough).

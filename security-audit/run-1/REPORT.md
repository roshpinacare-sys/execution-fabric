# REPORT — SAOS security audit run-1

- **Repo**: my-project (`/home/z/my-project`) · **Source ref**: main @ e461e5d (audit) → fixes landed as Task-121
- **Profile**: standard · **Mode**: full audit · **Method**: source-only (no OS-enforced sandbox for target-controlled execution in this environment — recorded in run-metadata.json; every decisive runtime fact became `needs_validation`, nothing was probed live)
- **Workflow**: Cloudflare security-audit-skill, six phases — recon (parent-direct, source-verified) → coverage-ledged hunting (4 isolated hunters, 14 units) → candidate validation (2 fresh adversarial verifiers) → structured findings (schema-validated) → independent record verification (fresh verifier, 9/9 verified line-exact) → this report
- **Additive memory**: `coverage-ledger.json` + `findings.json` live in `security-audit/run-1/` — future runs MUST read them as prior input and target gaps instead of repeating (no-duplicates law, adopted from the CF skill; persistent-knowledge concept adopted from PentAGI whose Docker platform is not deployable here)

## Coverage statement

14 deterministic coverage units over gateway, Next.js API (56 route files), saos-grid, saos-dex, saos-council, vault-guardian, fabric-heartbeat, secrets custody, resource lifecycle, organ peer-trust, export/restore. 5 units closed `covered` clean (injection, client-XSS, council-LLM injection, business logic, export/restore — zero candidates). 9 units closed `candidate` with 14 fingerprints. No prior ledger existed — this run is the baseline; a single run never implies "rest is fine".

## Findings summary (13 records — 9 confirmed, 4 needs_validation, 0 rejected)

| # | Fingerprint | Sev | Core claim | Fix state |
|---|---|---|---|---|
| 1 | saos-grid:engine-shadow-to-live-migration-bypasses-anchor-fail-closed | medium | Shadow→live migration broadcast sells with `floor===null` — bypassed Task-117 no-anchor-no-sell doctrine | **FIXED** (fail-closed guard + skipSide mirror) |
| 2 | saos-grid:market-single-source-anchor-no-cross-validation-or-bounds | medium | Anchor accepts any single-source `>0` value (Infinity passes); one lying feed steers the live sell floor | **FIXED** (Number.isFinite + plausibility band + 25% step bound) |
| 3 | api/mutations:private-net-xff-csrf-no-origin-binding | medium | Private-net XFF = ambient mutation credential; no Origin/Sec-Fetch-Site binding → cross-site form/no-cors POSTs execute owner mutations | **FIXED** (origin binding in proxy for private-net) |
| 4 | api/health:GET-public-organ-spawn-and-guardian-boot | low | Anonymous GET /api/health boots guardian loop + spawns organs | **FIXED** (revival gated behind resolveOperator) |
| 5 | saos-arb.halt-resume.no-authority.kill-switch-override | medium | One unauth POST lifts the manual kill-switch (contradicts Task-115) | **FIXED** (organ auth gate) |
| 6 | saos-council.deliberate.unauth-llm-spend.no-concurrency-guard | medium | Unauth per-POST LLM spend, no single-flight | **FIXED** (gate + council-busy 429) |
| 7 | vault-guardian.heal-census-drill.zero-auth-custody-ops | medium | Custody state machine invocable anonymously | **FIXED** (gate on census/heal/drill) |
| 8 | saos-grid:3070-mutating-endpoints-without-authority-check | medium* | grid /halt /resume /cycle unauth | **FIXED** (gate; *deployment-reachability blocker noted) |
| 9 | saos-grid.grid_events.grid_orders.unbounded-no-retention | low | No retention on grid_events; full-scan consumers | **FIXED** (30d retention + filled_at index) |
| 10 | saos-dex:desk-ledger-unkeyed-sig8-unauthenticated-write | medium | sig8 is an unkeyed hash — forged verified receipts (informational table, no balances move) | DEFERRED — dex protocol release (see below) |
| 11 | api/direct-port-3000:no-xff-direct-local-allow-all | (nv) | Direct :3000 access = full anonymous mutations if not loopback-bound | owner deployment check |
| 12 | gateway:XTransformPort-open-passthrough:81 | (nv) | Public query-param passthrough to every organ port, no allowlist | mitigated by fixes 1-9; Caddy allowlist = owner decision |
| 13 | fabric-heartbeat.pull-restart.unverified-origin-code-exec | (nv) | Pull-and-restart executes origin code with no provenance gate | owner: branch protection / PAT scope |
| 14 | vault-guardian.single-repo-key-recovery-envelope | (nv) | Cipher+passphrase+seal co-located — repo read = key access | owner: split-knowledge decision |

\* The systemic fix for findings 5-8 is one shared control: **`mini-services/organ-auth.ts`** — every organ mutation now requires the `x-saos-organ` token (`upload/organ-token`, 0600, gitignored), fail-closed 503 when unconfigured, matching the dex's own operator-auth pattern. Council's mechanical halt sends the header. Verified live: unauth POST → 401 on all four organs; authorized cycle clean.

## What was adopted from the two referenced repos

**cloudflare/security-audit-skill** (vendored at `security-audit-skill/`, MIT): the full six-phase methodology, deterministic coverage ledger (percent-encoded canonical refs, validator-enforced), three-verdict honesty taxonomy (confirmed/needs_validation/rejected — nothing was "probably fine"), adversarial validation (verifier ≠ finder; disproving was the job), schema-validated findings (13/13 PASS on their zero-dependency validators), and additive prior-run law (future audits read run-1 first).

**vxcontrol/pentagi** (not deployable: no Docker in this sandbox, 4GB RAM, single exposed port — honestly recorded): adopted the *concepts* — persistent structured audit knowledge (our committed run-1 ledger+findings), specialized delegation with role isolation (hunters/verifiers/record-verifiers), and spend-countable budgets. Its heavy stack (PostgreSQL+pgvector, Neo4j, Redis, ClickHouse, MinIO, Grafana) would add zero sovereignty here and was refused per the honest-engineering doctrine.

## Residual recommendations (owner decisions, not fixes)

1. Bind :3000 to 127.0.0.1 (or host firewall) — closes finding 11 outright.
2. Caddy: consider confining `XTransformPort` to an allowlist `{3010,3000,3030,3031,3050,3051,3060,3070,3071,3072,3080}` — the dex repo's `deploy/Caddyfile.public` already documents this intended posture.
3. Origin/main: enforce branch protection + confirm the `upload/pat.env` PAT is single-repo scoped — closes finding 13's blocker.
4. Vault envelope: move the archive passphrase out of the Saosmartwallet repo (external KMS/human split) — closes finding 14's blocker by design choice.
5. saos-dex desk-ledger: replace unkeyed sig8 with an HMAC in a coordinated dex+desk release (the desk console's "zero-keys" handshake is the design's own law — not hot-patched to avoid breaking the live console).
6. Heartbeat hardening notes: appGuard respawn backoff, spawnSync timeouts — recorded in the ledger's hardening bookkeeping.

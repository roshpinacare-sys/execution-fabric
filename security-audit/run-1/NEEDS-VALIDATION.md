# NEEDS-VALIDATION — run-1

Source-grounded boundary hypotheses blocked on exact external facts. These have NO severity by law.

---

## api/direct-port-3000:no-xff-direct-local-allow-all

**Any request without X-Forwarded-For receives 'direct-local' mutation authority — full anonymous control if port 3000 is reachable outside the gateway**

The gate treats absence (or whitespace) of X-Forwarded-For as proof of a loopback local process and allows the request (operator.ts:87-89). Only Caddy stamps XFF; the Next servers themselves (package.json:6 'next dev -p 3000', :8 'bun .next/standalone/server.js') are not configured in source to bind loopback-only, and next.config.ts sets no bind option. If :3000 (or the standalone port) is reachable from any external network, every mutating route is anonymous-open with 'direct-local' authority — the entire operator-key law is bypassed. A direct connection that self-supplies a private XFF also passes (first hop decides, :88).

**Blockers:**
- deployment_topology: whether port 3000 is bound to loopback and/or firewalled from external networks is not determinable from source (Next dev/standalone default to all interfaces absent -H/HOSTNAME, but that default behavior is not in-repo source)
- sandbox_unavailable: no target-controlled execution in this environment to observe the listening socket or probe from an untrusted network

**Validation plan**
- local: On the host, record the bind address of the :3000 process (ss -tlnp equivalent): if it listens beyond 127.0.0.1 without an external firewall, the bypass is live
- deployment: From an untrusted network, send POST http://<host-ip>:3000/api/worker/tick without x-operator-key: a 200 response (vs the gateway path's 401) confirms anonymous full-mutation access; remediate by binding to 127.0.0.1 (HOSTNAME=127.0.0.1) or host firewall

---

## fabric-heartbeat.pull-restart.unverified-origin-code-exec

**fabric-heartbeat pull-and-restart pipeline executes origin/main code with zero in-repo integrity verification, under a PAT-backed push identity**

Every 15 minutes (and 20s after boot, GIT_PULSE_FIRST_MS) gitPulse runs 'git pull --rebase origin main' (index.ts:657) with no commit pinning, no author/committer or signature check, and no path allowlist on fetched content. The pipeline then deliberately makes fetched code execute: the Task-119 law touches any organ's index.ts whose state files the rebase replaced (:692-709), forcing bun --watch to load the fetched modules inside organ processes; appGuard respawns 'bun run dev' from the same tree (:771); the only in-repo gate ('node .zscripts/leak-scan.mjs --staged', :635) is itself origin-sourced across pulses (it runs pre-pull on a tree shaped by prior pulls, so a landed commit can disable the secret gate at a later cycle) and scans secret patterns only — never code provenance. The heartbeat auto-commits and pushes any working-tree change ('git add -A' → commit → push origin main) under the GitHub PAT from upload/pat.env (name only) via the credential helper (.zscripts/git-credential-pat.sh), and on non-superset heals replaces the live db/custom.db with origin/main's blob (:528-538). Organs and the app run with the Steem WIF env names, OPERATOR_KEY, and vault files on disk — so executed fetched code reaches every secret the machine holds.

**Blockers:**
- Write access to origin/main — branch protection rules, collaborator list, and the scope/ACL of the PAT stored at upload/pat.env (name only) — is a deployment fact not observable in source
- Whether the sandbox's own automation (LLM worker/orchestrator flows) can land commits on origin/main without human approval is runtime behavior not visible in source

**Validation plan**
- local: Re-read heartbeat gitPulse/bounce/appGuard code paths to confirm no verification control exists (established by this review)
- deployment: Owner observes origin repo settings: branch protection on main, collaborator list, and the PAT at upload/pat.env (name only) — confirm it is scoped to this single repo and that no lower-trust principal holds contents:write Owner confirms whether any automated flow (worker/evolution/orchestrator) can create commits that reach origin/main without human review

---

## gateway:XTransformPort-open-passthrough:81

**Caddy :81 forwards any caller to any loopback port via ?XTransformPort= with no authentication or allowlist**

The root Caddyfile (:2-13) matches every request carrying query XTransformPort and reverse-proxies it to localhost:{query.XTransformPort} (:7), preserving method, path, remaining query and the attacker-supplied Host header (XFF overwritten to real client). There is no basic_auth/forward_auth/IP restriction and no port allowlist, so every organ port (dex 3010, witness 3050, keeper 3051, metrics 3060, grid 3070, arb 3071, council 3072, vault 3080, app 3000, and any other loopback listener) is reachable by unauthenticated external callers of :81 — the port the repo's own threat model calls the single public door (docs/SURVIVAL.md:112). Behind it sit zero-auth mutating endpoints (grid POST /halt /resume /cycle, arb POST /halt /resume, council POST /cycle /deliberate, vault-guardian POST /census /heal /drill, chain-witness GET /witness + /bench), and arb/metrics/heartbeat/keeper/witness additionally bind 0.0.0.0 — a second, gateway-independent external path. The dex repo's deploy/Caddyfile.public documents the intended hardened posture ('no public XTransformPort'; passthrough confined to 127.0.0.1:8081 with a {3010,3003} allowlist).

**Blockers:**
- gateway_deployment_reachability: source shows the proxy rule, but whether the deployed Caddy runs this Caddyfile and whether :81 is exposed past the host firewall are deployment facts
- caddy_version_capability: whether the running Caddy version supports {query.XTransformPort} placeholder upstreams is a runtime fact
- targets_running: whether the organ services are running at a given exploitation time is a runtime fact

**Validation plan**
- local: Static: no auth/allowlist directive exists in Caddyfile and no organ handler (except dex operator routes) checks any secret — already established by this review
- deployment: Confirm the deployed Caddy runs this Caddyfile and that :81 is reachable from an external network position; then in an authorized non-producing environment POST http://<gateway>:81/halt?XTransformPort=3070 and observe the halt meta row + {ok:true,halted:true} Verify whether Caddy's default admin API (localhost:2019, no 'admin off' in the Caddyfile) accepts requests proxied via ?XTransformPort=2019 — if yes the passthrough additionally enables gateway config takeover

---

## vault-guardian.single-repo-key-recovery-envelope

**Complete Steem key-recovery envelope (ciphertext + passphrase + seal wallet) co-located in one repository — repo read access equals Steem active-key access**

vault-guardian/recover.ts reconstructs the headcorner Steem active/posting/memo WIF51 private keys fully automatically from GitHub repo roshpinacare-sys/Saosmartwallet: the archive passphrase is read from recovery-meta-2026-09-12.json stored in the same repo (:159), used to decrypt KEYS-ACCESS-2026-09-12.tar.enc (openssl aes-256-cbc-pbkdf2, 300k, :162); the decrypted vault.json WIFs open GateConfig.keySeals (wallet DB — local-first at upload/vault-rescue/wallet.db with the same repo's git history as fallback, :100-113) via scrypt(N=32768)→AES-256-GCM (:127-142); the recovered master decrypts VaultEntry rows into WIFs, chain-verified (:191-218), then lands upload/steem.env 0600 (:238-259, chmod :257). The cipher, its passphrase, and the seal metadata all live in the same repository/host, so the only boundary protecting the Steem active key and wallet master key is that repo's read ACL (plus the read-only PAT at upload/pat.env, name only). The zero-human design law is stated at index.ts:8.

**Blockers:**
- Visibility and read-ACL of GitHub repo roshpinacare-sys/Saosmartwallet (private/public, collaborator list, organization membership) and the read scope of the PAT at upload/pat.env (name only) are deployment facts not observable in source

**Validation plan**
- local: Re-read recover.ts pipeline to confirm no secret input exists beyond repo blobs + PAT (established by this review: drill exposes fingerprints only because none other exist)
- deployment: Owner confirms Saosmartwallet repo visibility=private and enumerates every principal with read access (collaborators, org members, PATs including the upload/pat.env token — name only); if read access extends beyond the single operator, that principal can autonomously recover the Steem active/posting/memo keys and wallet master key Owner decides whether to accept the single-repo-envelope design or move the archive passphrase out of the repo (external KMS/secret store), updating recover.ts step 2 accordingly

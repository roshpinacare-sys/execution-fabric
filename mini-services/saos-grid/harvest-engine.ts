// ═════════════════════════════════════════════════════════════════════════════
// harvest-engine.ts — קציר-וקיורציה חי על Steem (Task-136 §1 — מימון-עצמי)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §1: "The fleet MUST generate its own operational gas… via
// high-yield automated curation and reward harvesting across Steem/Hive."
// דירקטיבת-הבעלים §2: "Active voting, curation… on Steem/Hive."
// דירקטיבת-141 §2: "ALL registered soldier keypairs activated simultaneously…
// Active voting, curation" — הקיורציה-מסתובבת-עכשיו על-כל-חיילי-הכספת
// (headcorner + saos-0001..N) בסבב-דטרמיניסטי, עם-טלמטריה-פר-חשבון-כנה.
//
// חוקי-הבית:
//  · מפתחות-אמת-מהכספת (upload/steem.env, 0600, gitignored) — קריאה-in-process,
//    אפס-סודות-ביומנים/תשובות (רק-טביעות-אצבע-של-מפתחות-פומביים).
//  · חתימה = steem-tx.ts (מוכח-בייט-בייט-מול-השרשרת) + הוכחת-שחזור-לפני-שידור.
//  · שידור = מסלול-ה-mesh (אפס-תלות-צומת-בודדת).
//  · אימות-לאחר-מעשה: כל-קציר/הצבעה-נקרא-חזרה-מהשרשרת (get_account_history) —
//    לא-נספר-כהכנסה-עד-שהשרשרת-אמרה-שהוא-שם.
//  · מנוע-שמור: תקרת-משקל-הצבעה, שער-VP, שער-RC-מדיד (rc_api), גבול-הצבעות-
//    לפעימה-לחשבון, אבק-קציר — חיילים-בלי-דלק-לא-משודרים-אל-הכישלון (כנות-קודם).
// ═════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs'
import { steemMesh } from './market'
import { VAULT } from './engine'
import {
  buildTxBytes,
  OP_CLAIM_REWARD_BALANCE,
  OP_VOTE,
  serializeOperation,
  signTxBytes,
  wifToPubkey,
  type ClaimRewardBalanceOp,
  type VoteOp,
} from './steem-tx'
import { claimDecision, curationCandidates, rcVoteGate, rotationAccount, voteWeightBps, type Discussion } from './harvest'

// ── מדיניות-מנוע-שמור (מתועדת-בקוד) ─────────────────────────────────────────
const MIN_VP_PERCENT = 2_000 // מתחת-20% VP — המנוע-נח (שימור-יכולת-קיורציה-עתידית)
const VOTE_WEIGHT_CAP_BPS = 500 // 5% מקסימום-להצבעה — נשק-מדוד, לא-מקלעת
const MAX_VOTES_PER_PULSE = 1 // הצבעה-אחת-לפעימה (בחשבון-הסבב-הפעיל) — אפס-סערת-שידורים
const CLAIM_DUST_RAW = 1_000 // 1.000 יחידות-גלם (0.001 STEEM) — מתחת: רעש
const CURATION_TAG = process.env.SAOS_CURATION_TAG ?? 'life'
const CURATION_LIMIT = 50
// שער-RC-מדיד להצבעה (נמדד-חי 26/10: חייל-טרי max_rc 6.83G — creation-adj 4.83G + 2.000-VESTS×1.0;
// האוצר 4.40T). 2G ≈ 29% מקיבולת-חייל-טרי — מתחת: לא-שולחים-שידור-שיכשל.
const MIN_VOTE_RC = Number(process.env.SAOS_MIN_VOTE_RC ?? 2_000_000_000)

export interface HarvestTelemetry {
  account: string
  votingPower: number | null
  pendingSteem: number
  pendingSbd: number
  pendingVests: number
  at: string
}

/** טלמטריה-פר-חשבון (סבב-הקיורציה — דירקטיבת-141 §2) — כנות-מלאה-פר-חייל. */
export interface AccountCurationTelemetry {
  account: string
  votingPower: number | null
  /** rc_manabar.current_mana — null = לא-נמדד (fail-closed: לא-מצביעים) */
  rcMana: number | null
  rcMax: number | null
  pendingSteem: number
  pendingSbd: number
  pendingVests: number
  hasPostingKey: boolean
  votesBroadcast: number
  claimsBroadcast: number
  lastVoteAt: string | null
  lastVote: Record<string, unknown> | null
  lastClaim: Record<string, unknown> | null
  lastError: string | null
}

interface DynamicProps {
  head_block_number: number
  head_block_id: string
}

interface RawAccount {
  name: string
  voting_power: number
  reward_steem_balance: string
  reward_sbd_balance: string
  reward_vesting_balance: string
}

interface RcAccount {
  account: string
  max_rc: string
  rc_manabar: { current_mana: string; last_update_time: number }
}

function parseAsset(s: string | undefined): number {
  if (!s) return 0
  const m = /^([\d.]+)\s+([A-Z]+)$/.exec(s.trim())
  if (!m) return 0
  const [int, frac = ''] = m[1].split('.')
  const prec = m[2] === 'VESTS' ? 6 : 3
  const scaled = Number(int) * 10 ** prec + Math.round(Number('0.' + (frac || '0')) * 10 ** prec)
  return Number.isSafeInteger(scaled) ? scaled : Math.floor(scaled)
}

/** נוסחת-מוניטין-סטנדרטית (steemd): (log10(rep)−9)×9+25 — מהרפ-הגולם-הגדול. */
function repScore(rawRep: number): number {
  if (!Number.isFinite(rawRep) || rawRep <= 0) return 0
  return Math.max(0, Math.floor((Math.log10(rawRep) - 9) * 9 + 25))
}

export interface VaultAccountKeys {
  name: string
  postingWif: string | null
  activeWif: string | null
}

/** כל-חשבונות-הכספת עם-מפתחותיהם (GRID_ACCOUNTS + <NAME>_{POSTING,ACTIVE}_WIF). */
export function parseVaultAccounts(): VaultAccountKeys[] {
  try {
    const raw = readFileSync(VAULT, 'utf-8')
    const env = new Map<string, string>()
    for (const line of raw.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) env.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    const accounts = (env.get('GRID_ACCOUNTS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return accounts.map((name) => {
      const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      return {
        name,
        postingWif: env.get(`${key}_POSTING_WIF`) ?? null,
        activeWif: env.get(`${key}_ACTIVE_WIF`) ?? null,
      }
    })
  } catch {
    return []
  }
}

/** תאימות-לאחור: החשבון-הראשון (האוצר) — דפוס-Task-136 המקורי. */
function parseVault(): { account: string; postingWif: string | null; activeWif: string | null } {
  const accs = parseVaultAccounts()
  return accs[0] ?? { account: '', postingWif: null, activeWif: null }
}

interface TrxHeader {
  refBlockNum: number
  refBlockPrefix: number
  expirationEpoch: number
}

export async function buildHeader(): Promise<TrxHeader | { error: string }> {
  const r = await steemMesh.call<DynamicProps>('condenser_api.get_dynamic_global_properties', [])
  if (!r.ok) return { error: `dynamic-props: ${r.error}` }
  const id = r.data.head_block_id ?? ''
  // ref_block_prefix = 4 בייטים מה-id (bytes 4..8) כ-uint32 LE — סמנטיקת-steemit
  const raw = Buffer.from(id.slice(8, 16), 'hex')
  const prefix = raw.length === 4 ? raw.readUInt32LE(0) : 0
  return {
    refBlockNum: r.data.head_block_number & 0xffff,
    refBlockPrefix: prefix,
    expirationEpoch: Math.floor(Date.now() / 1000) + 45,
  }
}

const A58_DEC = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function stmSigToHex(stm: string): string {
  // STM-base58check → 65 בייטים גלמיים-hex ([31+recid][r32][s32]) —
  // appbase מצפה-חתימות-hex (מוכח-חי: "Invalid hex character 'S'" על-STM;
  // "Missing Posting Authority" על-hex = פרסינג-מלא-עד-סוף)
  const A = A58_DEC
  let n = 0n
  for (const c of stm.replace(/^STM/, '')) {
    const i = A.indexOf(c)
    if (i < 0) throw new Error('steem-tx: bad-base58-in-signature')
    n = n * 58n + BigInt(i)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const dec = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  if (dec.length !== 70 || dec[0] !== 0x80) throw new Error(`steem-tx: unexpected-sig-form (len=${dec.length})`)
  return Buffer.from(dec.subarray(1, 66)).toString('hex')
}

export async function broadcast(signed: { txHex: string; signature: string }, header: TrxHeader, ops: [string, unknown][]): Promise<{ ok: true; blockNum?: number; trxId?: string | null } | { ok: false; error: string }> {
  const trx = {
    ref_block_num: header.refBlockNum,
    ref_block_prefix: header.refBlockPrefix,
    // steemd-פורמט קנוני: ללא-אזור-זמן/סיומת-Z (bad-lexical-cast על-Z)
    expiration: new Date(header.expirationEpoch * 1000).toISOString().replace(/\.\d+Z$/, '').replace(/Z$/, ''),
    operations: ops,
    extensions: [],
    signatures: [stmSigToHex(signed.signature)], // appbase: חתימה-hex-גלמית (מוכח-חי)
  }
  const r = await steemMesh.call<{ id?: string; block_num?: number }>('network_broadcast_api.broadcast_transaction_synchronous', [trx])
  // הסנכרוני-מחכה-להכלה-בבלוק — תשובה-עם-block_num = הוכחת-הכלה (לא-רק-קבלה-למאגר)
  if (r.ok && r.data && typeof r.data.block_num === 'number' && r.data.block_num > 0) {
    return { ok: true, blockNum: r.data.block_num, trxId: r.data.id ?? null }
  }
  if (r.ok) {
    return { ok: false, error: 'synchronous-broadcast-ללא-הוכחת-בלוק (כנות — לא-נספר-כשודר)' }
  }
  const perNode = (steemMesh as unknown as { eps?: Array<{ name: string; lastError: string | null; state: string; consecFails: number }> }).eps?.map((e) => ({ name: e.name, lastError: e.lastError, state: e.state, consecFails: e.consecFails })) ?? null
  return { ok: false, error: `${r.error} | perNode: ${JSON.stringify(perNode)}` }
}

async function readAccountsBatch(names: string[]): Promise<Record<string, RawAccount> | { error: string }> {
  const r = await steemMesh.call<RawAccount[]>('condenser_api.get_accounts', [names])
  if (!r.ok) return { error: `get_accounts: ${r.error}` }
  const out: Record<string, RawAccount> = {}
  for (const a of r.data ?? []) out[a.name] = a
  if (names.some((n) => !out[n])) {
    const missing = names.filter((n) => !out[n]).join(',')
    return { error: `accounts-missing: ${missing}` }
  }
  return out
}

/** RC-מדיד-חי (rc_api.find_rc_accounts). כישלון-קריאה = null-לכולם (fail-closed — לא-מצביעים). */
async function readRcBatch(names: string[]): Promise<{ perAccount: Record<string, { mana: number; max: number } | null>; error: string | null }> {
  const r = await steemMesh.call<{ rc_accounts: RcAccount[] }>('rc_api.find_rc_accounts', { accounts: names })
  const out: Record<string, { mana: number; max: number } | null> = {}
  for (const n of names) out[n] = null
  if (!r.ok || !r.data?.rc_accounts) {
    return { perAccount: out, error: `rc_api.find_rc_accounts: ${r.error ?? 'no-data'}` }
  }
  for (const a of r.data.rc_accounts) {
    out[a.account] = { mana: parseInt(a.rc_manabar.current_mana, 10) || 0, max: parseInt(a.max_rc, 10) || 0 }
  }
  return { perAccount: out, error: null }
}

async function voteInHistory(account: string, permlink: string): Promise<boolean> {
  const r = await steemMesh.call<Array<[number, { op: [string, Record<string, unknown>] }]>>(
    'condenser_api.get_account_history',
    [account, -1, 20],
  )
  if (!r.ok) return false
  return (r.data ?? []).some(([, e]) => e.op?.[0] === 'vote' && e.op?.[1]?.permlink === permlink)
}

// ── מצב-חי (על-ה-/health) ─────────────────────────────────────────────────────
export const harvestState = {
  cycles: 0,
  claimsBroadcast: 0,
  votesBroadcast: 0,
  lastPulseAt: null as string | null,
  lastResult: null as Record<string, unknown> | null,
  lastError: null as string | null,
  telemetry: null as HarvestTelemetry | null,
  keysFingerprint: null as string | null,
  // דירקטיבת-141 §2 — סבב-הקיורציה-על-כל-חיילי-הכספת
  rotation: {
    index: 0,
    order: [] as string[],
    lastAccount: null as string | null,
    perAccount: {} as Record<string, AccountCurationTelemetry>,
  },
  law: 'דירקטיבת-141 §2 — סבב-קיורציה-על-כל-החיילים; כל-פעולה-נקראת-חזרה-מהשרשרת; שער-VP+RC-מדיד-בטרם-כל-הצבעה',
}

function ensureTelemetry(name: string): AccountCurationTelemetry {
  let t = harvestState.rotation.perAccount[name]
  if (!t) {
    t = {
      account: name,
      votingPower: null,
      rcMana: null,
      rcMax: null,
      pendingSteem: 0,
      pendingSbd: 0,
      pendingVests: 0,
      hasPostingKey: false,
      votesBroadcast: 0,
      claimsBroadcast: 0,
      lastVoteAt: null,
      lastVote: null,
      lastClaim: null,
      lastError: null,
    }
    harvestState.rotation.perAccount[name] = t
  }
  return t
}

export async function harvestPulse(): Promise<void> {
  const vaultAccounts = parseVaultAccounts()
  if (vaultAccounts.length === 0 || !vaultAccounts[0]!.postingWif) {
    harvestState.lastError = 'custody-gated: אין-מפתחות-חתימה-בכספת (steem.env)'
    return
  }
  if (harvestState.keysFingerprint === null) {
    try {
      harvestState.keysFingerprint = wifToPubkey(vaultAccounts[0]!.postingWif!).slice(3, 15) // טביעת-אצבע-פומבית-בלבד
    } catch {
      harvestState.lastError = 'vault-key-invalid: WIF-נופל-באימות-b58check'
      return
    }
  }
  const names = vaultAccounts.map((a) => a.name)
  const accs = await readAccountsBatch(names)
  if ('error' in accs) {
    harvestState.lastError = accs.error
    return
  }
  const rc = await readRcBatch(names)

  // ── טלמטריה-פר-חשבון (מדידה-ראשון — כנות-קודם-לכל-שידור) ────────────────────
  for (const name of names) {
    const acc = accs[name]!
    const t = ensureTelemetry(name)
    t.votingPower = acc.voting_power ?? null
    t.rcMana = rc.perAccount[name]?.mana ?? null
    t.rcMax = rc.perAccount[name]?.max ?? null
    t.pendingSteem = parseAsset(acc.reward_steem_balance)
    t.pendingSbd = parseAsset(acc.reward_sbd_balance)
    t.pendingVests = parseAsset(acc.reward_vesting_balance)
    t.hasPostingKey = vaultAccounts.find((v) => v.name === name)?.postingWif != null
  }
  harvestState.cycles++
  harvestState.lastPulseAt = new Date().toISOString()
  const result: Record<string, unknown> = { cycle: harvestState.cycles }
  if (rc.error) result.rcRead = { error: rc.error } // כנות: RC-לא-נמדד-הפעם → אין-הצבעות

  // ── 1. קציר-פרסים (ACTIVE) — לכל-חשבון-שיש-לו-כסף-אמת-מעל-האבק ────────────────
  const claimOutcomes: Array<Record<string, unknown>> = []
  for (const name of names) {
    const acc = accs[name]!
    const rewards = {
      steem: parseAsset(acc.reward_steem_balance),
      sbd: parseAsset(acc.reward_sbd_balance),
      vests: parseAsset(acc.reward_vesting_balance),
    }
    const t = ensureTelemetry(name)
    const claim = claimDecision(name, rewards, CLAIM_DUST_RAW)
    if (!claim) {
      const outcome = { account: name, status: 'dust-or-empty', pending: rewards }
      claimOutcomes.push(outcome)
      t.lastClaim = outcome
      continue
    }
    const activeWif = vaultAccounts.find((v) => v.name === name)?.activeWif ?? null
    if (!activeWif) {
      const outcome = { account: name, status: 'custody-gated: אין-ACTIVE-WIF לקציר' }
      claimOutcomes.push(outcome)
      t.lastClaim = outcome
      t.lastError = outcome.status
      continue
    }
    const header = await buildHeader()
    if ('error' in header) {
      harvestState.lastError = header.error
      return
    }
    const claimData: ClaimRewardBalanceOp = {
      account: claim.account,
      rewardSteem: claim.rewardSteem,
      rewardSbd: claim.rewardSbd,
      rewardVests: claim.rewardVests,
    }
    const tx = buildTxBytes(header, [serializeOperation(OP_CLAIM_REWARD_BALANCE, claimData)])
    const signed = signTxBytes(tx, activeWif)
    const b = await broadcast(signed, header, [['claim_reward_balance', {
      account: claim.account,
      reward_steem: `${(claim.rewardSteem / 1000).toFixed(3)} STEEM`,
      reward_sbd: `${(claim.rewardSbd / 1000).toFixed(3)} SBD`,
      reward_vests: `${(claim.rewardVests / 1e6).toFixed(6)} VESTS`,
    }]])
    if (b.ok) {
      // אימות-לאחר-מעשה: קריאה-חוזרת-של-החשבון — הפרסים-חייבים-לרדת-לאפס
      const after = await readAccountsBatch([name])
      const cleared = 'error' in after ? false : parseAsset(after[name]!.reward_vesting_balance) < rewards.vests
      if (cleared) {
        harvestState.claimsBroadcast++
        t.claimsBroadcast++
        const outcome = { account: name, status: 'broadcast+verified', rewards }
        claimOutcomes.push(outcome)
        t.lastClaim = outcome
        t.lastError = null
        console.log(`[harvest] קציר-אמת (${name}): ${rewards.steem / 1000} STEEM + ${rewards.sbd / 1000} SBD + ${rewards.vests / 1e6} VESTS — נקרא-חזרה-מהשרשרת`)
      } else {
        const outcome = { account: name, status: 'broadcast-שודר-אך-האימות-החוזר-טרם-מדד-ניקוי (כנות)' }
        claimOutcomes.push(outcome)
        t.lastClaim = outcome
      }
    } else {
      const outcome = { account: name, status: 'rejected', error: b.error }
      claimOutcomes.push(outcome)
      t.lastClaim = outcome
      t.lastError = `claim-broadcast: ${b.error}`
      harvestState.lastError = `claim-broadcast(${name}): ${b.error}`
    }
  }
  result.claims = claimOutcomes
  result.claim = claimOutcomes.find((c) => c.account === names[0]) ?? null // תאימות-לאחור (האוצר)

  // ── 2. קיורציה-בסבב (POSTING) — חשבון-אחד-לפעימה על-כל-הכספת (דירקטיבת-141 §2) ──
  const order = names
  harvestState.rotation.order = order
  const activeName = rotationAccount(order, harvestState.rotation.index)
  if (!activeName) {
    result.curation = { status: 'rotation-empty' }
  } else {
    harvestState.rotation.index++
    harvestState.rotation.lastAccount = activeName
    result.rotation = { account: activeName, index: harvestState.rotation.index - 1, order }
    const t = ensureTelemetry(activeName)
    const acc = accs[activeName]!
    const postingWif = vaultAccounts.find((v) => v.name === activeName)?.postingWif ?? null
    if (!postingWif) {
      result.curation = { status: 'custody-gated: אין-POSTING-WIF-לחשבון-הסבב', account: activeName }
      t.lastError = 'custody-gated: אין-POSTING-WIF'
    } else {
      const weight = voteWeightBps(acc.voting_power ?? 0, MIN_VP_PERCENT, VOTE_WEIGHT_CAP_BPS)
      if (weight === 0) {
        result.curation = { status: 'vp-gate', account: activeName, votingPower: acc.voting_power, minVp: MIN_VP_PERCENT }
      } else if (!rcVoteGate(t.rcMana, MIN_VOTE_RC)) {
        // כנות-מדידה: חייל-בלי-דלק-RC (או RC-לא-נמדד) — לא-שולחים-שידור-שיכשל
        result.curation = { status: t.rcMana === null ? 'rc-unmeasured (fail-closed)' : 'rc-gate', account: activeName, rcMana: t.rcMana, minRc: MIN_VOTE_RC }
        t.lastError = result.curation.status
      } else {
        const dr = await steemMesh.call<Array<Record<string, unknown>>>('condenser_api.get_discussions_by_created', [{ tag: CURATION_TAG, limit: 100 }])
        if (!dr.ok) {
          // כנות-מדידה: תעד-את-השגיאה-האחרונה-של-כל-צומת — המשפט-"הכל-נפל" בלי-הצלבה הוא לא-אבחון
          const perNode = (steemMesh as unknown as { eps?: Array<{ name: string; lastError: string | null; state: string; consecFails: number }> }).eps?.map((e) => ({ name: e.name, lastError: e.lastError, state: e.state, consecFails: e.consecFails })) ?? null
          result.curation = { status: 'feed-error', account: activeName, error: dr.error, perNode }
        } else {
          const discussions: Discussion[] = (dr.data ?? []).map((d) => ({
            author: String(d.author ?? ''),
            permlink: String(d.permlink ?? ''),
            createdEpochMs: Date.parse(String(d.created ?? '')) || 0,
            // pending_payout_value "2.000 SBD" → parseAsset=2000-יחידות-גלם → ×1000 = מיקרו-דולר
            pendingPayout: parseAsset(String(d.pending_payout_value ?? '0')) * 1000,
            // נוסחת-המוניטין-הרשמית-של-steemd: (log10(rep)-9)×9+25 (rep-גולם-×1e6-סקאלה)
            authorReputation: repScore(Number(d.author_reputation ?? 0)),
            alreadyVoted: Array.isArray(d.active_votes) && (d.active_votes as Array<{ voter: string }>).some((v) => v.voter === activeName),
          }))
          const picked = curationCandidates(discussions, {
            nowEpochMs: Date.now(),
            minAgeMin: 5,
            maxAgeMin: 240,
            minRep: 50,
            minPendingMicros: 10_000, // $0.01 — סף-עניין-אמת
            limit: MAX_VOTES_PER_PULSE,
          })
          if (picked.length === 0) {
            result.curation = { status: 'no-candidate-passed-policy', account: activeName }
          } else {
            const target = picked[0]!
            const header = await buildHeader()
            if ('error' in header) {
              harvestState.lastError = header.error
              return
            }
            const voteData: VoteOp = { voter: activeName, author: target.author, permlink: target.permlink, weight }
            const tx = buildTxBytes(header, [serializeOperation(OP_VOTE, voteData)])
            const signed = signTxBytes(tx, postingWif)
            const b = await broadcast(signed, header, [['vote', {
              voter: activeName, author: target.author, permlink: target.permlink, weight,
            }]])
            if (b.ok) {
              const seen = await voteInHistory(activeName, target.permlink)
              if (seen) {
                harvestState.votesBroadcast++
                t.votesBroadcast++
                t.lastVoteAt = new Date().toISOString()
                t.lastVote = { author: target.author, permlink: target.permlink, weight, blockNum: b.blockNum ?? null }
                t.lastError = null
                result.curation = { status: 'broadcast+verified', account: activeName, author: target.author, permlink: target.permlink, weight }
                console.log(`[harvest] קיורציה-אמת (${activeName}): הצבעה ${weight}bps → @${target.author}/${target.permlink.slice(0, 32)} — נקרא-חזרה-מההיסטוריה`)
              } else {
                result.curation = { status: 'broadcast-שודר-אך-ההיסטוריה-טרם-מדדה (כנות)', account: activeName, author: target.author }
              }
            } else {
              result.curation = { status: 'rejected', account: activeName, error: b.error }
              t.lastError = `vote-broadcast: ${b.error}`
              harvestState.lastError = `vote-broadcast(${activeName}): ${b.error}`
            }
          }
        }
      }
    }
  }

  // טלמטרית-החשבון-הפעיל-היא-הראשית (תאימות-לאחור למציגים-שקראו telemetry יחיד)
  const act = activeName ? ensureTelemetry(activeName) : null
  if (act) {
    harvestState.telemetry = {
      account: act.account,
      votingPower: act.votingPower,
      pendingSteem: act.pendingSteem,
      pendingSbd: act.pendingSbd,
      pendingVests: act.pendingVests,
      at: harvestState.lastPulseAt,
    }
  }
  // כנות: lastError נקבע-על-ידי-מסלולי-הכשל-בפנים-למעלה; פעימה-נקייה (בלי-דחיות-אמת)
  // = ניקוי-כנה. מצבי-'כנות'-צפויים (rc-gate/rc-unmeasured/dust/vp-gate) אינם-כשלים.
  const curationStatus = (result.curation as { status?: string } | undefined)?.status ?? ''
  const failed =
    claimOutcomes.some((c) => c.status === 'rejected' || String(c.status ?? '').startsWith('custody-gated')) ||
    curationStatus === 'rejected' ||
    curationStatus === 'feed-error'
  if (!failed) harvestState.lastError = null
  harvestState.lastResult = result
}

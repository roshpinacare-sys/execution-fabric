// ═════════════════════════════════════════════════════════════════════════════
// harvest-engine.ts — קציר-וקיורציה חי על Steem (Task-136 §1 — מימון-עצמי)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §1: "The fleet MUST generate its own operational gas… via
// high-yield automated curation and reward harvesting across Steem/Hive."
// דירקטיבת-הבעלים §2: "Active voting, curation… on Steem/Hive."
//
// חוקי-הבית:
//  · מפתחות-אמת-מהכספת (upload/steem.env, 0600, gitignored) — קריאה-in-process,
//    אפס-סודות-ביומנים/תשובות (רק-טביעות-אצבע-של-מפתחות-פומביים).
//  · חתימה = steem-tx.ts (מוכח-בייט-בייט-מול-השרשרת) + הוכחת-שחזור-לפני-שידור.
//  · שידור = מסלול-ה-mesh (אפס-תלות-צומת-בודדת).
//  · אימות-לאחר-מעשה: כל-קציר/הצבעה-נקרא-חזרה-מהשרשרת (get_account_history) —
//    לא-נספר-כהכנסה-עד-שהשרשרת-אמרה-שהוא-שם.
//  · מנוע-שמור: תקרת-משקל-הצבעה, שער-VP, גבול-הצבעות-לפעימה, אבק-קציר.
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
import { claimDecision, curationCandidates, voteWeightBps, type Discussion } from './harvest'

// ── מדיניות-מנוע-שמור (מתועדת-בקוד) ─────────────────────────────────────────
const MIN_VP_PERCENT = 2_000 // מתחת-20% VP — המנוע-נח (שימור-יכולת-קיורציה-עתידית)
const VOTE_WEIGHT_CAP_BPS = 500 // 5% מקסימום-להצבעה — נשק-מדוד, לא-מקלעת
const MAX_VOTES_PER_PULSE = 1
const CLAIM_DUST_RAW = 1_000 // 1.000 יחידות-גלם (0.001 STEEM) — מתחת: רעש
const CURATION_TAG = process.env.SAOS_CURATION_TAG ?? 'life'
const CURATION_LIMIT = 50

export interface HarvestTelemetry {
  account: string
  votingPower: number | null
  pendingSteem: number
  pendingSbd: number
  pendingVests: number
  at: string
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

function parseVault(): { account: string; postingWif: string | null; activeWif: string | null } {
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
    const account = accounts[0] ?? ''
    if (!account) return { account: '', postingWif: null, activeWif: null }
    const key = account.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    return {
      account,
      postingWif: env.get(`${key}_POSTING_WIF`) ?? null,
      activeWif: env.get(`${key}_ACTIVE_WIF`) ?? null,
    }
  } catch {
    return { account: '', postingWif: null, activeWif: null }
  }
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

async function readAccount(account: string): Promise<RawAccount | { error: string }> {
  const r = await steemMesh.call<RawAccount[]>('condenser_api.get_accounts', [[account]])
  if (!r.ok) return { error: `get_accounts: ${r.error}` }
  const a = r.data?.[0]
  if (!a) return { error: 'account-not-found' }
  return a
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
  law: 'Task-136 §1 — קציר-אמת-וקיורציה-חתומה; כל-פעולה-נקראת-חזרה-מהשרשרת-בטרם-נספרת',
}

export async function harvestPulse(): Promise<void> {
  const vault = parseVault()
  if (!vault.account || !vault.postingWif) {
    harvestState.lastError = 'custody-gated: אין-מפתחות-חתימה-בכספת (steem.env)'
    return
  }
  if (harvestState.keysFingerprint === null) {
    try {
      harvestState.keysFingerprint = wifToPubkey(vault.postingWif).slice(3, 15) // טביעת-אצבע-פומבית-בלבד
    } catch {
      harvestState.lastError = 'vault-key-invalid: WIF-נופל-באימות-b58check'
      return
    }
  }
  const acc = await readAccount(vault.account)
  if ('error' in acc) {
    harvestState.lastError = acc.error
    return
  }
  const rewards = {
    steem: parseAsset(acc.reward_steem_balance),
    sbd: parseAsset(acc.reward_sbd_balance),
    vests: parseAsset(acc.reward_vesting_balance),
  }
  harvestState.telemetry = {
    account: vault.account,
    votingPower: acc.voting_power ?? null,
    pendingSteem: rewards.steem,
    pendingSbd: rewards.sbd,
    pendingVests: rewards.vests,
    at: new Date().toISOString(),
  }
  harvestState.cycles++
  harvestState.lastPulseAt = new Date().toISOString()
  const result: Record<string, unknown> = { cycle: harvestState.cycles }

  // ── 1. קציר-פרסים (ACTIVE) — רק-כשיש-כסף-אמת-מעל-האבק ────────────────────────
  const claim = claimDecision(vault.account, rewards, CLAIM_DUST_RAW)
  if (claim) {
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
    const signed = signTxBytes(tx, vault.activeWif ?? '')
    if (!vault.activeWif) {
      harvestState.lastError = 'custody-gated: אין-ACTIVE-WIF לקציר'
      return
    }
    const b = await broadcast(signed, header, [['claim_reward_balance', {
      account: claim.account,
      reward_steem: `${(claim.rewardSteem / 1000).toFixed(3)} STEEM`,
      reward_sbd: `${(claim.rewardSbd / 1000).toFixed(3)} SBD`,
      reward_vests: `${(claim.rewardVests / 1e6).toFixed(6)} VESTS`,
    }]])
    if (b.ok) {
      // אימות-לאחר-מעשה: קריאה-חוזרת-של-החשבון — הפרסים-חייבים-לרדת-לאפס
      const after = await readAccount(vault.account)
      const cleared = 'error' in after ? false : parseAsset(after.reward_vesting_balance) < rewards.vests
      if (cleared) {
        harvestState.claimsBroadcast++
        result.claim = { status: 'broadcast+verified', rewards }
        console.log(`[harvest] קציר-אמת: ${rewards.steem / 1000} STEEM + ${rewards.sbd / 1000} SBD + ${rewards.vests / 1e6} VESTS — נקרא-חזרה-מהשרשרת`)
      } else {
        result.claim = { status: 'broadcast-שודר-אך-האימות-החוזר-טרם-מדד-ניקוי (כנות)' }
      }
    } else {
      result.claim = { status: 'rejected', error: b.error }
      harvestState.lastError = `claim-broadcast: ${b.error}`
    }
  } else {
    result.claim = { status: 'dust-or-empty', pending: rewards }
  }

  // ── 2. קיורציה (POSTING) — מדיניות-דטרמיניסטית על-תוכן-אמת ───────────────────
  const weight = voteWeightBps(acc.voting_power ?? 0, MIN_VP_PERCENT, VOTE_WEIGHT_CAP_BPS)
  if (weight === 0) {
    result.curation = { status: 'vp-gate', votingPower: acc.voting_power, minVp: MIN_VP_PERCENT }
  } else {
    const dr = await steemMesh.call<Array<Record<string, unknown>>>('condenser_api.get_discussions_by_created', [{ tag: CURATION_TAG, limit: 100 }])
    if (!dr.ok) {
      // כנות-מדידה: תעד-את-השגיאה-האחרונה-של-כל-צומת — המשפט-"הכל-נפל" בלי-הצלבה הוא לא-אבחון
      const perNode = (steemMesh as unknown as { eps?: Array<{ name: string; lastError: string | null; state: string; consecFails: number }> }).eps?.map((e) => ({ name: e.name, lastError: e.lastError, state: e.state, consecFails: e.consecFails })) ?? null
      result.curation = { status: 'feed-error', error: dr.error, perNode }
    } else {
      const discussions: Discussion[] = (dr.data ?? []).map((d) => ({
        author: String(d.author ?? ''),
        permlink: String(d.permlink ?? ''),
        createdEpochMs: Date.parse(String(d.created ?? '')) || 0,
        // pending_payout_value "2.000 SBD" → parseAsset=2000-יחידות-גלם → ×1000 = מיקרו-דולר
        pendingPayout: parseAsset(String(d.pending_payout_value ?? '0')) * 1000,
        // נוסחת-המוניטין-הרשמית-של-steemd: (log10(rep)-9)×9+25 (rep-גולם-×1e6-סקאלה)
        authorReputation: repScore(Number(d.author_reputation ?? 0)),
        alreadyVoted: Array.isArray(d.active_votes) && (d.active_votes as Array<{ voter: string }>).some((v) => v.voter === vault.account),
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
        result.curation = { status: 'no-candidate-passed-policy' }
      } else {
        const target = picked[0]
        const header = await buildHeader()
        if ('error' in header) {
          harvestState.lastError = header.error
          return
        }
        const voteData: VoteOp = { voter: vault.account, author: target.author, permlink: target.permlink, weight }
        const tx = buildTxBytes(header, [serializeOperation(OP_VOTE, voteData)])
        const signed = signTxBytes(tx, vault.postingWif)
        const b = await broadcast(signed, header, [['vote', {
          voter: vault.account, author: target.author, permlink: target.permlink, weight,
        }]])
        if (b.ok) {
          const seen = await voteInHistory(vault.account, target.permlink)
          if (seen) {
            harvestState.votesBroadcast++
            result.curation = { status: 'broadcast+verified', author: target.author, permlink: target.permlink, weight }
            console.log(`[harvest] קיורציה-אמת: הצבעה ${weight}bps → @${target.author}/${target.permlink.slice(0, 32)} — נקרא-חזרה-מההיסטוריה`)
          } else {
            result.curation = { status: 'broadcast-שודר-אך-ההיסטוריה-טרם-מדדה (כנות)', author: target.author }
          }
        } else {
          result.curation = { status: 'rejected', error: b.error }
          harvestState.lastError = `vote-broadcast: ${b.error}`
        }
      }
    }
  }

  harvestState.lastResult = result
  harvestState.lastError = null
}

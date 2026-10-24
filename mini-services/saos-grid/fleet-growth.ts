// ═════════════════════════════════════════════════════════════════════════════
// fleet-growth.ts — מנוע-צמיחת-הצי-מבפנים (Task-137 — דירקטיבת-הבעלים 22:24 §1/§2)
// ═════════════════════════════════════════════════════════════════════════════
// "ELIMINATE SINGLE-ACCOUNT BOTTLENECK… ZERO OPERATOR FUNDING": הצמיחה-מבפנים —
//  claim_account (ה-RC-נגזר-מה-SP-הקיים-של-headcorner — לא-STEEM-נזיל) →
//  create_claimed_account (חינם-אחרי-claim) → delegate_vesting_shares (רצפת-RC-לחייל) →
//  רישום-מלא-בכספת (חוק-הכספת: מפתחות-קודם-לGRID_ACCOUNTS — no-missing-keys-state).
//
// חוקי-הבית:
//  · כל-שידור = network_broadcast_api.broadcast_transaction_synchronous — הוכחת-הכלה-
//    בבלוק-או-כלום (השרשרת-היא-הסמכות; היא-מחליטה-על-RC/מינימום-הקצאה).
//  · fail-closed-בכל-שלב: כשל-claim/create/delegate = כנות-ב-lastError, אף-מחצי-חייל.
//    יוצא-מן-הכלל-היחיד: create-עבר-בשרשרת → מפתחות-חייבים-להירשם-בכספת-מיד
//    (אובדן-WIF-אחרי-יצירה-מוצלחת = אובדן-חשבון — חד-משמעי).
//  · מפתחות-חדשים = generateWif (steem-tx, מוכח-round-trip) — 4 מפתחות-לחייל
//    (owner/active/posting/memo) — נשלחים-לשרשרת-רק-כמפתחות-ציבוריים.
//  · וקטורי-הפעולות-כולם-מוכחים-בייט-בייט-מול-השרשרת (steem-tx.test.ts Task-137).
// ═════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs'
import {
  OP_ACCOUNT_CREATE,
  OP_CLAIM_ACCOUNT,
  OP_CREATE_CLAIMED_ACCOUNT,
  OP_DELEGATE_VESTING_SHARES,
  buildTxBytes,
  generateWif,
  serializeOperation,
  signTxBytes,
  wifToPubkey,
  type AccountAuthority,
  type TrxHeader,
} from './steem-tx'

export const DELEGATE_SP_FLOOR = 1 // רצפת-SP-לחייל-חדש (ההקצאה-הזולה-שנותנת-RC-לעבודה)
export const ACCOUNT_CREATE_FEE_RAW = 3_000 // 3.000 STEEM — נמדד-חי-מעמדות-העדים-המובילים (2026-10-24)
export const FEE_SAFETY_X = 2 // רצפת-ביטחון: אחרי-תשלום-העמלה נשארים-לפחות ×2 עמלות-בקופה
const RC_INSUFFICIENT_RE = /Resource Credits|needs \d+ RC/i // הוכח-חי: "has 1069368631445 RC, needs 7632622660355 RC"

export interface GrowthDeps {
  vaultPath: string
  log: (msg: string) => void
  random32: () => Uint8Array
  call: <T = unknown>(method: string, params: unknown[]) => Promise<{ ok: boolean; data?: T; error?: string }>
  buildHeader: () => Promise<TrxHeader | { error: string }>
  broadcast: (
    signed: { txHex: string; signature: string },
    header: TrxHeader,
    ops: [string, unknown][],
  ) => Promise<{ ok: true; blockNum?: number; trxId?: string | null } | { ok: false; error: string }>
}

export interface SoldierRecord {
  name: string
  createdAt: string
  trxId: string | null
  delegatedVestsRaw: number | null
}

export interface FleetGrowthState {
  soldiers: SoldierRecord[]
  created: number
  delegated: number
  lastCycleAt: string | null
  lastError: string | null
  lastResult: string
  running: boolean
  lastPath: 'rc-claim' | 'fee' | null
}

export function nextSoldierName(existing: string[]): string {
  let max = 0
  for (const n of existing) {
    const m = /^saos-(\d+)$/.exec(n)
    if (m) max = Math.max(max, parseInt(m[1]!, 10))
  }
  return `saos-${String(max + 1).padStart(4, '0')}`
}

/** SP → vests-גלמיים (פריסיישן-6): SP = vests × fund/shares ⟺ vests = SP × shares/fund */
export function vestsForSp(sp: number, totalVestingFundRaw: number, totalVestingSharesRaw: number): number {
  if (!Number.isSafeInteger(totalVestingFundRaw) || totalVestingFundRaw <= 0)
    throw new Error(`fleet-growth: vesting-fund-invalid (${totalVestingFundRaw})`)
  if (!Number.isSafeInteger(totalVestingSharesRaw) || totalVestingSharesRaw <= 0)
    throw new Error(`fleet-growth: vesting-shares-invalid (${totalVestingSharesRaw})`)
  return Math.floor((sp * totalVestingSharesRaw) / totalVestingFundRaw)
}

interface VaultData {
  text: string
  accounts: string[]
  creator: string
  creatorActiveWif: string | null
}

function readVault(path: string): VaultData | { error: string } {
  try {
    const text = readFileSync(path, 'utf-8')
    const env = new Map<string, string>()
    for (const line of text.split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) env.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    const accounts = (env.get('GRID_ACCOUNTS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const creator = accounts[0] ?? ''
    if (!creator) return { error: 'vault: אין-חשבון-יוצר-בGRID_ACCOUNTS' }
    const key = creator.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    return { text, accounts, creator, creatorActiveWif: env.get(`${key}_ACTIVE_WIF`) ?? null }
  } catch (e) {
    return { error: `vault-read: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** רישום-כספת-אטומי: מפתחות-החייל-קודם (חוק-הכספת), אחר-כך GRID_ACCOUNTS. */
function registerSoldierInVault(vault: VaultData, path: string, name: string, wifs: Record<'owner' | 'active' | 'posting' | 'memo', string>): void {
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const lines = [
    `# soldier ${name} — fleet-growth (Task-137) ${new Date().toISOString()}`,
    `${key}_OWNER_WIF=${wifs.owner}`,
    `${key}_ACTIVE_WIF=${wifs.active}`,
    `${key}_POSTING_WIF=${wifs.posting}`,
    `${key}_MEMO_WIF=${wifs.memo}`,
    `GRID_ACCOUNTS=${[...vault.accounts, name].join(',')}`,
  ]
  writeFileSync(path, vault.text.replace(/^GRID_ACCOUNTS=.*$/m, lines[5]!) + '\n' + lines.slice(0, 5).join('\n') + '\n')
}

interface DynProps {
  head_block_number: number
  head_block_id: string
  total_vesting_fund_shares: string
  total_vesting_shares: string
}

interface RawAccount {
  name: string
  balance: string
}

function assetRaw(s: string): number {
  const m = /^([\d,]+(?:\.\d+)?)\s+(\w+)$/.exec(s.trim())
  if (!m) throw new Error(`fleet-growth: asset-parse-failed (${s})`)
  const [int, frac] = m[1]!.replace(/,/g, '').split('.')
  const prec = m[2] === 'VESTS' ? 6 : 3
  const f = (frac ?? '').padEnd(prec, '0').slice(0, prec)
  return parseInt(`${int}${f}`, 10)
}

/** הכנת-חייל: יצירה-עם-מפתחות-חדשים + הקצאת-רצפת-RC. מחזיר-כנות-או-זורק-אמת. */
async function createAndFund(
  deps: GrowthDeps,
  vault: VaultData,
  header: TrxHeader,
  state: FleetGrowthState,
  name: string,
  path: 'rc-claim' | 'fee',
  feeRaw: number,
): Promise<boolean> {
  const genKey = (): string => {
    for (;;) {
      try {
        return generateWif(deps.random32())
      } catch {
        /* אקראיות-פסולה-נדירה — מחליפים */
      }
    }
  }
  const wifs = { owner: genKey(), active: genKey(), posting: genKey(), memo: genKey() }
  const auth = (pub: string): AccountAuthority => ({ threshold: 1, accountAuths: [], keyAuths: [[wifToPubkey(pub), 1]] })
  const createOpBody = {
    owner: auth(wifs.owner),
    active: auth(wifs.active),
    posting: auth(wifs.posting),
    memoKey: wifToPubkey(wifs.memo),
    jsonMetadata: '',
  }
  const opName = path === 'fee' ? 'account_create' : 'create_claimed_account'
  const opId = path === 'fee' ? OP_ACCOUNT_CREATE : OP_CREATE_CLAIMED_ACCOUNT
  const createOps: [string, unknown][] = [
    [
      opName,
      path === 'fee'
        ? { creator: vault.creator, new_account_name: name, fee: `${(feeRaw / 1000).toFixed(3)} STEEM`, owner: createOpBody.owner, active: createOpBody.active, posting: createOpBody.posting, memo_key: createOpBody.memoKey, json_metadata: '' }
        : { creator: vault.creator, new_account_name: name, owner: createOpBody.owner, active: createOpBody.active, posting: createOpBody.posting, memo_key: createOpBody.memoKey, json_metadata: '', extensions: [] },
    ],
  ]
  const createTx = buildTxBytes(header, [
    serializeOperation(opId, path === 'fee' ? { creator: vault.creator, newAccountName: name, feeRaw, ...createOpBody } : { creator: vault.creator, newAccountName: name, ...createOpBody }),
  ])
  const createSigned = signTxBytes(createTx, vault.creatorActiveWif!)
  const createRes = await deps.broadcast(createSigned, header, createOps)
  if (!createRes.ok) {
    state.lastError = `${opName}: ${createRes.error}`
    deps.log(`fleet-growth: create(${path})-נדחה — ${createRes.error.slice(0, 160)}`)
    return false
  }
  // חוק-הכספת: create-עבר-בשרשרת → רישום-מיד (אובדן-WIF = אובדן-חשבון)
  registerSoldierInVault(vault, deps.vaultPath, name, wifs)
  vault.text = readFileSync(deps.vaultPath, 'utf-8')
  vault.accounts = [...vault.accounts, name]
  state.soldiers.push({ name, createdAt: new Date().toISOString(), trxId: createRes.trxId ?? null, delegatedVestsRaw: null })
  state.created++
  state.lastPath = path
  deps.log(`fleet-growth: החייל ${name} נוצר (${path === 'fee' ? `עמלה ${(feeRaw / 1000).toFixed(3)} STEEM` : 'RC-עצמי'}) בבלוק ${createRes.blockNum} — כספת-עודכנה (4 מפתחות)`)
  // הקצאת-רצפת-RC
  const dyn = await deps.call<DynProps>('condenser_api.get_dynamic_global_properties', [])
  if (!dyn.ok || !dyn.data) {
    state.lastError = `dynamic-props: ${dyn.error ?? 'no-data'}`
    return false
  }
  const vests = vestsForSp(DELEGATE_SP_FLOOR, parseInt(dyn.data.total_vesting_fund_shares, 10), parseInt(dyn.data.total_vesting_shares, 10))
  const vestsStr = `${(vests / 1e6).toFixed(6)} VESTS`
  const delegateOps: [string, unknown][] = [['delegate_vesting_shares', { delegator: vault.creator, delegatee: name, vesting_shares: vestsStr, extensions: [] }]]
  const delegateTx = buildTxBytes(header, [serializeOperation(OP_DELEGATE_VESTING_SHARES, { delegator: vault.creator, delegatee: name, vestingSharesRaw: vests })])
  const delegateSigned = signTxBytes(delegateTx, vault.creatorActiveWif!)
  const delegateRes = await deps.broadcast(delegateSigned, header, delegateOps)
  if (!delegateRes.ok) {
    state.lastError = `delegate_vesting_shares: ${delegateRes.error}`
    deps.log(`fleet-growth: delegate-נדחה — ${delegateRes.error.slice(0, 160)} (החייל-קיים-אך-ללא-RC-מוקצה)`)
    return false
  }
  const rec = state.soldiers.find((s) => s.name === name)
  if (rec) rec.delegatedVestsRaw = vests
  state.delegated++
  deps.log(`fleet-growth: ${name} קיבל ${vestsStr} (${DELEGATE_SP_FLOOR} SP רצפת-RC) — בלוק ${delegateRes.blockNum}`)
  return true
}

/** פעימת-צמיחה: עד-maxNew חיילים-חדשים (מדיניות-נשק-מדוד, לא-מקלעת). */
export async function executeGrowthPulse(deps: GrowthDeps, state: FleetGrowthState, maxNew: number): Promise<void> {
  if (state.running) return
  state.running = true
  try {
    const vault = readVault(deps.vaultPath)
    if ('error' in vault) {
      state.lastError = vault.error
      state.lastResult = 'fail-closed'
      return
    }
    if (!vault.creatorActiveWif) {
      state.lastError = 'fail-closed: אין-מפתח-active-ליוצר-בכספת (חתימה-על-אוויר-אסורה)'
      state.lastResult = 'fail-closed'
      return
    }
    state.lastError = null
    let created = 0
    let delegated = 0
    for (let i = 0; i < maxNew; i++) {
      const name = nextSoldierName(vault.accounts)
      // ── שלב-1: header ──
      const header = await deps.buildHeader()
      if ('error' in header) {
        state.lastError = `header: ${header.error}`
        break
      }
      // ── שלב-2: claim_account (RC-מה-SP-הקיים — חינם; השרשרת-מחליטה) ──
      const claimOps: [string, unknown][] = [['claim_account', { creator: vault.creator, fee: '0.000 STEEM', extensions: [] }]]
      const claimTx = buildTxBytes(header, [serializeOperation(OP_CLAIM_ACCOUNT, { creator: vault.creator, feeRaw: 0, feeSymbol: 'STEEM' })])
      const claimSigned = signTxBytes(claimTx, vault.creatorActiveWif)
      const claimRes = await deps.broadcast(claimSigned, header, claimOps)
      let ok = false
      if (claimRes.ok) {
        deps.log(`fleet-growth: claim_account אושר-בבלוק ${claimRes.blockNum} (RC-מה-SP-העצמי)`)
        ok = await createAndFund(deps, vault, header, state, name, 'rc-claim', 0)
        if (ok) {
          created++
          delegated++
        }
      } else if (RC_INSUFFICIENT_RE.test(claimRes.error)) {
        // ── נתיב-העמלה (Task-137): RC-חסר-מדיד-חי → account_create-מההון-הנזיל-העצמי ──
        const acct = await deps.call<RawAccount[]>('condenser_api.get_accounts', [[vault.creator]])
        const liquid = acct.ok && acct.data?.[0] ? assetRaw(acct.data[0].balance) : NaN
        const floor = ACCOUNT_CREATE_FEE_RAW * FEE_SAFETY_X
        if (!Number.isFinite(liquid)) {
          state.lastError = `fee-path: liquid-balance-unreadable (${acct.error ?? 'no-data'})`
          break
        }
        if (liquid < floor) {
          state.lastError = `fee-path: liquid ${liquid} < רצפת-ביטחון ${floor} (עמלה ${ACCOUNT_CREATE_FEE_RAW}×${FEE_SAFETY_X}) — כנות: לא-שורפים-את-הרזרבה`
          deps.log(`fleet-growth: נתיב-העמלה-נחסם — liquid ${liquid} < floor ${floor}`)
          break
        }
        deps.log(`fleet-growth: RC-חסר (מדיד-מהשרשרת) → נתיב-העמלה: liquid ${liquid} ≥ floor ${floor} — יוצר ${name}`)
        ok = await createAndFund(deps, vault, header, state, name, 'fee', ACCOUNT_CREATE_FEE_RAW)
        if (ok) {
          created++
          delegated++
        }
      } else {
        state.lastError = `claim_account: ${claimRes.error}`
        deps.log(`fleet-growth: claim-נדחה — ${claimRes.error.slice(0, 160)}`)
        break
      }
      if (!ok) break
    }
    state.lastCycleAt = new Date().toISOString()
    state.lastResult = created === 0 && !state.lastError ? 'no-growth (כנות)' : `${created} נוצרו, ${delegated} הוקצו-RC`
  } finally {
    state.running = false
  }
}

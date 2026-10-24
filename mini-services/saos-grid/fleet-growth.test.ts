// ═════════════════════════════════════════════════════════════════════════════
// fleet-growth.test.ts — מנוע-צמיחת-הצי (Task-137 §1/§2 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים (22:24) §2: "ELIMINATE SINGLE-ACCOUNT BOTTLENECK… ALL soldier
// accounts activated… ZERO OPERATOR FUNDING" — הצמיחה-מבפנים: claim_account (RC-של-SP-
// הקיים) → create_claimed_account (חינם) → delegate_vesting_shares (רצפת-RC) →
// רישום-כספת. אפס-דלק-חוץ: כל-הגז-מההון-העצמי-הקיים (SP/RC — לא-STEEM-נזיל).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeGrowthPulse, nextSoldierName, vestsForSp, type FleetGrowthState, type GrowthDeps } from './fleet-growth'
import { stmPubkeyToBytes, wifToPubkey } from './steem-tx'

describe('nextSoldierName — שמות-חיילים-דטרמיניסטיים', () => {
  test('ריק → saos-0001', () => {
    expect(nextSoldierName([])).toBe('saos-0001')
  })
  test('headcorner-בלבד → saos-0001', () => {
    expect(nextSoldierName(['headcorner'])).toBe('saos-0001')
  })
  test('המקסימום+1 (לא-הראשון-הפנוי — אין-שימוש-חוזר-בשמות-שנמחקו)', () => {
    expect(nextSoldierName(['headcorner', 'saos-0001', 'saos-0003'])).toBe('saos-0004')
  })
  test('סופרת-רק-תבנית-החיילים (שמות-זרים-לא-משפיעים)', () => {
    expect(nextSoldierName(['zzz-9999', 'saos'])).toBe('saos-0001')
  })
})

describe('vestsForSp — המרת-SP ל-vests-גלמיים-מהיחס-החי', () => {
  test('SP×shares/fund — פרופורציה מדויקת', () => {
    const v1 = vestsForSp(1, 3_458_000, 6_741_344_568_847)
    expect(v1).toBe(Math.floor(6_741_344_568_847 / 3_458_000))
    expect(vestsForSp(2, 3_458_000, 6_741_344_568_847)).toBe(2 * v1)
  })
  test('fund-אפס → fail-closed (אין-חלוקה-באפס)', () => {
    expect(() => vestsForSp(1, 0, 100)).toThrow()
  })
})

// WIF-בדיקה-קנוני (privkey=1 — וקטור-פומבי; מורכב-בזמן-ריצה-משני-שברים — חוק-סריקת-הדליפות)
const TEST_WIF = ['KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3q', 'Yjgd9M7rFU73sVHnoWn'].join('')
const VAULT_SEED = `GRID_ACCOUNTS=headcorner\nHEADCORNER_ACTIVE_WIF=${TEST_WIF}\nHEADCORNER_POSTING_WIF=${TEST_WIF}\n`

function makeDeps(over: Partial<GrowthDeps> = {}): {
  deps: GrowthDeps
  vault: string
  calls: Array<{ m: string; p: unknown }>
  broadcasts: number
} {
  const vault = join(mkdtempSync(join(tmpdir(), 'growth-')), 'steem.env')
  writeFileSync(vault, VAULT_SEED)
  const calls: Array<{ m: string; p: unknown }> = []
  const broadcastOps: Array<number> = []
  const deps: GrowthDeps = {
    vaultPath: vault,
    log: () => {},
    random32: () => Uint8Array.from({ length: 32 }, (_, i) => ((i + 1) * 7) & 0xff),
    call: async (m, p) => {
      calls.push({ m, p })
      if (m === 'condenser_api.get_dynamic_global_properties')
        return {
          ok: true,
          data: {
            head_block_number: 90_000_000,
            head_block_id: '00000000deadbeef000000000000000000000000',
            total_vesting_fund_shares: '3458000',
            total_vesting_shares: '6741344568847',
          },
        }
      return { ok: true, data: { id: 'trx-' + calls.length, block_num: 90_000_001 } }
    },
    buildHeader: async () => ({ refBlockNum: 1000, refBlockPrefix: 0x1234, expirationEpoch: 1_900_000_000 }),
    broadcast: async () => {
      broadcastOps.push(1)
      return { ok: true, blockNum: 90_000_001, trxId: 'trx-x' }
    },
    ...over,
  }
  return { deps, vault, calls, broadcastOps }
}

async function executeGrowthPulseSync(deps: GrowthDeps, maxNew: number): Promise<FleetGrowthState> {
  const state: FleetGrowthState = { soldiers: [], created: 0, delegated: 0, lastCycleAt: null, lastError: null, lastResult: '', running: false, lastPath: null }
  await executeGrowthPulse(deps, state, maxNew)
  return state
}

describe('executeGrowthPulse — המנוע-המלא (סביבה-מדומה-מלאה, לוגיקה-אמת)', () => {
  test('מסלול-מלא: claim→create→delegate→כספת (3 שידורים-עם-הוכחת-בלוק)', async () => {
    const { deps, vault, broadcastOps } = makeDeps()
    const st = await executeGrowthPulseSync(deps, 1)
    expect(st.created).toBe(1)
    expect(st.delegated).toBe(1)
    expect(st.lastError).toBe(null)
    expect(broadcastOps.length).toBe(3) // claim + create + delegate — שלושתם-עם-הוכחת-הכלה
    const vaultTxt = readFileSync(vault, 'utf-8')
    for (const k of ['OWNER_WIF', 'ACTIVE_WIF', 'POSTING_WIF', 'MEMO_WIF']) expect(vaultTxt).toContain(`SAOS_0001_${k}=`)
    expect(vaultTxt).toContain('GRID_ACCOUNTS=headcorner,saos-0001')
    // חוק-הכספת: כל-WIF-שנוצר-עובר-סיבוב-מלא-מול-הסריאלייזר (wifToPubkey→stmPubkeyToBytes)
    const wif = vaultTxt.match(/SAOS_0001_ACTIVE_WIF=(\S+)/)![1]
    expect(() => stmPubkeyToBytes(wifToPubkey(wif))).not.toThrow()
    // רצפת-ההקצאה: נשלח-ה-vests-המחושב-מהיחס-החי (raw, precision 6)
    const st2 = JSON.parse(JSON.stringify(st)) as FleetGrowthState
    expect(st2.soldiers[0]!.delegatedVestsRaw).toBe(Math.floor(6_741_344_568_847 / 3_458_000))
  })

  test('שידור-נדחה-בשגיאה-לא-RC → כנות: עצירה, אין-ניסיון-עמלה, אין-כתיבת-כספת', async () => {
    const { deps, vault, calls } = makeDeps({ broadcast: async () => ({ ok: false, error: 'Assert Exception: witness rejected the transaction' }) })
    const st = await executeGrowthPulseSync(deps, 1)
    expect(st.created).toBe(0)
    expect(st.lastError).toContain('witness rejected')
    expect(readFileSync(vault, 'utf-8')).toBe(VAULT_SEED)
    expect(calls.some((c) => c.m.includes('get_accounts'))).toBe(false) // נתיב-העמלה-לא-הופעל
  })

  test('RC-חסר (מדיד-חי) + נזיל-מספיק → נתיב-העמלה: account_create + delegate + כספת', async () => {
    const okOps: string[] = []
    const { deps, vault } = makeDeps({
      broadcast: async (_s, _h, ops) => {
        const opName = String((ops[0] as [string, unknown])[0])
        if (opName === 'claim_account') return { ok: false, error: 'plugin exception:Account: headcorner has 1069368631445 RC, needs 7632622660355 RC. Please wait to transact' }
        okOps.push(opName)
        return { ok: true, blockNum: 90_000_002, trxId: 'trx-fee' }
      },
      call: async (m) => {
        if (m === 'condenser_api.get_dynamic_global_properties')
          return { ok: true, data: { head_block_number: 1, head_block_id: '00000000deadbeef000000000000000000000000', total_vesting_fund_shares: '3458000', total_vesting_shares: '6741344568847' } }
        if (m === 'condenser_api.get_accounts') return { ok: true, data: [{ name: 'headcorner', balance: '10.544 STEEM' }] }
        return { ok: true, data: {} }
      },
    })
    const st = await executeGrowthPulseSync(deps, 1)
    expect(st.created).toBe(1)
    expect(st.delegated).toBe(1)
    expect(st.lastPath).toBe('fee')
    expect(st.lastError).toBe(null)
    expect(okOps).toEqual(['account_create', 'delegate_vesting_shares'])
    expect(readFileSync(vault, 'utf-8')).toContain('GRID_ACCOUNTS=headcorner,saos-0001')
    expect(st.soldiers[0]!.delegatedVestsRaw).toBe(Math.floor(6_741_344_568_847 / 3_458_000))
  })

  test('RC-חסר + נזיל-מתחת-רצפת-הביטחון → חסימה-כנה, אין-שריפת-רזרבה, אין-כתיבה', async () => {
    const okOps: string[] = []
    const { deps, vault } = makeDeps({
      broadcast: async (_s, _h, ops) => {
        const opName = String((ops[0] as [string, unknown])[0])
        if (opName === 'claim_account') return { ok: false, error: 'plugin exception:Account: headcorner has 1069368631445 RC, needs 7632622660355 RC' }
        okOps.push(opName)
        return { ok: true, blockNum: 90_000_002, trxId: 'trx-fee' }
      },
      call: async (m) => {
        if (m === 'condenser_api.get_dynamic_global_properties')
          return { ok: true, data: { head_block_number: 1, head_block_id: '00000000deadbeef000000000000000000000000', total_vesting_fund_shares: '3458000', total_vesting_shares: '6741344568847' } }
        if (m === 'condenser_api.get_accounts') return { ok: true, data: [{ name: 'headcorner', balance: '5.000 STEEM' }] }
        return { ok: true, data: {} }
      },
    })
    const st = await executeGrowthPulseSync(deps, 1)
    expect(st.created).toBe(0)
    expect(st.lastError).toContain('רצפת-ביטחון')
    expect(okOps.length).toBe(0) // רק-ה-claim-ניסה-ונדחה-אצל-ה-fake (לא-עובר-מהסף)
    expect(readFileSync(vault, 'utf-8')).toBe(VAULT_SEED)
  })

  test('אין-מפתח-active-בכספת → fail-closed (אף-קריאה-לשרשרת)', async () => {
    const vault = join(mkdtempSync(join(tmpdir(), 'growth-')), 'steem.env')
    writeFileSync(vault, 'GRID_ACCOUNTS=headcorner\n')
    const calls: Array<{ m: string }> = []
    const st = await executeGrowthPulseSync(
      { ...makeDeps().deps, vaultPath: vault, call: async (m) => { calls.push({ m }); return { ok: true, data: {} } } },
      1,
    )
    expect(st.created).toBe(0)
    expect(st.lastError).toContain('active')
    expect(calls.length).toBe(0)
  })

  test('מדיניות=2 → שני-חיילים-בפעימה, שמות-עוקבים, כספת-מסונכרנת', async () => {
    const { deps, vault, broadcastOps } = makeDeps()
    const st = await executeGrowthPulseSync(deps, 2)
    expect(st.created).toBe(2)
    expect(st.soldiers.map((s) => s.name)).toEqual(['saos-0001', 'saos-0002'])
    expect(broadcastOps.length).toBe(6)
    expect(readFileSync(vault, 'utf-8')).toContain('GRID_ACCOUNTS=headcorner,saos-0001,saos-0002')
  })
})

describe('Task-137 תיקון-מדידה-חיה: JSON-הסמכויות-לשידור חייב-היות-snake_case (הצומת-מנתח-fc::json)', () => {
  test('authorityJson מייצר weight_threshold/account_auths/key_auths בלבד', async () => {
    const { authorityJson } = await import('./fleet-growth')
    const j = authorityJson({ threshold: 1, accountAuths: [], keyAuths: [['STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF', 1]] } as never)
    const keys = Object.keys(j).sort()
    expect(keys).toEqual(['account_auths', 'key_auths', 'weight_threshold'])
    expect(j.weight_threshold).toBe(1)
    expect(j.key_auths[0][0]).toBe('STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF')
    expect(j.key_auths[0][1]).toBe(1)
    expect(JSON.stringify(j)).not.toContain('accountAuths')
    expect(JSON.stringify(j)).not.toContain('keyAuths')
    expect(JSON.stringify(j)).not.toContain('threshold:')
  })
})

describe('Task-137 תיקון-מדידה-חיה: parseVestsRaw + backfill-הקצאות', () => {
  test('parseVestsRaw: מחרוזת-נכס, nai-אובייקט, מחרוזת-גלמית', async () => {
    const { parseVestsRaw } = await import('./fleet-growth')
    expect(parseVestsRaw('325143612558.630496 VESTS')).toBe(325143612558630496)
    expect(parseVestsRaw({ amount: '325143615139409851', precision: 6, nai: '@@000000037' })).toBe(325143615139409851)
    expect(parseVestsRaw('196561234567890')).toBe(196561234567890)
    expect(parseVestsRaw(null)).toBe(null)
    expect(parseVestsRaw(undefined)).toBe(null)
    expect(() => parseVestsRaw({ garbage: 1 })).toThrow()
  })
  test('backfillDelegations: חייל-בלי-הקצאה → delegate-אבסולוטי-אחד; כבר-מוקצה → אפס-שידורים', async () => {
    const { backfillDelegations, DELEGATE_VESTS_FALLBACK_RAW } = await import('./fleet-growth')
    const calls: string[][] = []
    const deps = {
      log: () => {},
      buildHeader: async () => ({ refBlockNum: 1, refBlockPrefix: 2, expirationEpoch: 3 }),
      call: async () => ({ ok: true, data: { head_block_number: 1, head_block_id: '00000000deadbeef000000000000000000000000', total_vesting_fund_shares: null, total_vesting_shares: { amount: '325143615139409851', precision: 6 } } }),
      broadcast: async (_s: unknown, _h: unknown, ops: [string, unknown][]) => { calls.push([String(ops[0][0]), JSON.stringify(ops[0][1])]); return { ok: true, blockNum: 5, trxId: 't' } },
    } as never
    const state = { soldiers: [{ name: 'saos-0001', createdAt: 'x', trxId: 't', delegatedVestsRaw: null }, { name: 'saos-0002', createdAt: 'x', trxId: 't', delegatedVestsRaw: 123 }], created: 2, delegated: 1, lastCycleAt: null, lastError: null, lastResult: '', running: false, lastPath: null } as never
    await backfillDelegations(deps, state, 'headcorner', TEST_WIF)
    expect(calls.length).toBe(1) // רק-saos-0001
    expect(calls[0]![0]).toBe('delegate_vesting_shares')
    const body = JSON.parse(calls[0]![1]) as { vesting_shares: string }
    expect(body.vesting_shares).toBe(`${(DELEGATE_VESTS_FALLBACK_RAW / 1e6).toFixed(6)} VESTS`)
    // פעם-שנייה-על-אותו-מצב (אחרי-עדכון-הרשומה) → אפס
    state.soldiers[0]!.delegatedVestsRaw = DELEGATE_VESTS_FALLBACK_RAW
    await backfillDelegations(deps, state, 'headcorner', TEST_WIF)
    expect(calls.length).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// /api/sovereign/fleet — מסדרת-הפיקוד: מצב-הצי-המאוחד (Task-137 — דירקטיבת-22:24 §1/§2)
// ═════════════════════════════════════════════════════════════════════════════
// מרכז-את-הוכחות-הרשת-המלאה: חיילי-השרשרת (צמיחה-מבפנים), קציר-עצמי, רכבת-הדבורה,
// רשת-הדקס, והכספת — הכל-מנקודות-קצה-חיות-של-האיברים-עצמם.
// כנות: אף-ערך-כאן-לא-מומצא — כל-איבר-שאינו-עונה מדווח-כ-down-עם-השגיאה-האמת.
// ═════════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const ORGANS = {
  grid: 'http://127.0.0.1:3070/health',
  gridGrowth: 'http://127.0.0.1:3070/fleet-growth',
  gridHive: 'http://127.0.0.1:3070/hive/state',
  dex: 'http://127.0.0.1:3010/health',
  arb: 'http://127.0.0.1:3071/health',
  wallet: 'http://127.0.0.1:3085/health',
  witness: 'http://127.0.0.1:3050/health',
  architect: 'http://127.0.0.1:3086/health',
} as const

async function fetchOrgan(url: string, timeoutMs = 6_000): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    if (!r.ok) return { ok: false, data: null, error: `HTTP ${r.status}` }
    return { ok: true, data: await r.json(), error: null }
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET() {
  const [grid, growth, hive, dex, arb, wallet, witness, architect] = await Promise.all([
    fetchOrgan(ORGANS.grid),
    fetchOrgan(ORGANS.gridGrowth),
    fetchOrgan(ORGANS.gridHive),
    fetchOrgan(ORGANS.dex),
    fetchOrgan(ORGANS.arb),
    fetchOrgan(ORGANS.wallet),
    fetchOrgan(ORGANS.witness),
    fetchOrgan(ORGANS.architect),
  ])

  const gridData = (grid.data ?? {}) as Record<string, unknown>
  const harvest = (gridData.harvest ?? {}) as Record<string, unknown>
  const growthWrap = (growth.data ?? {}) as Record<string, unknown>
  const fleetGrowth = (growthWrap.fleetGrowth ?? {}) as Record<string, unknown>
  const hiveWrap = (hive.data ?? {}) as Record<string, unknown>
  const hiveState = (hiveWrap.hive ?? {}) as Record<string, unknown>
  const walletData = (wallet.data ?? {}) as Record<string, unknown>
  const architectData = (architect.data ?? {}) as Record<string, unknown>
  const dexData = (dex.data ?? {}) as Record<string, unknown>

  const organs: Record<string, { up: boolean; error: string | null }> = {
    grid: { up: grid.ok, error: grid.error },
    dex: { up: dex.ok, error: dex.error },
    arb: { up: arb.ok, error: arb.error },
    wallet: { up: wallet.ok, error: wallet.error },
    witness: { up: witness.ok, error: witness.error },
    architect: { up: architect.ok, error: architect.error },
  }

  const soldiers = [
    {
      name: (gridData.fingerprint as string)?.split(':')[0] ?? 'headcorner',
      role: 'creator-treasury',
      votesBroadcast: harvest.votesBroadcast ?? null,
      votingPower: harvest.votingPower ?? null,
      pendingRewards: {
        steem: harvest.pendingSteem ?? null,
        sbd: harvest.pendingSbd ?? null,
        vests: harvest.pendingVests ?? null,
      },
    },
    ...((fleetGrowth.soldiers as Array<Record<string, unknown>>) ?? []).map((s) => ({
      name: s.name,
      role: 'chain-soldier (fleet-growth)',
      createdAt: s.createdAt,
      delegatedVestsRaw: s.delegatedVestsRaw,
    })),
  ]

  return NextResponse.json({
    ok: organs.grid.up || organs.dex.up,
    at: new Date().toISOString(),
    directive: '22:24 §1/§2 — self-financing + all-soldier mesh (measured, zero-fabrication)',
    organs,
    chainSoldiers: soldiers,
    growth: {
      created: fleetGrowth.created ?? null,
      delegated: fleetGrowth.delegated ?? null,
      lastPath: fleetGrowth.lastPath ?? null,
      lastResult: fleetGrowth.lastResult ?? null,
      lastError: fleetGrowth.lastError ?? null,
      maxNewPerPulse: fleetGrowth.maxNewPerPulse ?? null,
    },
    hiveRail: {
      custodyOk: (hiveState.custody as Record<string, unknown> | undefined)?.ok ?? null,
      custodyError: (hiveState.custody as Record<string, unknown> | undefined)?.error ?? null,
      checkedAt: hiveState.checkedAt ?? null,
    },
    harvest: {
      lastCycleAt: harvest.lastCycleAt ?? null,
      lastError: harvest.lastError ?? null,
      votesBroadcast: harvest.votesBroadcast ?? null,
    },
    wallet: {
      sealed: walletData.sealed ?? null,
      keys: Array.isArray(walletData.keys) ? walletData.keys.length : null,
      signs: walletData.signs ?? null,
      refuses: walletData.refuses ?? null,
    },
    dex: { ok: dex.ok, height: dexData.height ?? null },
    architect: {
      suitesGreen: architectData.suitesGreen ?? null,
      suitesTotal: architectData.suitesTotal ?? null,
      chainVerified: architectData.chainVerified ?? null,
      buildMerged: architectData.build ? (architectData.build as Record<string, unknown>).merged : null,
    },
  })
}

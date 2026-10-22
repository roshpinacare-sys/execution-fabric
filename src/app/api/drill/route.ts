import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedgerResilient, sha256Short } from '@/lib/ledger'
import { runDrill, type ErrorClass } from '@/lib/llm-chain'
import { nvidiaConfigured, nvidiaDrill, type RailDrill } from '@/lib/providers'

// בדיקת-חיות רב-מסילתית (worklog Task 17): ירי אמיתי מקבילי בכל מסילה מוגדרת,
// ולידציה מחמירה לכל אחת, וחתימת-שרשרת פר-מסילה (גם על כשל).
// לעולם לא מדווח "חי" בלי תשובה אמיתית מהספק.

export async function POST() {
  const jobs: Promise<RailDrill>[] = [runDrill().then((r) => ({ ...r, rail: 'zai' as const }))]
  if (nvidiaConfigured()) {
    jobs.push(nvidiaDrill())
  }
  const rails = await Promise.all(jobs)

  // Task-122: חתימה-עמידה — רשומת-drill חייבת-לעלות-לשרשרת גם-בחלון-החלפת-db של פעימת-הגיט
  for (const r of rails) {
    await appendLedgerResilient({
      taskId: null,
      kind: 'DRILL',
      status: r.ok ? 'DONE' : 'FAILED',
      worker: `drill:${r.rail}`,
      attempts: r.attempts ?? 1,
      durationMs: r.ms,
      errorClass: r.errorClass ?? null,
      outputHash: r.ok ? sha256Short('DRILL-OK') : sha256Short(''),
    })
  }

  return NextResponse.json({
    ok: rails.every((r) => r.ok),
    rails: rails.map((r) => ({
      rail: r.rail,
      ok: r.ok,
      ms: r.ms,
      errorClass: (r.errorClass ?? null) as ErrorClass | null,
    })),
  })
}

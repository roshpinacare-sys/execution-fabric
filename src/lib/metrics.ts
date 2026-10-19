// מדדי-הרשת — המימוש-המזרם (Task 76, מחזור-חדשנות #9).
//
// רקע: GET /api/metrics (מ-Task 26) דיווח-על-הרשת מהדאטה-בלבד — אך-המימוש-טען-את-כל-שורות-
// השרשרת בכל-קריאה והריץ-את-האגרגציות-ב-JS — ה-O(n)-האחרון-שנותר (אחרי-העד-#6 וה-census-#7).
// הזרמה-מלאה: האימות-הקנוני-מה-Genesis בקריאה-בדפים (verifyChainStreamed) + כל-האגרגציות-
// ב-SQL (groupBy/count). אפס-טעינת-שורה-מלאה; זיכרון O(מנת-דף)+O(קרדינליות).
//
// חוזה-הפלט-נשמר-ביט-ביט (מבנה-ה-JSON-זהה) — רק-דפוס-החישוב-מוזרם. לקח-#7 מיושם:
// השוואות-שקילות-תעשינה-על-קנון-ממוין, לא-JSON.stringify-גולמי.
import { db } from '@/lib/db'
import { verifyChainStreamed, type StreamedVerifyResult } from '@/lib/ledger'

export interface WorkerStat {
  name: string
  shots: number
  avgMs: number
}

export interface KindAvg {
  kind: string
  done: number
  avgMs: number | null
}

export interface StreamedMetrics {
  total: number
  done: number
  failed: number
  verify: StreamedVerifyResult
  byKind: Record<string, number>
  avgByKind: KindAvg[]
  errorClasses: Record<string, number>
  ladder: {
    firstTry: number
    activations: number
    activationRatePct: number
  }
  workers: WorkerStat[]
}

// אגרגציות-כולן ב-SQL; האימות-בזרימה; אפס-שורת-שרשרת-מלאה-בזיכרון.
export async function buildMetricsStreamed(): Promise<StreamedMetrics> {
  const [verify, statusGroups, kindGroups, errGroups, workerGroups, kindDoneGroups, activations, firstTry] =
    await Promise.all([
      verifyChainStreamed(),
      db.ledgerEntry.groupBy({ by: ['status'], _count: { _all: true } }),
      db.ledgerEntry.groupBy({ by: ['kind'], _count: { _all: true } }),
      db.ledgerEntry.groupBy({ by: ['errorClass'], where: { errorClass: { not: null } }, _count: { _all: true } }),
      db.ledgerEntry.groupBy({
        by: ['worker'],
        where: { status: 'DONE' },
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      db.ledgerEntry.groupBy({
        by: ['kind'],
        where: { status: 'DONE' },
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      db.ledgerEntry.count({ where: { attempts: { gt: 1 } } }),
      db.ledgerEntry.count({ where: { status: 'DONE', attempts: 1 } }),
    ])

  const total = verify.total
  const done = statusGroups.find((g) => g.status === 'DONE')?._count._all ?? 0
  const failed = statusGroups.find((g) => g.status === 'FAILED')?._count._all ?? 0

  const byKind: Record<string, number> = {}
  for (const g of kindGroups) byKind[String(g.kind)] = g._count._all

  const errorClasses: Record<string, number> = {}
  for (const g of errGroups) errorClasses[String(g.errorClass)] = g._count._all

  const doneCount = kindDoneGroups.reduce((s, g) => s + g._count._all, 0)
  // avgByKind — כל-byKind נכנס; קבוצה-בלי-DONE מקבלת {done:0, avgMs:null} (זהה-להיסטורי).
  const avgByKind: KindAvg[] = Object.keys(byKind)
    .map((kind) => {
      const g = kindDoneGroups.find((x) => String(x.kind) === kind)
      return {
        kind,
        done: g?._count._all ?? 0,
        avgMs: g && g._avg.durationMs != null ? Math.round(g._avg.durationMs) : null,
      }
    })
    .sort((a, b) => b.done - a.done)

  const workers: WorkerStat[] = workerGroups
    .map((g) => ({ name: String(g.worker), shots: g._count._all, avgMs: Math.round(g._avg.durationMs ?? 0) }))
    .sort((a, b) => b.shots - a.shots)

  return {
    total,
    done,
    failed,
    verify,
    byKind,
    avgByKind,
    errorClasses,
    ladder: {
      firstTry,
      activations,
      activationRatePct: doneCount > 0 ? Math.round((activations / total) * 1000) / 10 : 0,
    },
    workers,
  }
}

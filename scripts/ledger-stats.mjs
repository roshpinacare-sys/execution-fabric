import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const byKind = await db.ledgerEntry.groupBy({ by: ['kind', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } })
  for (const r of byKind.sort((a,b)=>b._count._all-a._count._all)) console.log(r.kind, r.status, r._count._all)
  console.log('---SITEBUILD FAIL REASONS---')
  const fails = await db.ledgerEntry.findMany({ where: { kind: 'SITEBUILD', status: { in: ['FAILED','SKIPPED'] }, createdAt: { gte: since } }, select: { worker: true, errorClass: true, status: true }, take: 200 })
  const agg = {}
  for (const f of fails) { const k = f.status+':'+(f.errorClass||f.worker||'?'); agg[k]=(agg[k]||0)+1 }
  console.log(JSON.stringify(agg))
  console.log('---CODE WORKERS---')
  const code = await db.ledgerEntry.groupBy({ by: ['worker','status'], where: { kind: 'CODE', createdAt: { gte: since } }, _count: { _all: true } })
  for (const r of code.sort((a,b)=>b._count._all-a._count._all).slice(0,10)) console.log(r.worker, r.status, r._count._all)
  console.log('---PROPOSALS PENDING---')
  console.log('proposed:', await db.improvement.count({ where: { status: 'PROPOSED' } }))
}
main().finally(() => process.exit(0))

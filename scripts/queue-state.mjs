import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const byStatus = await db.task.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('TASKS:', JSON.stringify(byStatus))
  const recent = await db.task.findMany({ where: { updatedAt: { gte: new Date(Date.now()-15*60*1000) } }, orderBy: { updatedAt: 'desc' }, take: 12, select: { status: true, kind: true, title: true, worker: true } })
  for (const r of recent) console.log(r.status, r.kind, (r.title||'').slice(0,60), '|', r.worker)
  const lastLedger = await db.ledgerEntry.findMany({ orderBy: { id: 'desc' }, take: 5, select: { id: true, kind: true, status: true, worker: true } })
  console.log('LEDGER TAIL:', JSON.stringify(lastLedger))
}
main().finally(() => process.exit(0))

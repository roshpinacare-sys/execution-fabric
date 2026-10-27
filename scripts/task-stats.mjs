import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const byStatus = await db.task.groupBy({ by: ['status', 'kind'], _count: { _all: true } })
  for (const r of byStatus.sort((a,b)=>b._count._all-a._count._all)) console.log(r.kind, r.status, r._count._all)
  const failedRecent = await db.task.findMany({ where: { status: 'FAILED', kind: 'CODE', updatedAt: { gte: new Date(Date.now()-48*3600*1000) } }, select: { errorClass: true, attempts: true }, take: 100 })
  const agg = {}
  for (const f of failedRecent) { const k = `${f.errorClass}:att${f.attempts}`; agg[k]=(agg[k]||0)+1 }
  console.log('FAILED-CODE-48h:', JSON.stringify(agg))
}
main().finally(() => process.exit(0))

import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rej = await db.handoff.groupBy({ by: ['status'], _count: { _all: true } })
console.log('handoff byStatus:', JSON.stringify(Object.fromEntries(rej.map(r => [r.status, r._count._all]))))
const sample = await db.handoff.findFirst({ where: { status: 'REJECTED' }, select: { id: true, suspendedCount: true, error: true, lastSuspendedAt: true } })
console.log('sample REJECTED:', JSON.stringify(sample, null, 1).slice(0, 400))
const doneToday = await db.handoff.count({ where: { status: 'DONE', updatedAt: { gte: new Date(Date.now() - 3600_000) } } })
console.log('handoffs DONE in last hour:', doneToday)
await db.$disconnect()

import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const hs = await db.handoff.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' }, select: { id: true, taskId: true, field: true, artifactHash: true, createdAt: true, status: true } })
console.log('PROPOSED handoffs:', hs.length)
const last = hs[hs.length-1]
if (last) {
  console.log('newest:', last.id, last.createdAt, 'hash:', last.artifactHash)
  const t = await db.task.findUnique({ where: { id: last.taskId }, select: { title: true, status: true } })
  console.log('newest task:', JSON.stringify(t))
}
const counts = await db.handoff.groupBy({ by: ['status'], _count: { _all: true } })
console.log('byStatus:', JSON.stringify(counts))
await db.$disconnect()

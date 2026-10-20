import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
for (const st of ['APPROVED', 'RUNNING', 'FAILED']) {
  const rows = await db.handoff.findMany({ where: { status: st }, select: { id: true, repo: true, path: true, errorClass: true, attempts: true, updatedAt: true, auto: true } })
  for (const r of rows) console.log(st, r.id, r.updatedAt.toISOString(), 'att:' + r.attempts, r.repo + ':' + r.path, 'err:' + (r.errorClass ?? '-'), 'auto:' + r.auto)
}
await db.$disconnect()

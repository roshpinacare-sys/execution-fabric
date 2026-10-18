import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
for (const id of ['cmvdja6qh000lu8vwnxchf7w7','cmvdj3p4j000iu8vwbctozrmj']) {
  const h = await db.handoff.findUnique({ where: { id } })
  const t = await db.task.findUnique({ where: { id: h!.taskId } })
  const p = JSON.parse(t?.output ?? '{}') as { code?: string }
  console.log('===== ' + id)
  console.log(p.code)
}
await db.$disconnect()

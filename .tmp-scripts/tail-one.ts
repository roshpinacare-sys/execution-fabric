import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const h = await db.handoff.findUnique({ where: { id: 'cmvdil65i000fu8vwwzbs8kvs' } })
const t = await db.task.findUnique({ where: { id: h!.taskId } })
const p = JSON.parse(t?.output ?? '{}') as { code?: string }
console.log('taskId=' + h!.taskId)
console.log((p.code ?? '').slice(4400))
await db.$disconnect()

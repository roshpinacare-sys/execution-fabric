import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
const db = new PrismaClient()
const hs = await db.handoff.findMany({ where: { id: { in: ['cmvdi8a5o000bu8vwm5zswy2f','cmvdadfb8000srltunughje2c','cmvd9wilc000krltugm9vx0id'] } } })
for (const h of hs) {
  const t = await db.task.findUnique({ where: { id: h.taskId } })
  const out = t?.output ?? ''
  const hash = createHash('sha256').update(out).digest('hex').slice(0,32)
  console.log('===== handoff ' + h.id + ' task=' + h.taskId)
  console.log('title: ' + (t?.title ?? '?'))
  console.log('hashMatch: ' + (hash === h.artifactHash ? 'YES' : 'NO(' + hash + ' vs ' + h.artifactHash + ')'))
  console.log('--- output ---')
  console.log(out.slice(0, 3400))
  console.log('...[truncated, total ' + out.length + ' chars]')
  console.log('')
}
await db.$disconnect()

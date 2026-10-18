import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const ids = ['cmvdi8a5o000bu8vwm5zswy2f','cmvdadfb8000srltunughje2c','cmvd9wilc000krltugm9vx0id']
const rows = await db.handoff.findMany({ where: { id: { in: ids } } })
for (const r of rows) {
  const rec: Record<string, unknown> = r
  const keys = Object.keys(rec)
  const contentKeys = keys.filter(k => typeof rec[k] === 'string' && (rec[k] as string).length > 200)
  console.log('=== ' + r.id + ' status=' + r.status + ' size=' + (r.artifactSize ?? '?'))
  console.log('contentFields: ' + contentKeys.join(','))
  for (const k of contentKeys) {
    const v = rec[k] as string
    console.log('--- ' + k + ' (first 2600 chars) ---')
    console.log(v.slice(0, 2600))
  }
  console.log('')
}
await db.$disconnect()

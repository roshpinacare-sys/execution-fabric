import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const imps = await db.improvement.findMany({ orderBy: { id: 'desc' }, take: 12 })
for (const i of imps) console.log(i.id, '|', i.status, '|', i.kind, '|', (i.title ?? '').slice(0, 50))
await db.$disconnect()

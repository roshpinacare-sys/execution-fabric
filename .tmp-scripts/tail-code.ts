import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const t = await db.task.findUnique({ where: { id: 'cmvdi78il0009u8vwk9khn5ik' } })
const p = JSON.parse(t?.output ?? '{}') as { code?: string }
const code = p.code ?? ''
console.log(code.slice(3200))
await db.$disconnect()

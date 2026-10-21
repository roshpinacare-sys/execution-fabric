import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const t = await db.task.findUnique({ where: { id: 'cmvgrpiku0001nckfwgbrxqzd' }, select: { status: true, errorClass: true, error: true, attempts: true } })
console.log(JSON.stringify(t))
await db.$disconnect()

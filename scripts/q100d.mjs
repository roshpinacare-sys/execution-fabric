import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const t = await db.task.findFirst({ where: { title: { contains: 'Task 100 — הוכחת-זהב' } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, kind: true, createdAt: true } })
console.log('golden-path task:', JSON.stringify(t))
await db.$disconnect()

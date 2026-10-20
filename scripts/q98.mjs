import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const running = await db.task.findMany({ where: { status: 'RUNNING' }, select: { id: true, kind: true, title: true, worker: true } })
const queued = await db.task.count({ where: { status: 'QUEUED' } })
const doneRecent = await db.task.count({ where: { status: 'DONE', updatedAt: { gte: new Date(Date.now() - 30*60_000) } } })
console.log('RUNNING עכשיו:', running.length, running.map(t=>`[${t.kind}] ${t.title.slice(0,45)}`).join(' | '))
console.log('QUEUED:', queued, '| DONE ב-30דק האחרונות:', doneRecent)
await db.$disconnect()

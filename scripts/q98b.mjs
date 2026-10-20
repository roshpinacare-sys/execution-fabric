import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const t = await db.task.findFirst({ where: { title: { contains: 'נתיב-זהב' } }, orderBy: { createdAt: 'desc' } })
console.log('משימת-הנתיב-המוזהב:', t ? `#${t.id} [${t.status}] ${t.kind}` : 'לא-נמצאה')
await db.$disconnect()

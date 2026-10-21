import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const repair = await db.ledgerEntry.count({ where: { kind: 'REPAIR' } })
const sitebuild = await db.ledgerEntry.count({ where: { kind: 'SITEBUILD' } })
const all = await db.ledgerEntry.count()
const lastRepair = await db.ledgerEntry.findFirst({ where: { kind: 'REPAIR' }, orderBy: { id: 'desc' } })
console.log('REPAIR entries:', repair, '| SITEBUILD:', sitebuild, '| total:', all)
if (lastRepair) console.log('last REPAIR:', JSON.stringify({ id: lastRepair.id, taskId: lastRepair.taskId, status: lastRepair.status, worker: lastRepair.worker, hash: lastRepair.hash?.slice(0,12) }))
await db.$disconnect()

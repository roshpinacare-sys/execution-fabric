import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const applied = await db.improvement.count({ where: { status: 'APPLIED' } })
const proposed = await db.improvement.count({ where: { status: 'PROPOSED' } })
const ledger = await db.ledgerEntry.count({ where: { worker: 'proposal-completion' } })
console.log('IMPROVEMENTS — APPLIED:', applied, '| PROPOSED:', proposed, '| proposal-completion חתימות:', ledger)
const last = await db.ledgerEntry.findFirst({ where: { worker: 'proposal-completion' }, orderBy: { id: 'desc' } })
if (last) console.log('last:', JSON.stringify({ id: last.id, kind: last.kind, status: last.status, hash: last.hash?.slice(0,10), at: last.createdAt }))
await db.$disconnect()

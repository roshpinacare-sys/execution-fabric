import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const code = await db.ledgerEntry.count({ where: { kind: 'CODE', status: 'DONE', createdAt: { gte: since } } })
  const site = await db.ledgerEntry.count({ where: { kind: 'SITEBUILD', status: 'DONE', createdAt: { gte: since } } })
  console.log('CODE:', code, 'SITEBUILD:', site, 'perDay=', (code + site) / 2, 'mult=', ((code + site) / 2 / 10).toFixed(2))
  const last = await db.ledgerEntry.findMany({ orderBy: { id: 'desc' }, take: 3, select: { id: true, kind: true, status: true, createdAt: true } })
  console.log('LAST:', JSON.stringify(last))
}
main().finally(() => process.exit(0))

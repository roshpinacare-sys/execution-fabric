import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const tables = await db.$queryRawUnsafe<{name:string}[]>("SELECT name FROM sqlite_master WHERE type='table'")
console.log('TABLES: ' + tables.map(t=>t.name).join(', '))
for (const t of tables) {
  if (t.name.startsWith('_')) continue
  const cols = await db.$queryRawUnsafe<{name:string;type:string}[]>(`PRAGMA table_info('${t.name}')`)
  console.log(t.name + ': ' + cols.map(c=>c.name).join(', '))
}
await db.$disconnect()

import { db } from '../src/lib/db'
const a = await db.$queryRawUnsafe<any[]>(`SELECT id, createdAt, typeof(createdAt) t FROM LedgerEntry ORDER BY id DESC LIMIT 3`)
for (const r of a) console.log(r.id, r.createdAt, '| type:', r.t)
process.exit(0)

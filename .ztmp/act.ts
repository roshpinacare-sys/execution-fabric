import { db } from '../src/lib/db'
const rows = await db.$queryRawUnsafe<any[]>(`SELECT strftime('%H', createdAt/1000, 'unixepoch') h, COUNT(*) n FROM LedgerEntry WHERE createdAt >= ${Date.now() - 8 * 3600_000} GROUP BY h ORDER BY h`)
for (const r of rows) console.log(`hour ${r.h}:00 UTC → ${r.n} ledger entries`)
const w = await db.$queryRawUnsafe<any[]>(`SELECT worker, COUNT(*) n FROM LedgerEntry WHERE createdAt >= ${Date.now() - 3 * 3600_000} AND kind NOT IN ('DRILL') GROUP BY worker ORDER BY n DESC LIMIT 10`)
console.log('--- last 3h workers ---')
for (const r of w) console.log(String(r.n).padStart(4), r.worker)
process.exit(0)

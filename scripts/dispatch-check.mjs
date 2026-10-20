import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const done = await db.task.count({ where: { title: { startsWith: 'יישום-הצעה #' }, status: 'DONE' } })
  const inflight = await db.task.count({ where: { title: { startsWith: 'יישום-הצעה #' }, status: { in: ['QUEUED','RUNNING'] } } })
  const applied = await db.improvement.count({ where: { status: 'APPLIED' } })
  const proposed = await db.improvement.count({ where: { status: 'PROPOSED' } })
  console.log('dispatchTasks DONE:', done, '| in-flight:', inflight, '| proposals APPLIED:', applied, '| PROPOSED:', proposed)
}
main().finally(() => process.exit(0))

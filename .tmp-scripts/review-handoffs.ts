import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
const db = new PrismaClient()
const ids = ['cmvdi8a5o000bu8vwm5zswy2f','cmvdadfb8000srltunughje2c','cmvd9wilc000krltugm9vx0id']
const DANGER = [
  /\bexecSync\b/, /\bchild_process\b/, /\beval\s*\(/, /\bnew\s+Function\s*\(/,
  /\bwget\b/, /\bsudo\b/, /chmod\s+777/, /base64\s+-d/, /rm\s+-rf/,
  /\bexec\s*\(\s*`[^`]*\$\{/, /\bexecSync\s*\(\s*`[^`]*\$\{/, /\$\(.*\)/, /\bcurl\b/
]
for (const id of ids) {
  const h = await db.handoff.findUnique({ where: { id } })
  if (!h) { console.log('=== ' + id + ' MISSING'); continue }
  const t = await db.task.findUnique({ where: { id: h.taskId } })
  let code: string | null = null
  try { const p = JSON.parse(t?.output ?? '{}'); code = typeof p?.code === 'string' ? p.code : null } catch {}
  const hash = code ? createHash('sha256').update(code).digest('hex').slice(0,32) : 'NOCODE'
  console.log('===== ' + id + ' | field=' + h.field + ' | hashMatch=' + (hash === h.artifactHash ? 'YES' : 'NO') + ' | codeLen=' + (code?.length ?? 0))
  if (code) {
    const hits: string[] = []
    for (const re of DANGER) if (re.test(code)) hits.push(re.source)
    console.log('SECURITY_HITS: ' + (hits.length ? hits.join(' | ') : 'CLEAN'))
  }
}
await db.$disconnect()

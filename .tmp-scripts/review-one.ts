import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
const db = new PrismaClient()
const h = await db.handoff.findUnique({ where: { id: 'cmvdil65i000fu8vwwzbs8kvs' } })
const t = await db.task.findUnique({ where: { id: h!.taskId } })
let code: string | null = null
try { const p = JSON.parse(t?.output ?? '{}'); code = typeof p?.code === 'string' ? p.code : null } catch {}
const hash = code ? createHash('sha256').update(code).digest('hex').slice(0,32) : 'NOCODE'
console.log('title: ' + t?.title)
console.log('field: ' + h!.field + ' | hashMatch: ' + (hash === h!.artifactHash ? 'YES' : 'NO') + ' | len: ' + code?.length)
const DANGER = [/\bexecSync\b/, /\bchild_process\b/, /\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bwget\b/, /\bsudo\b/, /chmod\s+777/, /base64\s+-d/, /rm\s+-rf/, /\bexec\s*\(\s*`[^`]*\$\{/, /\bexecSync\s*\(\s*`[^`]*\$\{/, /\bcurl\b/]
const hits: string[] = []
if (code) for (const re of DANGER) if (re.test(code)) hits.push(re.source)
console.log('SECURITY_HITS: ' + (hits.length ? hits.join(' | ') : 'CLEAN'))
console.log('--- FULL CODE ---')
console.log(code)
await db.$disconnect()

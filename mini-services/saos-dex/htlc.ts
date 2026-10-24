// ═════════════════════════════════════════════════════════════════════════════
// htlc.ts — מאמת-ההחלפות-האטומיות של הדקס-הריבוני (הנחיית-בעלים §3/§7.2)
// "ATOMIC SWAPS & HTLC INTEGRATION" — hashlock (sha256) + timelock + נתיב-סגירה-יחיד.
//
// המבנה: ליבה-טהורה (canClaim/canRefund — דטרמיניסטית, nowMs מוזרק) + שכבת-SQL
// דקה על bun:sqlite (נבדקת-חיה על :memory: — ה-SQL-האמיתי, אין-תחליפים).
//
// אחזקת-הכסף: הערבות-חיה-בארנק 'htlc-escrow' של הדקס (העברה-אמיתית-בעת-initiate).
// הליבה-כאן מוודאת: רק-preimage-נכון-לפני-הפקיעה פודה; רק-אחרי-הפקיעה מוחזר;
// ואחרי-סגירה (בכל-כיוון) — אין-נתיב-שני. אפס-הוצאה-כפולה-במבנה.
// ═════════════════════════════════════════════════════════════════════════════
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

export interface HtlcCommitmentSig {
  keyId: string
  fp: string
  scheme: string
  signatureBase64: string
}

export interface HtlcContract {
  id: string
  sender: string
  recipient: string
  asset: string
  amountMu: number
  /** sha256-הקס-קטן של ה-preimage — הנעילה */
  secretHash: string
  /** זמן-מוחלט (epoch ms) — ממנו-ואילך מותר-לשולח למשוך-בחזרה */
  timelockMs: number
  createdAt: string
  status: 'locked' | 'claimed' | 'refunded'
  /** חתימת-ה-HSM על-ההתחייבות (אימות-זהות-המש) — נדרשת-בעת-הפתיחה */
  commitmentSig: HtlcCommitmentSig | null
  closedAt: string | null
  /** ה-preimage — נחשף-רק-בפדיון מוצלח (מוכח-מול-ה-hashlock) */
  secret: string | null
}

export type HtlcVerdict = { ok: true } | { ok: false; reason: string }

// ── ליבה-טהורה ───────────────────────────────────────────────────────────────
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export function validSecretHash(h: string): boolean {
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)
}

/** נתיב-הפדיון: preimage-נכון + לפני-הפקיעה + חוזה-חי. */
export function canClaim(c: HtlcContract, secret: string, nowMs: number): HtlcVerdict {
  if (c.status !== 'locked') return { ok: false, reason: 'contract-closed' }
  if (sha256Hex(String(secret)) !== c.secretHash) return { ok: false, reason: 'hashlock-mismatch' }
  if (nowMs >= c.timelockMs) return { ok: false, reason: 'timelock-expired-use-refund' }
  return { ok: true }
}

/** נתיב-ההחזר: אחרי-הפקיעה-בלבד + חוזה-חי. */
export function canRefund(c: HtlcContract, nowMs: number): HtlcVerdict {
  if (c.status !== 'locked') return { ok: false, reason: 'contract-closed' }
  if (nowMs < c.timelockMs) return { ok: false, reason: 'timelock-not-expired' }
  return { ok: true }
}

// ── שכבת-האחסון (bun:sqlite — עצמאית-ומוכלת) ────────────────────────────────
export function ensureHtlcSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS htlc_contracts (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    asset TEXT NOT NULL,
    amountMu INTEGER NOT NULL,
    secretHash TEXT NOT NULL,
    timelockMs INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    status TEXT NOT NULL,
    commitmentSig TEXT,
    closedAt TEXT,
    secret TEXT
  )`)
}

function rowToContract(r: Record<string, unknown>): HtlcContract {
  return {
    id: String(r.id),
    sender: String(r.sender),
    recipient: String(r.recipient),
    asset: String(r.asset),
    amountMu: Number(r.amountMu),
    secretHash: String(r.secretHash),
    timelockMs: Number(r.timelockMs),
    createdAt: String(r.createdAt),
    status: r.status as HtlcContract['status'],
    commitmentSig: r.commitmentSig ? (JSON.parse(String(r.commitmentSig)) as HtlcCommitmentSig) : null,
    closedAt: r.closedAt ? String(r.closedAt) : null,
    secret: r.secret ? String(r.secret) : null,
  }
}

export function insertContract(db: Database, c: HtlcContract): void {
  db.run(
    `INSERT INTO htlc_contracts (id, sender, recipient, asset, amountMu, secretHash, timelockMs, createdAt, status, commitmentSig, closedAt, secret)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.id, c.sender, c.recipient, c.asset, c.amountMu, c.secretHash, c.timelockMs,
      c.createdAt, c.status, c.commitmentSig ? JSON.stringify(c.commitmentSig) : null,
      c.closedAt, c.secret,
    ],
  )
}

export function getContract(db: Database, id: string): HtlcContract | null {
  const r = db.query('SELECT * FROM htlc_contracts WHERE id=?').get(id) as Record<string, unknown> | null
  return r ? rowToContract(r) : null
}

export function listContracts(db: Database, status?: string): HtlcContract[] {
  const rows = status
    ? (db.query('SELECT * FROM htlc_contracts WHERE status=? ORDER BY id').all(status) as Record<string, unknown>[])
    : (db.query('SELECT * FROM htlc_contracts ORDER BY id').all() as Record<string, unknown>[])
  return rows.map(rowToContract)
}

export function updateContractStatus(
  db: Database,
  id: string,
  status: HtlcContract['status'],
  closedAt: string,
  secret: string | null,
): void {
  db.run('UPDATE htlc_contracts SET status=?, closedAt=?, secret=? WHERE id=?', [status, closedAt, secret, id])
}

/** מזהה-מונוטוני: htlc-N עם N = מקס-המזהים-הקיימים+1 (ספרות-מלאות — htlc-9 → htlc-10). */
export function nextHtlcId(db: Database): string {
  const r = db
    .query("SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) AS m FROM htlc_contracts WHERE id LIKE 'htlc-%'")
    .get() as { m: number | null }
  return `htlc-${(r.m ?? 0) + 1}`
}

// GITHUB-COMPLIANCE-GATE (Task 69) — שער-הציות של הרשת מול GitHub.
//
// הקשר: חשבון הבעלים נסגר-פעם-אחת בגלל-פעילות-סוכנים. החוק-העליון: אף-פעולה
// שלא-תעמוד-בחוקי-GitHub. השער-מחמיר מעבר-לדרישה ומאובטל-לחוקים-המדודים
// (מחקר 2026-10, docs/BEYOND-GITHUB.md):
//   • REST אוטנטיקציה: 5,000/שעה (OAuth-apps: 2,000/שעה) — אנחנו cap-עצמי 300/שעה
//   • מגבלה-משנית רשמית: סריאליזציה/מרווח-≥1ש בין-קריאות-יוצרות/מעדכנות — אנחנו 1.2ש
//   • 403-with-remaining=0 / 429 → backoff-שרירותי-60ש לפני-הניסיון-הבא
//   • אסור (חוק-אדום, מחוץ-לקוד): יצירת-חשבונות, חשבונות-מרובים, עקיפת-חסימה,
//     קומיטים-ספאמיים, יצירת-ריפואים-אוטומטית (רק-בהוראת-בעלים מפורשת)
//
// עקרונות-מימוש: אפס-סודות (מטא-בלבד); fail-honest (חסימה-עצמית מדווחת בכנות);
// bounded memory (יומן-200-אחרונים); additive-only ל-github.ts (אפס-דריסת-התנהגות).

const BUDGET_CAP_PER_HOUR = 300 // רף-עצמי: 6% מהמכסה-הרשמית — מרווח-בטחון-גדול
const MUTATION_GAP_MS = 1_200 // מרווח-בין-מוטציות (GitHub-ממליץ-≥1,000ms)
const BACKOFF_ON_LIMIT_MS = 60_000 // אחרי-403-rate/429
const WINDOW_MS = 60 * 60 * 1000
const LOG_BOUND = 200

export type GhMethod = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'

interface LogEntry {
  at: number
  method: GhMethod
  status: number | null
  kind: 'call' | 'blocked-budget' | 'throttled-gap'
}

const state = {
  window: [] as number[], // חותמות-זמן של קריאות שיצאו-לפועל
  lastMutationAt: 0,
  backoffUntil: 0,
  log: [] as LogEntry[],
}

function log(e: LogEntry) {
  state.log.push(e)
  if (state.log.length > LOG_BOUND) state.log.splice(0, state.log.length - LOG_BOUND)
}

function isMutation(m: GhMethod): boolean {
  return m !== 'GET'
}

// השער — נקרא-לפני-כל-קריאת-GitHub. יכול-להמתין (מוטציה-צמודה-קודמת) או-לזרוק
// (תקציב-מוצה / backoff-פעיל). ההמתנה-חסומה-בזמן (max-3ש) — ה-HTTP-timeout-של-20ש-נשאר-הרב-מעל.
export async function policyGate(method: GhMethod): Promise<void> {
  const now = Date.now()

  // backoff אחרי-מכסה/429 — עדכון-מכובד של-השרת
  if (now < state.backoffUntil) {
    const wait = state.backoffUntil - now
    if (wait > 3_000) {
      log({ at: now, method, status: null, kind: 'blocked-budget' })
      throw new Error(
        `github-rate: compliance-backoff ${Math.ceil(wait / 1000)}s (אחרי-429/403-מכסה — מכבדים-את-השרת)`
      )
    }
    await sleep(wait)
  }

  // תקציב-שעתי (window מתגלגל)
  state.window = state.window.filter((t) => now - t < WINDOW_MS)
  if (state.window.length >= BUDGET_CAP_PER_HOUR) {
    log({ at: now, method, status: null, kind: 'blocked-budget' })
    throw new Error(
      `github-rate: תקציב-עצמי-מוצה (${state.window.length}/${BUDGET_CAP_PER_HOUR} לשעה) — fail-honest, מתאפס-בעוד ${Math.ceil((WINDOW_MS - (now - state.window[0])) / 60000)} דק`
    )
  }

  // קצב-מוטציות: המתנה-מבוקרת (עד-3ש) או-דחייה-כנה
  if (isMutation(method) && state.lastMutationAt > 0) {
    const elapsed = now - state.lastMutationAt
    if (elapsed < MUTATION_GAP_MS) {
      const wait = MUTATION_GAP_MS - elapsed
      if (wait > 3_000) {
        log({ at: now, method, status: null, kind: 'throttled-gap' })
        throw new Error(`github-rate: mutation-gap ${wait}ms`)
      }
      await sleep(wait)
    }
  }
}

// רישום-אחרי-כל-קריאה (כולל-כישלונות)
export function policyRecord(method: GhMethod, status: number | null): void {
  const now = Date.now()
  if (!(status !== null && status >= 400 && status < 500 && status !== 429)) {
    // קריאה-שיצאה-לפועל נספרת-לתקציב (כישלון-404-כן; 401-כן; תקלת-רשת-מקומית-לא)
    state.window.push(now)
  }
  log({ at: now, method, status, kind: 'call' })
  if (isMutation(method)) state.lastMutationAt = now
  if (status === 429 || status === 403) {
    state.backoffUntil = now + BACKOFF_ON_LIMIT_MS
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ===== דוח-ציות חי (מטא-בלבד) =====
export interface ComplianceReport {
  budget: { used: number; cap: number; windowResetMs: number }
  pacing: { mutationGapMs: number; lastMutationAgoMs: number | null; backoffActive: boolean; backoffRemainingMs: number }
  rules: { id: string; value: string; source: string }[]
  recent: { kind: string; method: GhMethod; status: number | null; at: string }[]
}

export function complianceReport(): ComplianceReport {
  const now = Date.now()
  state.window = state.window.filter((t) => now - t < WINDOW_MS)
  return {
    budget: {
      used: state.window.length,
      cap: BUDGET_CAP_PER_HOUR,
      windowResetMs: state.window.length > 0 ? WINDOW_MS - (now - state.window[0]) : 0,
    },
    pacing: {
      mutationGapMs: MUTATION_GAP_MS,
      lastMutationAgoMs: state.lastMutationAt > 0 ? now - state.lastMutationAt : null,
      backoffActive: now < state.backoffUntil,
      backoffRemainingMs: Math.max(0, state.backoffUntil - now),
    },
    rules: [
      { id: 'budget-self-cap', value: `${BUDGET_CAP_PER_HOUR}/hour (6% of official 5,000)`, source: 'docs.github.com rate limits + self-imposed margin' },
      { id: 'mutation-gap', value: `${MUTATION_GAP_MS}ms serialization`, source: 'GitHub best practices for API usage (2026): ≥1s between creating/updating requests' },
      { id: 'backoff-on-429-403', value: `${BACKOFF_ON_LIMIT_MS / 1000}s mandatory pause`, source: 'respect secondary rate limits; never retry immediately' },
      { id: 'no-account-creation', value: 'ABSOLUTE — לעולם לא ליצור חשבונות/לעקוף חסימה', source: 'GitHub ToS: bot/automated account registration prohibited; multi-account evasion = suspension' },
      { id: 'no-spam-commits', value: 'קומיטים משמעותיים בלבד, אפס-רעש', source: 'measured flag patterns: spam-like commit behavior triggers abuse-detection' },
      { id: 'repo-creation', value: 'רק בהוראת-בעלים מפורשת', source: 'owner authority law' },
    ],
    recent: state.log.slice(-30).map((e) => ({
      kind: e.kind,
      method: e.method,
      status: e.status,
      at: new Date(e.at).toISOString(),
    })),
  }
}

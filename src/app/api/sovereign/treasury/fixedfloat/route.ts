import { NextResponse } from 'next/server'
import { ffConfigured, ffTradingEnabled, ffPing, ffCcies, ffPrice } from '@/lib/fixedfloat'
import { appendLedger, sha256Short } from '@/lib/ledger'

// ===== עורק-הקופה (Task 101) — FixedFloat: יכולת-ההמרה-הכלכלית של הריבונות =====
//
// חוקי-חוכמה (הבעלים: "מפתח שצריך לאטום בכספת... להשתמש בו בחוכמה"):
//  · קריאה-בלבד כברירת-מחדל — ping/ccies/price בלבד.
//  · מסחר (create) נעול: 403 עד ש-TREASURY_TRADING_ENABLED=true — וגם-אז דורש
//    מודול-תקרות-סיכון וחתימת-שרשרת פר-הזמנה (501 עד-אז — אין-קיצורי-דרך).
//  · מגבלת-קצב מקומית 20/דק' — ריחוק-בטוח מתקרת-250-המשקל של השירות.
//  · אפס-חשיפת-מפתח: המסלול מחזיר סטטוסים וסיכומים מספריים בלבד.
//  · כל-פעימת-אימות (ping) נחתמת בשרשרת-האמת (kind=TREASURY) — הכספת
//    מדווחת-על-עצמה, בהצלחה ובכשל כאחד.

export const dynamic = 'force-dynamic'

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20
const g = globalThis as unknown as { __ffRate?: number[] }

function rateLimited(): boolean {
  const now = Date.now()
  const arr = (g.__ffRate ?? []).filter((t) => now - t < WINDOW_MS)
  if (arr.length >= MAX_PER_WINDOW) {
    g.__ffRate = arr
    return true
  }
  arr.push(now)
  g.__ffRate = arr
  return false
}

// התוכנית-הכלכלית — גלויה-וקריאה (עברית), כדי שהשלב הבא תמיד יהיה-כתוב
const PLAN = [
  "שלב-1 (חי-עכשיו): אימות-כספת חי כל-30 דק' — פעימת-ccies חתומה בשרשרת; היכולת נשמרת-חמה ונבדקת-ברציפות.",
  'שלב-2: עוקב-שערים — price דו-כיווני (BTC/USDT/ETH) + XML-שערים ציבורי (ff.io/rates/float.xml) שאינו-נוגע-במפתח כלל; זיהוי-מרווחים וזמינות-עתודות.',
  'שלב-3: מנוע-המרה מוגן — create נשאר נעול; ייפתח רק עם TREASURY_TRADING_ENABLED=true + תקרת-סכום-לעסקה + תקרה-יומית + הפסקת-חירום + חתימת-שרשרת לכל-הזמנה.',
  'שלב-4: עורק-רווח — הכוונה אוטומטית של עודפים ליציבים (USDT) בשער-מוסכם, דוח-קופה יומי חתום, וקישור-הכנסות-הרשת אל-הקופה.',
]

const SAFETY = {
  endpoint: 'https://ff.io/api/v2',
  rateLimitLocal: "20 קריאות/דק' (בפועל: ~2 לשעה מהלב)",
  remoteBudget: "250 יחידות-משקל/דק' אצל-השירות (create=50; אנחנו לא יורים create)",
  trading: "נעול-כברירת-מחדל (TREASURY_TRADING_ENABLED חייב-היות 'true')",
  keyStorage: '.env.local(600) + .vault(700) — מחוץ-לגיט, אסור-בלוגים, אסור-בתגובות',
}

export async function GET() {
  const cfg = ffConfigured()
  return NextResponse.json({
    ok: true,
    service: 'treasury/fixedfloat',
    configured: cfg,
    tradingEnabled: ffTradingEnabled(),
    plan: PLAN,
    safety: SAFETY,
  })
}

export async function POST(req: Request) {
  let body: {
    action?: string
    fromCcy?: string
    toCcy?: string
    amount?: number
    direction?: 'from' | 'to'
    type?: 'fixed' | 'float'
  } = {}
  try {
    body = await req.json()
  } catch {}
  const action = body.action ?? 'ping'

  if (rateLimited()) {
    return NextResponse.json({ ok: false, error: "rate-limited-מקומי (20/דק')" }, { status: 429 })
  }

  // שער-המסחר: כל-פעולה-שאינה-קריאה נתקלת בשני-מנעולים
  if (!['ping', 'ccies', 'price'].includes(action)) {
    if (!ffTradingEnabled()) {
      return NextResponse.json(
        {
          ok: false,
          error: 'מסחר-סגור: עורק-הקופה קורא-בלבד; הפעלה דורשת TREASURY_TRADING_ENABLED=true + תקרות-סיכון',
        },
        { status: 403 },
      )
    }
    return NextResponse.json(
      { ok: false, error: 'create-טרם-מומשל: דרוש-מודול-תקרות (סכום-מקס/תקרה-יומית/הפסקת-חירום) ואישור-בעלים — אין-קיצורי-דרך' },
      { status: 501 },
    )
  }

  const r =
    action === 'ping'
      ? await ffPing()
      : action === 'ccies'
        ? await ffCcies()
        : await ffPrice({
            fromCcy: body.fromCcy ?? 'BTC',
            toCcy: body.toCcy ?? 'USDT',
            amount: Number.isFinite(body.amount) ? (body.amount as number) : 0.01,
            direction: body.direction ?? 'from',
            type: body.type ?? 'float',
          })

  // כל-פעימת-אימות חתומה — גם-כשל כנה חתום (אין-הסתרה)
  if (action === 'ping') {
    const summary = r.ok
      ? `ccies ok: ${r.data?.currencies ?? '?'} מטבעות (${r.data?.recv ?? '?'} recv/${r.data?.send ?? '?'} send) ב-${r.durationMs}ms`
      : `ping failed: ${r.errorClass ?? 'api'}:${(r.msg || '').slice(0, 80)}`
    try {
      await appendLedger({
        taskId: null,
        kind: 'TREASURY',
        status: r.ok ? 'DONE' : 'FAILED',
        worker: 'treasury-ping',
        attempts: 1,
        durationMs: r.durationMs,
        errorClass: r.errorClass ?? null,
        outputHash: sha256Short(summary),
      })
    } catch {}
    return NextResponse.json({
      ok: r.ok,
      action,
      authVerified: r.ok,
      code: r.code,
      msg: r.msg,
      data: r.data,
      errorClass: r.errorClass,
      durationMs: r.durationMs,
      ledger: summary,
    })
  }

  return NextResponse.json({
    ok: r.ok,
    action,
    code: r.code,
    msg: r.msg,
    data: r.data,
    errorClass: r.errorClass,
    durationMs: r.durationMs,
  })
}

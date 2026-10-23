// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/engine — ליבת-ההתאמה הדטרמיניסטית (Task-132 — הנחיה-קנונית: TDD)
// ═════════════════════════════════════════════════════════════════════════════
// חילוץ-מהודק מ-index.ts (Task-131): לולאת-ההתאמה מחיר-זמן, חשבונאות-נעילות מדויקת
// ושומר-העקביות — הכל מעל ממשק DexStore (הזרקת-תלות), בלי bun:sqlite ובלי-רשת.
// הלוגיקה מועתקת-מילה-במילה מהאיבר-החי; רק נגישי-האחסון הופשטו. מטרה: סוויטת
// בדיקות-יחידה דטרמיניסטיות על כל אינווריאנט-כספים (engine.test.ts) — אפס-סטאבים.
//
// אינווריאנטים חתומים (כל-אחד מוכח-בדיקה):
//  I1 עסקה-תמיד במחיר-המייקר (קונה-חוצה-פאריטי מקבל-את-הטוב-לו: Pm ≤ Pt)
//  I2 שחרור-נעילת-הקונה = מחיר-פקודתו-שלו × qty; תשלום במחיר-העסקה
//  I3 שחרור-נעילת-המוכר = qty בסיס בדיוק; קבלת quote במחיר-העסקה
//  I4 שימור-כספים: Σבסיס ו-Σquote על-כל-הארנקות קבועים-לאורך-ההתאמה
//  I5 IOC: שארית-מתה + שחרור-הנעילה-שלה — קנייה remainder×priceMu (תיקון-Task-132:
//     היה remainder בלבד → remainder×(priceMu−1) נעולים-לנצח); מכירה remainder-qty
//  I6 שומר-העקביות: free<0 בשום-צד → ההתאמה נעצרת-מיד לפני-שמירה; אפס-המצאת-כסף
//  I7 אפס-צפים: כל-נתיבי-הכסף µ-שלמים (qty × priceMu ∈ ℤ)

export interface Balances {
  [asset: string]: number
}
export interface WalletRec {
  name: string
  credits: number
  balances: Balances
  locked: Balances
}
export interface Order {
  id: number
  base: string
  quote: string
  side: string
  priceMu: number
  amountMu: number
  filledMu: number
  issuer: string
  postOnly: number
  ioc: number
  status: string
  createdAt: string
}
export interface BookSide {
  bids: Order[]
  asks: Order[]
}

// חוזה-האחסון של-הליבה — מומשק-מעל sqlite ב-index.ts ומעל זיכרון בבדיקות.
// סמנטיקה-מחייבת: getWallet מחזיר עותק-טרי בכל-קריאה (כמו קריאת-שורה מה-db);
// listOpen ממוין asks ASC / bids DESC (מחיר-זמן); כל-כתיבה משתקפת-מיד.
export interface DexStore {
  listOpen(base: string, quote: string): BookSide
  getWallet(name: string): WalletRec | null
  saveWallet(w: WalletRec): void
  markFilledIfComplete(id: number): void
  setMakerProgress(id: number, filledMu: number, complete: boolean): void
  insertFill(f: { base: string; quote: string; side: string; priceMu: number; amountMu: number; buyer: string; seller: string }): void
  log(msg: string): void
}

export const free = (w: { balances: Balances; locked: Balances }, a: string): number => (w.balances[a] ?? 0) - (w.locked[a] ?? 0)

// ── התאמה: מחיר-זמן; עסקה-במחיר-המייקר ───────────────────────────────────────
// כלל-נעילות מדויק: שחרור-הימור-הנעילה במחיר-הפקודה-הנועלת-עצמה (order.priceMu×qty
// לצד-ה-quote; qty לצד-הבסיס), העברה-במחיר-העסקה (תמיד מחיר-המייקר).
// לקוח-הקנייה-החוצה-פאריטי מקבל-את-המחיר-הטוב-לו (Pm ≤ Pt) — כמו-בורסות-אמת.
export function matchOrderCore(taker: Order, store: DexStore): number {
  let filledNow = 0
  for (;;) {
    const remTaker = taker.amountMu - taker.filledMu - filledNow
    if (remTaker <= 0) break
    const { bids, asks } = store.listOpen(taker.base, taker.quote)
    const maker = taker.side === 'buy' ? asks[0] : bids[0]
    if (!maker) break
    const crosses = taker.side === 'buy' ? taker.priceMu >= maker.priceMu : taker.priceMu <= maker.priceMu
    if (!crosses) break
    const remMaker = maker.amountMu - maker.filledMu
    const qty = Math.min(remTaker, remMaker)
    if (qty <= 0) {
      // מייקר-מלא-שנשכח — סימון-והמשך
      store.markFilledIfComplete(maker.id)
      break
    }
    const priceMu = maker.priceMu // העסקה-תמיד במחיר-המייקר
    const buyerName = taker.side === 'buy' ? taker.issuer : maker.issuer
    const sellerName = taker.side === 'buy' ? maker.issuer : taker.issuer
    const wb = store.getWallet(buyerName)
    const ws = store.getWallet(sellerName)
    if (!wb || !ws) break
    const quotePay = qty * priceMu
    // קונה: שחרור-הזמנה במחיר-פקודת-הקנייה-שלו, תשלום-במחיר-העסקה, קבלת-בסיס
    const buyOrder = taker.side === 'buy' ? taker : maker
    wb.locked[taker.quote] = Math.max(0, (wb.locked[taker.quote] ?? 0) - qty * buyOrder.priceMu)
    wb.balances[taker.quote] = (wb.balances[taker.quote] ?? 0) - quotePay
    wb.balances[taker.base] = (wb.balances[taker.base] ?? 0) + qty
    // מוכר: שחרור-נעילת-בסיס, מסירת-בסיס, קבלת-quote במחיר-העסקה
    ws.locked[taker.base] = Math.max(0, (ws.locked[taker.base] ?? 0) - qty)
    ws.balances[taker.base] = (ws.balances[taker.base] ?? 0) - qty
    ws.balances[taker.quote] = (ws.balances[taker.quote] ?? 0) + quotePay
    if (
      free(wb, taker.quote) < 0 ||
      free(wb, taker.base) < 0 ||
      free(ws, taker.base) < 0 ||
      free(ws, taker.quote) < 0
    ) {
      // כנות: אי-עקביות-נעילות — לא ממציאים כסף; מפסיקים-התאמה (המצב נשאר-גלוי בספר)
      store.log(`🚨 אי-עקביות-נעילות בהתאמה (${buyerName}/${sellerName}) — מילוי-נעצר כן`)
      break
    }
    store.saveWallet(wb)
    store.saveWallet(ws)
    const makerFilled = maker.filledMu + qty
    store.setMakerProgress(maker.id, makerFilled, makerFilled >= maker.amountMu)
    store.insertFill({ base: taker.base, quote: taker.quote, side: taker.side, priceMu, amountMu: qty, buyer: buyerName, seller: sellerName })
    filledNow += qty
  }
  return filledNow
}

// ── גמר-פקודת-הטאקר: סטטוס + שחרור-נעילת-שארית-IOC ────────────────────────────
// נחלץ ממטפל-ה-order ב-index.ts; תיקון-Task-132: שחרור-שארית-IOC בקנייה חייב
// remainder×priceMu (הנעילה הייתה amountMu×priceMu) — היה remainder בלבד,
// מה ששרף remainder×(priceMu−1) µ-quote בנעילה-לנצח. מכירה: remainder-qty בדיוק.
export function finalizeTaker(
  o: Pick<Order, 'issuer' | 'side' | 'base' | 'quote' | 'priceMu' | 'amountMu' | 'filledMu' | 'ioc'>,
  filledNow: number,
  store: DexStore,
): { filledMu: number; status: string } {
  const filledMu = o.filledMu + filledNow
  let status: string = filledMu >= o.amountMu ? 'filled' : 'open'
  if (o.ioc === 1 && filledMu < o.amountMu) {
    status = 'canceled'
    const w = store.getWallet(o.issuer)
    if (w) {
      const payAsset = o.side === 'buy' ? o.quote : o.base
      const remainder = o.amountMu - filledMu
      const unlock = o.side === 'buy' ? remainder * o.priceMu : remainder
      w.locked[payAsset] = Math.max(0, (w.locked[payAsset] ?? 0) - unlock)
      store.saveWallet(w)
    }
  }
  return { filledMu, status }
}

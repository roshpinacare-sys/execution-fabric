// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/engine.test — סוויטה-דטרמיניסטית על ליבת-ההתאמה (Task-132, TDD-קנון)
// ═════════════════════════════════════════════════════════════════════════════
// כל-בדיקה סגורה, בזיכרון, אפס-רשת ואפס-sqlite — חנות-מזויפת נאמנה-לסמנטיקה
// (getWallet מחזיר עותק-טרי בכל-קריאה, כמו-קריאת-שורה מה-db). כל-האינווריאנטים
// החתומים בראש engine.ts (I1–I7) מוכחים כאן, כולל הוכחת-תיקון ה-IOC-קנייה.
// הרצה: bun test mini-services/saos-dex/
import { describe, expect, test } from 'bun:test'
import { finalizeTaker, free, matchOrderCore, type DexStore, type Order, type WalletRec } from './engine'

const BASE = 'WSTEEM'
const QUOTE = 'USDS'

function mkStore(wallets: Record<string, Record<string, number>>) {
  const W: Record<string, WalletRec> = {}
  for (const [n, b] of Object.entries(wallets)) W[n] = { name: n, credits: 0, balances: { ...b }, locked: {} }
  const orders: Order[] = []
  const fills: { priceMu: number; amountMu: number; buyer: string; seller: string }[] = []
  let seq = 0
  const store: DexStore = {
    listOpen(base, quote) {
      const open = orders
        .filter((o) => o.base === base && o.quote === quote && o.status === 'open')
        .sort((a, b) => a.priceMu - b.priceMu || a.id - b.id)
      return { asks: open.filter((o) => o.side === 'sell'), bids: open.filter((o) => o.side === 'buy').reverse() }
    },
    getWallet: (n) => (W[n] ? structuredClone(W[n]) : null),
    saveWallet: (w) => {
      W[w.name] = structuredClone(w)
    },
    markFilledIfComplete: (id) => {
      const o = orders.find((x) => x.id === id)
      if (o && o.filledMu >= o.amountMu) o.status = 'filled'
    },
    setMakerProgress: (id, filledMu, complete) => {
      const o = orders.find((x) => x.id === id)
      if (o) {
        o.filledMu = filledMu
        if (complete) o.status = 'filled'
      }
    },
    insertFill: (f) => fills.push({ ...f }),
    log: () => {},
  }
  const addOrder = (o: Partial<Order> & Pick<Order, 'side' | 'priceMu' | 'amountMu' | 'issuer'>): Order => {
    const rec: Order = { id: ++seq, base: BASE, quote: QUOTE, filledMu: 0, postOnly: 0, ioc: 0, status: 'open', createdAt: 't', ...o }
    orders.push(rec)
    return rec
  }
  const lock = (name: string, asset: string, mu: number) => {
    W[name].locked[asset] = (W[name].locked[asset] ?? 0) + mu
  }
  const totals = (asset: string) => Object.values(W).reduce((s, w) => s + (w.balances[asset] ?? 0), 0)
  return { store, W, fills, addOrder, lock, totals }
}

describe('saos-dex matching core — invariants I1–I7', () => {
  test('I1: עסקה במחיר-המייקר + עדיפות מחיר-זמן על-פני-שני-מייקרים', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, m2: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.addOrder({ side: 'sell', priceMu: 101, amountMu: 100, issuer: 'm2' })
    s.lock('m1', BASE, 100)
    s.lock('m2', BASE, 100)
    s.lock('buyer', QUOTE, 150 * 105)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 150, issuer: 'buyer' })
    const filled = matchOrderCore(taker, s.store)
    expect(filled).toBe(150)
    expect(s.fills).toHaveLength(2)
    expect(s.fills[0]!.priceMu).toBe(100) // מייקר-הראשון-במחיר-זמן, עסקה-במחירו
    expect(s.fills[0]!.amountMu).toBe(100)
    expect(s.fills[1]!.priceMu).toBe(101) // השארית-אצל-המייקר-הבא
    expect(s.fills[1]!.amountMu).toBe(50)
  })

  test('I2: הקונה-החוצה-פאריטי משלם-מחיר-מייקר ונעילתו משוחררת-במחיר-פקודתו', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.lock('m1', BASE, 100)
    s.lock('buyer', QUOTE, 50 * 105)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 50, issuer: 'buyer' })
    matchOrderCore(taker, s.store)
    const b = s.W['buyer']!
    expect(b.balances[QUOTE]).toBe(20_000 - 50 * 100) // שילם 100 (מחיר-מייקר), לא 105
    expect(b.locked[QUOTE]).toBe(0) // שוחרר 50×105 — מלוא-הנעילה-שלו
    expect(b.balances[BASE]).toBe(50)
    expect(free(b, QUOTE)).toBe(20_000 - 50 * 100) // פאריטי: ההפרש (50×5) נשאר-חופשי
  })

  test('I3: המוכר — שחרור-נעילת-בסיס בדיוק-qty, קבלת-quote במחיר-העסקה', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.lock('m1', BASE, 100)
    s.lock('buyer', QUOTE, 50 * 105)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 50, issuer: 'buyer' })
    matchOrderCore(taker, s.store)
    const m = s.W['m1']!
    expect(m.locked[BASE]).toBe(50) // שוחרר בדיוק qty
    expect(m.balances[BASE]).toBe(50)
    expect(m.balances[QUOTE]).toBe(50 * 100) // במחיר-העסקה
  })

  test('I4: שימור-כספים — Σבסיס ו-Σquote קבועים-לאורך-התאמה-מרובת-מילויים', () => {
    const s = mkStore({
      m1: { WSTEEM: 100, USDS: 0 },
      m2: { WSTEEM: 100, USDS: 0 },
      buyer: { USDS: 20_000 },
      bystander: { WSTEEM: 7, USDS: 11 },
    })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.addOrder({ side: 'sell', priceMu: 101, amountMu: 100, issuer: 'm2' })
    s.lock('m1', BASE, 100)
    s.lock('m2', BASE, 100)
    s.lock('buyer', QUOTE, 150 * 105)
    const baseBefore = s.totals(BASE)
    const quoteBefore = s.totals(QUOTE)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 150, issuer: 'buyer' })
    matchOrderCore(taker, s.store)
    expect(s.totals(BASE)).toBe(baseBefore)
    expect(s.totals(QUOTE)).toBe(quoteBefore)
  })

  test('I5-fix: IOC-קנייה — שארית משוחררת remainder×priceMu (היה remainder בלבד → כסף-נעול-לנצח)', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.lock('m1', BASE, 100)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 150, issuer: 'buyer', ioc: 1 })
    s.lock('buyer', QUOTE, 150 * 105) // נעילת-הפקודה המלאה: amount×price
    const filled = matchOrderCore(taker, s.store)
    expect(filled).toBe(100) // 100 נמלאו; שארית 50
    const fin = finalizeTaker(taker, filled, s.store)
    expect(fin.status).toBe('canceled')
    const b = s.W['buyer']!
    expect(b.locked[QUOTE]).toBe(0) // ← התיקון: 50×105 שוחררו; הבאג-הישן היה משאיר 50×104=5200 תקועים
    expect(free(b, QUOTE)).toBe(20_000 - 100 * 100)
  })

  test('I5: IOC-מכירה — שארית משוחררת remainder-qty בדיוק', () => {
    const s = mkStore({ m1: { WSTEEM: 150, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'buy', priceMu: 100, amountMu: 100, issuer: 'buyer' })
    s.lock('buyer', QUOTE, 100 * 100)
    const taker = s.addOrder({ side: 'sell', priceMu: 100, amountMu: 150, issuer: 'm1', ioc: 1 })
    s.lock('m1', BASE, 150)
    const filled = matchOrderCore(taker, s.store)
    expect(filled).toBe(100)
    const fin = finalizeTaker(taker, filled, s.store)
    expect(fin.status).toBe('canceled')
    const m = s.W['m1']!
    expect(m.locked[BASE]).toBe(0) // 150 ננעלו; 100 שוחררו-במילוי + 50 בגמר
  })

  test('I6: שומר-העקביות — free<0 מוכח עוצר-התאמה לפני-שמירה; אפס-המצאת-כסף', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    // שקר-נעילות מושתל: המוכר נועל יותר ממה שיש לו — העסקה הייתה מכניסה אותו ל-free<0
    s.W['m1']!.locked[BASE] = 200
    s.lock('buyer', QUOTE, 50 * 105)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 50, issuer: 'buyer' })
    const filled = matchOrderCore(taker, s.store)
    expect(filled).toBe(0) // נעצר-מיד
    expect(s.fills).toHaveLength(0) // אף-מילוי-לא-נרשם
    expect(s.W['m1']!.balances[BASE]).toBe(100) // אף-יתרה-לא-נגעה
    expect(s.W['buyer']!.balances[QUOTE]).toBe(20_000)
  })

  test('I7: אפס-צפים — כל-יתרות-הכסף אחרי-התאמה-מרובה הן שלמות', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, m2: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.addOrder({ side: 'sell', priceMu: 101, amountMu: 100, issuer: 'm2' })
    s.lock('m1', BASE, 100)
    s.lock('m2', BASE, 100)
    s.lock('buyer', QUOTE, 150 * 105)
    const taker = s.addOrder({ side: 'buy', priceMu: 105, amountMu: 150, issuer: 'buyer' })
    matchOrderCore(taker, s.store)
    for (const w of Object.values(s.W)) {
      for (const v of [...Object.values(w.balances), ...Object.values(w.locked)]) {
        expect(Number.isInteger(v)).toBe(true)
      }
    }
  })

  test('לא-חוצה → אפס-מילוי, הספר-נח; ומייקר-שנשכח-מלא מסומן filled', () => {
    const s = mkStore({ m1: { WSTEEM: 100, USDS: 0 }, buyer: { USDS: 20_000 } })
    const maker = s.addOrder({ side: 'sell', priceMu: 100, amountMu: 100, issuer: 'm1' })
    s.lock('m1', BASE, 100)
    s.lock('buyer', QUOTE, 50 * 99)
    const resting = s.addOrder({ side: 'buy', priceMu: 99, amountMu: 50, issuer: 'buyer' })
    expect(matchOrderCore(resting, s.store)).toBe(0) // 99 < 100 — לא-חוצה
    // מייקר-שנשכח: מלא-בפועל אך status עדיין open → markFilledIfComplete מסמן
    maker.filledMu = maker.amountMu
    s.store.markFilledIfComplete(maker.id)
    expect(maker.status).toBe('filled')
  })
})

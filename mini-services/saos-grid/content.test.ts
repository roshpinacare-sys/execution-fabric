// ═════════════════════════════════════════════════════════════════════════════
// content.test.ts — בונה-תוכן-טהור + שער-כספת-posting (דירקטיבת-141 §4 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// היקף-כנה: בקוד-הבית לא-היה-פרימיטיב-שידור-תוכן (נבדק: harvest/hive/fleet — vote/
// claim/transfer/delegate בלבד) → נוסף-בונה-טהור-ומדויק והשידור-עצמו נעול-מאחורי
// חוק-הכספת (precedent-רכבת-HIVE): המפתח-ה-posting-בכספת חייב-להיות-מוכח-בסמכות-
// ה-posting-על-השרשרת — נמדד-חי-בטרם-כל-שידור, אף-פוסט-אוטומטי (אפס-ספאם).
//
// וקטור-השרשרת ל-op-comment (id=1): trx 9be6db47… (בלוק 110585258) —
// condenser_api.get_transaction_hex, הוקס-מלא-נעול-ב-steem-tx.test.ts.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { buildContentOp, postingCustodyDecision, type PostingAuthorityShape } from './content'

describe('buildContentOp — בונה-הערה/פוסט טהור-ומדויק (בלי-I/O)', () => {
  test('פוסט-שורש תקין → op-מדויק (parentAuthor ריק, parentPermlink=תג)', () => {
    const r = buildContentOp({
      author: 'saos-0001',
      permlink: 'saos-grid-cycle-report-1',
      title: 'דוח מחזור',
      body: 'גוף-הדוח',
      parentPermlink: 'life',
      jsonMetadata: '{"app":"saos-grid/1.0"}',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.comment.parentAuthor).toBe('')
      expect(r.comment.parentPermlink).toBe('life')
      expect(r.comment.author).toBe('saos-0001')
      expect(r.comment.permlink).toBe('saos-grid-cycle-report-1')
      expect(r.comment.title).toBe('דוח מחזור')
      expect(r.comment.body).toBe('גוף-הדוח')
      expect(r.comment.jsonMetadata).toBe('{"app":"saos-grid/1.0"}')
    }
  })

  test('תגובה להורה קיים → parentAuthor ממולא, parentPermlink=permlink-ההורה', () => {
    const r = buildContentOp({
      author: 'saos-0002',
      permlink: 're-root-1',
      title: '',
      body: 'תשובה',
      parentAuthor: 'blakemag',
      parentPermlink: 'tn51bp',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.comment.parentAuthor).toBe('blakemag')
      expect(r.comment.parentPermlink).toBe('tn51bp')
      expect(r.comment.title).toBe('')
      expect(r.comment.jsonMetadata).toBe('{}') // ברירת-מחדל-כנה
    }
  })

  test('fail-closed: פוסט-שורש-בלי-תג-הורה → נדחה (לא-מנחשים-תג)', () => {
    const r = buildContentOp({ author: 'saos-0001', permlink: 'p', title: 't', body: 'b' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('root-post-needs-parent-permlink-tag')
  })

  test('fail-closed: permlink-פסול (אותיות-גדולות/רווח/ריק/רק-ספרות-אסורים-לא-כאן-אבל-גדולות-כן)', () => {
    expect(buildContentOp({ author: 'a', permlink: 'Bad Permlink', title: 't', body: 'b', parentPermlink: 'life' }).ok).toBe(false)
    expect(buildContentOp({ author: 'a', permlink: '', title: 't', body: 'b', parentPermlink: 'life' }).ok).toBe(false)
    expect(buildContentOp({ author: 'a', permlink: 'x'.repeat(256), title: 't', body: 'b', parentPermlink: 'life' }).ok).toBe(false)
  })

  test('fail-closed: author-פסול / גוף-ריק / גוף-ענק / כותרת-ענקית / metadata-ענק', () => {
    const base = { permlink: 'p', title: 't', body: 'b', parentPermlink: 'life' }
    expect(buildContentOp({ ...base, author: 'Bad Author' }).ok).toBe(false)
    expect(buildContentOp({ ...base, author: 'ab' }).ok).toBe(false) // קצר-מדי
    expect(buildContentOp({ ...base, author: 'saos-0001', body: '' }).ok).toBe(false)
    expect(buildContentOp({ ...base, author: 'saos-0001', body: 'x'.repeat(65_537) }).ok).toBe(false)
    expect(buildContentOp({ ...base, author: 'saos-0001', title: 'x'.repeat(257) }).ok).toBe(false)
    expect(buildContentOp({ ...base, author: 'saos-0001', jsonMetadata: 'x'.repeat(2_049) }).ok).toBe(false)
  })
})

describe('postingCustodyDecision — חוק-הכספת (precedent-רכבת-HIVE, fail-closed)', () => {
  const authority: PostingAuthorityShape = {
    threshold: 1,
    key_auths: [['STM6u99ogJKoVrRzEyAqBmkxqrBdPWYVKqz1YwcaVJRsXnNCJKBiH', 1]],
  }

  test('אין-מפתח-בכספת → נעול-כנה', () => {
    expect(postingCustodyDecision(null, authority)).toEqual({ ok: false, reason: 'no-vault-key' })
  })

  test('סמכות-לא-נקראה-מהשרשרת → נעול-כנה (לא-מאמינים-בזיכרון)', () => {
    expect(postingCustodyDecision('STM6u99ogJKoVrRzEyAqBmkxqrBdPWYVKqz1YwcaVJRsXnNCJKBiH', null)).toEqual({ ok: false, reason: 'authority-unreadable' })
  })

  test('המפתח-לא-בסמכות → נעול-כנה (השרשרת-היא-הסמכות)', () => {
    expect(postingCustodyDecision('STM8m3rBLd8CA2KzLE9xyKHqBWLAXwooRtUJoZqnVebcbAsBPNcRp', authority)).toEqual({ ok: false, reason: 'pubkey-not-in-posting-authority' })
  })

  test('המפתח-בסמכות-אך-משקלו-מתחת-לסף → נעול-כנה', () => {
    const gated: PostingAuthorityShape = { threshold: 2, key_auths: [['STM6u99ogJKoVrRzEyAqBmkxqrBdPWYVKqz1YwcaVJRsXnNCJKBiH', 1]] }
    expect(postingCustodyDecision('STM6u99ogJKoVrRzEyAqBmkxqrBdPWYVKqz1YwcaVJRsXnNCJKBiH', gated)).toEqual({ ok: false, reason: 'key-weight-below-threshold' })
  })

  test('המפתח-בסמכות-ובמשקל-מלא → השער-נפתח-אוטומטית (custody-ok)', () => {
    expect(postingCustodyDecision('STM6u99ogJKoVrRzEyAqBmkxqrBdPWYVKqz1YwcaVJRsXnNCJKBiH', authority)).toEqual({ ok: true, reason: 'custody-ok' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// content.ts — בונה-תוכן-טהור + חוק-הכספת-posting (דירקטיבת-141 §4 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §3: "content broadcasting" — ההיקף-הכנה: לא-היה-פרימיטיב-שידור-
// תוכן-בבית (נבדק: harvest/hive/fleet-כולם vote/claim/transfer/delegate) → כאן-נבנה
// הבונה-הטהור (op-comment = id 1, וקטור-השרשרת-נעול-ב-steem-tx.test.ts), והשידור-
// עצמו נעול-מאחורי-חוק-הכספת (precedent-רכבת-HIVE Task-137): המפתח-ה-posting-שבכספת
// חייב-להיות-מוכח-בסמכות-ה-posting-על-השרשרת-עצמה — נמדד-חי-בטרם-כל-שידור.
//
// מדיניות-אפס-ספאם: אין-פעימה-אוטומטית-ואין-לולאת-פרסום — שידור-תוכן מתרחש רק
// בבקשה-ידנית-מאומתת-סמכות (organAuth) אחת-בכל-קריאה, ורק-כשהשער-הקריפטוגרפי-פתוח.
// ═════════════════════════════════════════════════════════════════════════════
import type { CommentOp } from './steem-tx'

export interface ContentOpInput {
  author: string
  permlink: string
  title: string
  body: string
  /** '' = פוסט-שורש; אחרת — התגובה-מגיבה-להורה-זה */
  parentAuthor?: string
  /** לשורש: תג-האב (חובה-כנה — לא-מנחשים-תג); לתגובה: permlink-ההורה */
  parentPermlink?: string
  jsonMetadata?: string
}

export type ContentOpResult = { ok: true; comment: CommentOp } | { ok: false; error: string }

const AUTHOR_RE = /^[a-z0-9.-]{3,16}$/
const PERMLINK_RE = /^[a-z0-9-]+$/

/** בונה-טהור: קלט-מאומת → op-comment מדויק. כל-קלט-פגום = דחייה-כנה-מיועדת (fail-closed). */
export function buildContentOp(inp: ContentOpInput): ContentOpResult {
  const author = String(inp.author ?? '')
  const permlink = String(inp.permlink ?? '')
  const title = String(inp.title ?? '')
  const body = String(inp.body ?? '')
  const parentAuthor = String(inp.parentAuthor ?? '')
  const parentPermlink = String(inp.parentPermlink ?? '')
  const jsonMetadata = inp.jsonMetadata === undefined ? '{}' : String(inp.jsonMetadata)

  if (!AUTHOR_RE.test(author)) return { ok: false, error: `author-invalid (${JSON.stringify(author.slice(0, 24))})` }
  if (!PERMLINK_RE.test(permlink) || permlink.length > 255)
    return { ok: false, error: `permlink-invalid (${JSON.stringify(permlink.slice(0, 24))})` }
  if (parentAuthor !== '' && !AUTHOR_RE.test(parentAuthor)) return { ok: false, error: 'parent-author-invalid' }
  if (parentAuthor === '' && parentPermlink === '')
    return { ok: false, error: 'root-post-needs-parent-permlink-tag (לא-מנחשים-תג)' }
  if (parentPermlink !== '' && (!PERMLINK_RE.test(parentPermlink) || parentPermlink.length > 255))
    return { ok: false, error: 'parent-permlink-invalid' }
  if (title.length > 256) return { ok: false, error: 'title-too-long (256-מקסימום)' }
  if (body.length < 1) return { ok: false, error: 'body-empty' }
  if (body.length > 65_536) return { ok: false, error: 'body-too-long (65536-מקסימום)' }
  if (jsonMetadata.length > 2_048) return { ok: false, error: 'json-metadata-too-long (2048-מקסימום)' }

  return {
    ok: true,
    comment: {
      parentAuthor,
      parentPermlink: parentAuthor === '' ? parentPermlink : parentPermlink,
      author,
      permlink,
      title,
      body,
      jsonMetadata,
    },
  }
}

// ── חוק-הכספת (precedent-רכבת-HIVE) ──────────────────────────────────────────

export interface PostingAuthorityShape {
  threshold: number
  key_auths: Array<[string, number]>
}

export interface CustodyDecision {
  ok: boolean
  reason: 'custody-ok' | 'no-vault-key' | 'authority-unreadable' | 'pubkey-not-in-posting-authority' | 'key-weight-below-threshold'
}

/** החלטה-טהורה: המפתח-הפומבי-שבכספת חייב-להופיע-בסמכות-ה-posting-שעל-השרשרת
 *  במשקל-המספיק-לסף. לא-נמדד = נעול (fail-closed — השרשרת-היא-הסמכות). */
export function postingCustodyDecision(vaultPubkey: string | null, authority: PostingAuthorityShape | null | undefined): CustodyDecision {
  if (!vaultPubkey) return { ok: false, reason: 'no-vault-key' }
  if (!authority || !Array.isArray(authority.key_auths) || !Number.isFinite(authority.threshold)) {
    return { ok: false, reason: 'authority-unreadable' }
  }
  const hit = authority.key_auths.find(([pub]) => pub === vaultPubkey)
  if (!hit) return { ok: false, reason: 'pubkey-not-in-posting-authority' }
  if (hit[1] < authority.threshold) return { ok: false, reason: 'key-weight-below-threshold' }
  return { ok: true, reason: 'custody-ok' }
}

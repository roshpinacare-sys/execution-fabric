import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { classify, type ErrorClass } from '@/lib/llm-chain'

// מסילת-ההקראה (worklog Task 39) — השימוש-הראשון-המוצדק בכלי-SDK-TTS:
// תוכן-עברית שנולד בעורק-הבנייה (Improvement APPLIED/CONTENT) מוקרא לקובץ-אודיו אמיתי.
//
// דיסציפלינה (כמו כל-הרשת):
// - ירי-אמת בלבד: z-ai-web-dev-sdk → zai.audio.tts.create (backend בלבד) — אפס-המצאה,
//   כל-כשל כן ({ok:false,error,errorClass}) ונרשם בשרשרת (NARRATE FAILED).
// - אידימפוטנטיות: לכל-שיפור הקראה אחת — הצהרה במניפסט (sovereign/site/narrations.json,
//   נדחף-לגיט ע"י פעימת-הגיט) + אימות-קיום-קובץ. אם-המניפסט-כן-והקובץ-נעלם → ירי-מחדש (ריפוי-עצמי).
// - אפס-סכימה-חדשה: השרשרת-הקנונית קפואה; המניפסט = קובץ-גיט-נגזר, השיוך לשיפור = המפתח-במניפסט.
// - אילוצי-API כנים: עד-1024 תווים לירייה (מקראה = כותרת+תקציר — קצר במכוון), speed 0.5–2.0,
//   stream:false ל-wav (streaming = pcm בלבד — לא נדרש כאן).

export const TTS_VOICE = 'tongtong'
export const TTS_SPEED = 1.0
export const TTS_MAX_CHARS = 1000 // מתחת-לתקרת-ה-API (1024) — מרווח-כנות
// פורמט-אמת: הספק-דחה mp3 בירי-ראשון (1214 — response_format לא-נתמך, נרשם-FAILED בשרשרת);
// wav = פורמט-ברירת-המחדל-המאומת בסקיל, מתאר-עצמו (24kHz) — הפורמט-הכן.
export const TTS_FORMAT = 'wav'

export const AUDIO_DIR_REL = 'sovereign/site/audio'
export const MANIFEST_REL = 'sovereign/site/narrations.json'
export const audioExtension = (): string => `.${TTS_FORMAT}`

export interface NarrationManifestItem {
  audioPath: string
  sizeBytes: number
  voice: string
  speed: number
  textChars: number
  narratedAt: string
  worker: string
}

export interface NarrationManifest {
  version: 1
  items: Record<string, NarrationManifestItem>
}

export function readNarrationManifest(): NarrationManifest {
  const abs = path.join(process.cwd(), MANIFEST_REL)
  try {
    if (!existsSync(abs)) return { version: 1, items: {} }
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as NarrationManifest
    if (raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object') {
      return { version: 1, items: raw.items }
    }
    return { version: 1, items: {} }
  } catch {
    // מניפסט-פגום = אין-הצהרות (לא שקר, לא קריסה) — ירי-מחדש ירפא
    return { version: 1, items: {} }
  }
}

function writeManifest(m: NarrationManifest): void {
  const abs = path.join(process.cwd(), MANIFEST_REL)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(m, null, 2) + '\n', 'utf8')
}

export function audioFileAbs(improvementId: number): string {
  return path.join(process.cwd(), AUDIO_DIR_REL, `improvement-${improvementId}${audioExtension()}`)
}

// מקראה-עברית נקייה: כותרת+תקציר, בלי-סימון-markdown, בלי-גרשיים-משוננים-בעייתיים
function narrationText(title: string, summary: string): string {
  const clean = (s: string) =>
    s
      .replace(/[#*`_>\[\]()~|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const text = `${clean(title)}. ${clean(summary)}.`
  if (text.length <= TTS_MAX_CHARS) return text
  // חיתוך-בגבול-מילה (כנות: מה-שייחתך לא נקרא — וה-אורך-המדווח יאמת)
  return text.slice(0, TTS_MAX_CHARS).replace(/\s+\S*$/, '') + '.'
}

export type NarrationResult =
  | { ok: true; already: boolean; improvementId: number; audioPath: string; sizeBytes: number; durationMs: number; ledgerId: number | null }
  | { ok: false; error: string; errorClass: ErrorClass; improvementId: number | null; durationMs: number }

// הקראת-שיפור אחד: אידימפוטנטי, ירי-TTS אמיתי, ארטיפקט-קובץ + מניפסט + חתימת-שרשרת.
export async function narrateImprovement(improvementId: number): Promise<NarrationResult> {
  const t0 = Date.now()

  const imp = await db.improvement.findUnique({ where: { id: improvementId } })
  if (!imp) {
    return {
      ok: false,
      error: `invalid: improvement ${improvementId} not found`,
      errorClass: 'invalid',
      improvementId: null,
      durationMs: Date.now() - t0,
    }
  }
  // הקראה = תוכן-מיושם בלבד (מה-שהאתר מציג-באמת)
  if (imp.kind !== 'CONTENT' || imp.status !== 'APPLIED') {
    return {
      ok: false,
      error: `invalid: improvement ${improvementId} is ${imp.kind}/${imp.status} — only APPLIED CONTENT is narratable`,
      errorClass: 'invalid',
      improvementId,
      durationMs: Date.now() - t0,
    }
  }

  // אידימפוטנטיות: הצהרה-קיימת + קובץ-חי = אין-ירי-כפול
  const manifest = readNarrationManifest()
  const declared = manifest.items[String(improvementId)]
  if (declared && existsSync(audioFileAbs(improvementId))) {
    return {
      ok: true,
      already: true,
      improvementId,
      audioPath: declared.audioPath,
      sizeBytes: declared.sizeBytes,
      durationMs: 0,
      ledgerId: null,
    }
  }

  const text = narrationText(imp.title, imp.summary)

  // ירי-אמת (SDK backend בלבד). Response סטנדרטי → arrayBuffer → Buffer.
  let buffer: Buffer
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    const zai = await ZAI.create()
    const response = await zai.audio.tts.create({
      input: text,
      voice: TTS_VOICE,
      speed: TTS_SPEED,
      response_format: TTS_FORMAT,
      stream: false,
    })
    const arrayBuffer = await response.arrayBuffer()
    buffer = Buffer.from(new Uint8Array(arrayBuffer))
  } catch (e) {
    const errorClass = classify(e)
    const error = e instanceof Error ? e.message : String(e)
    // כשל-כן בשרשרת — אפס-הסתרה
    try {
      await appendLedger({
        taskId: null,
        kind: 'NARRATE',
        status: 'FAILED',
        worker: `sdk-tts:${TTS_VOICE}`,
        attempts: 1,
        durationMs: Date.now() - t0,
        errorClass,
        outputHash: sha256Short(`NARRATE_FAILED:${improvementId}:${error}`),
      })
    } catch {
      /* השרשרת-עצמה נפלה — הכשל-הכן נשאר בתשובה */
    }
    return {
      ok: false,
      error: `tts-fire failed: ${error}`,
      errorClass,
      improvementId,
      durationMs: Date.now() - t0,
    }
  }

  // תקינות-אמת: אודיו-ריק/קטן-מדי = כשל-כן (empty-output), לא ארטיפקט-שקרי
  if (buffer.length < 1000) {
    try {
      await appendLedger({
        taskId: null,
        kind: 'NARRATE',
        status: 'FAILED',
        worker: `sdk-tts:${TTS_VOICE}`,
        attempts: 1,
        durationMs: Date.now() - t0,
        errorClass: 'empty-output',
        outputHash: sha256Short(`NARRATE_EMPTY:${improvementId}:${buffer.length}`),
      })
    } catch {
      /* השרשרת-עצמה נפלה — הכשל-הכן נשאר בתשובה */
    }
    return {
      ok: false,
      error: `empty-output: tts returned only ${buffer.length} bytes — refusing to fabricate audio`,
      errorClass: 'empty-output',
      improvementId,
      durationMs: Date.now() - t0,
    }
  }

  // ארטיפקט-אמת: קובץ-אודיו + הצהרה במניפסט (נדחף-לגיט ע"י פעימת-הגיט)
  const abs = audioFileAbs(improvementId)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, buffer)
  const relAudio = `${AUDIO_DIR_REL}/improvement-${improvementId}${audioExtension()}`
  const item: NarrationManifestItem = {
    audioPath: relAudio,
    sizeBytes: buffer.length,
    voice: TTS_VOICE,
    speed: TTS_SPEED,
    textChars: text.length,
    narratedAt: new Date().toISOString(),
    worker: `sdk-tts:${TTS_VOICE}`,
  }
  const nextManifest = readNarrationManifest()
  nextManifest.items[String(improvementId)] = item
  writeManifest(nextManifest)

  const entry = await appendLedger({
    taskId: null,
    kind: 'NARRATE',
    status: 'DONE',
    worker: item.worker,
    attempts: 1,
    durationMs: Date.now() - t0,
    errorClass: null,
    outputHash: sha256Short(buffer.toString('base64')),
  })

  return {
    ok: true,
    already: false,
    improvementId,
    audioPath: relAudio,
    sizeBytes: buffer.length,
    durationMs: Date.now() - t0,
    ledgerId: entry.id,
  }
}

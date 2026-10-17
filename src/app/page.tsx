'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import {
  Network,
  Bot,
  Send,
  Play,
  RotateCcw,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  HeartPulse,
  Code2,
  SearchCheck,
  ListChecks,
  Terminal,
  Users,
  Layers,
  CheckCircle2,
  AlertTriangle,
  GitBranch,
  Upload,
  ExternalLink,
  Sparkles,
  BarChart3,
} from 'lucide-react'

// ===== טיפוסים =====

type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'
type TaskKind = 'CODE' | 'AUDIT' | 'PLAN'

interface TaskDto {
  id: string
  title: string
  kind: TaskKind
  prompt: string
  repo: string | null
  status: TaskStatus
  worker: string | null
  output: string | null
  error: string | null
  errorClass: string | null
  attempts: number
  durationMs: number | null
  lens: string | null
  role: string | null
  batchId: string | null
  createdAt: string
  updatedAt: string
}

interface LedgerEntryDto {
  id: number
  taskId: string | null
  kind: string
  status: string
  worker: string
  attempts: number
  durationMs: number
  errorClass: string | null
  outputHash: string
  prev: string
  hash: string
  createdAt: string
}

interface LedgerDto {
  ok: boolean
  total: number
  verify: { ok: boolean; head: string; brokenAt: number | null; verified: number }
  recent: LedgerEntryDto[]
}

interface RailsDto {
  zai: boolean
  nvidia: {
    present: boolean
    baseUrl: string | null
    preferredModel: string | null
    documented: string[]
  }
  ipai: { present: boolean; verified: false; note: string }
}

interface BatchDto {
  batchId: string
  total: number
  done: number
  failed: number
  pending: number
  kinds: string[]
  createdAt: string
  summary: { hash: string; status: string } | null
}

interface DrillRailResult {
  rail: string
  ok: boolean
  ms: number
  errorClass: string | null
}

// התפתחות-עצמית (Task 26)
interface EvolutionRecentDto {
  id: string
  title: string
  kind: TaskKind
  status: TaskStatus
  worker: string | null
  errorClass: string | null
  durationMs: number | null
  createdAt: string
}

interface EvolutionDto {
  ok: boolean
  budget: { used: number; cap: number }
  counts: { total: number; done: number; failed: number; queued: number }
  recent: EvolutionRecentDto[]
}

interface MetricsDto {
  ok: boolean
  generatedAt: string
  ledger: {
    total: number
    done: number
    failed: number
    verify: { ok: boolean; head: string; brokenAt: number | null; verified: number }
    byKind: Record<string, number>
    avgByKind: { kind: string; done: number; avgMs: number | null }[]
    errorClasses: Record<string, number>
    ladder: { firstTry: number; activations: number; activationRatePct: number }
  }
  queue: { queued: number; running: number }
  tasks: { total: number; fromEvolution: number; fromHuman: number }
  workers: { name: string; shots: number; avgMs: number }[]
}

interface HandoffDto {
  id: string
  taskId: string
  repo: string
  path: string
  branch: string | null
  message: string
  field: string | null
  status: 'PROPOSED' | 'APPROVED' | 'RUNNING' | 'DONE' | 'FAILED' | 'WITHDRAWN'
  artifactHash: string | null
  artifactSize: number | null
  commitSha: string | null
  verified: boolean | null
  error: string | null
  errorClass: string | null
  attempts: number
  durationMs: number | null
  createdAt: string
  task: { title: string; kind: TaskKind; repo: string | null }
}

const KIND_LABEL: Record<TaskKind, string> = {
  CODE: 'כתיבת-קוד',
  AUDIT: 'ביקורת/אבטחה',
  PLAN: 'תוכנית-עבודה',
}

// העתקת-לייבל בלבד — lib/fleet נושא SDK ולכן לא ניבט מהצד-לקוח
const LENS_LABEL: Record<string, string> = {
  CORRECTNESS: 'נכונות',
  SECURITY: 'אבטחה',
  PERFORMANCE: 'ביצועים',
  STYLE: 'תחזוקה',
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  QUEUED: 'בתור',
  RUNNING: 'רצה',
  DONE: 'הושלמה',
  FAILED: 'נכשלה',
}

const HANDOFF_STATUS_LABEL: Record<HandoffDto['status'], string> = {
  PROPOSED: 'ממתין-אישור',
  APPROVED: 'מאושר',
  RUNNING: 'מועבר',
  DONE: 'הועבר',
  FAILED: 'נכשל',
  WITHDRAWN: 'נמשך',
}

function HandoffStatusBadge({ status }: { status: HandoffDto['status'] }) {
  const cls =
    status === 'DONE'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
      : status === 'FAILED'
        ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
        : status === 'PROPOSED'
          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
          : status === 'APPROVED'
            ? 'bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/30'
            : status === 'WITHDRAWN'
              ? 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30'
              : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${cls}`}>
      {status === 'RUNNING' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {HANDOFF_STATUS_LABEL[status]}
    </Badge>
  )
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ===== כרטיסי-סטטוס =====

function StatusBadge({ status }: { status: TaskStatus }) {
  const cls =
    status === 'DONE'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
      : status === 'RUNNING'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
        : status === 'FAILED'
          ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
          : 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30'
  return (
    <Badge variant="outline" className={`gap-1 ${cls}`}>
      {status === 'RUNNING' && <Loader2 className="h-3 w-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </Badge>
  )
}

function KindBadge({ kind }: { kind: TaskKind }) {
  const icon =
    kind === 'CODE' ? <Code2 className="h-3 w-3" /> : kind === 'AUDIT' ? <SearchCheck className="h-3 w-3" /> : <ListChecks className="h-3 w-3" />
  return (
    <Badge variant="outline" className="gap-1 border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400">
      {icon}
      {KIND_LABEL[kind]}
    </Badge>
  )
}

// ===== תצוגת-תוצר =====

interface CodeOut { language: string; code: string; explanation: string }
interface AuditOut { verdict: string; findings: { severity: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; detail: string }[] }
interface PlanOut { steps: { title: string; detail: string }[] }

function isCode(d: unknown): d is CodeOut {
  const o = d as Record<string, unknown> | null
  return !!o && typeof o.language === 'string' && typeof o.code === 'string' && typeof o.explanation === 'string'
}
function isAudit(d: unknown): d is AuditOut {
  const o = d as Record<string, unknown> | null
  return !!o && typeof o.verdict === 'string' && Array.isArray(o.findings)
}
function isPlan(d: unknown): d is PlanOut {
  const o = d as Record<string, unknown> | null
  return !!o && Array.isArray(o.steps)
}

function OutputView({ kind, output }: { kind: TaskKind; output: string }) {
  let data: unknown = null
  try {
    data = JSON.parse(output)
  } catch {
    data = null
  }

  if (kind === 'CODE' && isCode(data)) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" dir="ltr" className="font-mono text-[10px]">
            {data.language}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{data.explanation}</p>
        <pre dir="ltr" className="rounded-md bg-zinc-950 text-zinc-100 text-xs leading-relaxed p-3 overflow-x-auto max-h-64">
          <code>{data.code}</code>
        </pre>
      </div>
    )
  }

  if (kind === 'AUDIT' && isAudit(data)) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium leading-relaxed">{data.verdict}</p>
        <div className="space-y-2">
          {data.findings.map((f, i) => (
            <div key={i} className="rounded-md border p-2.5 space-y-1">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    f.severity === 'HIGH'
                      ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
                      : f.severity === 'MEDIUM'
                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                        : 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30'
                  }`}
                >
                  {f.severity}
                </Badge>
                <span className="text-sm font-medium">{f.title}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{f.detail}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (kind === 'PLAN' && isPlan(data)) {
    return (
      <ol className="space-y-2 list-none">
        {data.steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-bold">
              {i + 1}
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-medium leading-snug">{s.title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <pre dir="ltr" className="rounded-md bg-zinc-950 text-zinc-100 text-xs p-3 overflow-x-auto max-h-64">
      <code>{output}</code>
    </pre>
  )
}

// ===== תצוגת-סינתזת צי (fleet-root) =====

interface SynthesisOut {
  consensus: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'CLEAN'
  agreements: { title: string; detail: string; lenses: string[] }[]
  conflicts: { title: string; detail: string; lenses: string[] }[]
}

function isSynthesis(d: unknown): d is SynthesisOut {
  const o = d as Record<string, unknown> | null
  return (
    !!o &&
    typeof o.consensus === 'string' &&
    typeof o.severity === 'string' &&
    Array.isArray(o.agreements) &&
    Array.isArray(o.conflicts)
  )
}

function LensChip({ lens }: { lens: string }) {
  return (
    <Badge
      variant="outline"
      className="text-[10px] border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400"
    >
      {LENS_LABEL[lens] ?? lens}
    </Badge>
  )
}

function SynthesisView({ output }: { output: string }) {
  let data: unknown = null
  try {
    data = JSON.parse(output)
  } catch {
    data = null
  }
  if (!isSynthesis(data)) {
    return (
      <pre dir="ltr" className="rounded-md bg-zinc-950 text-zinc-100 text-xs p-3 overflow-x-auto max-h-64">
        <code>{output}</code>
      </pre>
    )
  }
  const sevCls =
    data.severity === 'HIGH'
      ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
      : data.severity === 'MEDIUM'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
        : data.severity === 'LOW'
          ? 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30'
          : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">קונסנזוס הצי:</span>
        <Badge variant="outline" className={`text-[10px] ${sevCls}`}>
          חומרה: {data.severity}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed">{data.consensus}</p>
      {data.agreements.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">הסכמות ({data.agreements.length})</p>
          {data.agreements.map((a, i) => (
            <div key={i} className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="text-sm font-medium">{a.title}</span>
                <span className="flex flex-wrap gap-1 ms-auto">
                  {a.lenses.map((l, k) => (
                    <LensChip key={k} lens={l} />
                  ))}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{a.detail}</p>
            </div>
          ))}
        </div>
      )}
      {data.conflicts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">קונפליקטים בין-עדשות ({data.conflicts.length})</p>
          {data.conflicts.map((c, i) => (
            <div key={i} className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="text-sm font-medium">{c.title}</span>
                <span className="flex flex-wrap gap-1 ms-auto">
                  {c.lenses.map((l, k) => (
                    <LensChip key={k} lens={l} />
                  ))}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{c.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== כרטיס-משימה =====

function TaskCard({
  task,
  runningId,
  fleetRunningId,
  onRun,
  onRunFleet,
  onHandoff,
}: {
  task: TaskDto
  runningId: string | null
  fleetRunningId: string | null
  onRun: (id: string) => void
  onRunFleet: (id: string) => void
  onHandoff: (task: TaskDto) => void
}) {
  const busy = runningId === task.id || (task.status === 'RUNNING' && runningId !== null)
  const fleetBusy = fleetRunningId === task.id || (task.status === 'RUNNING' && task.role === 'fleet-root')
  const isWorker = task.role === 'worker'
  const isFleetRoot = task.role === 'fleet-root'
  const canRun = runningId === null && fleetRunningId === null
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={task.kind} />
        <StatusBadge status={task.status} />
        {isFleetRoot && (
          <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Users className="h-3 w-3" />
            צי · קונסנזוס
          </Badge>
        )}
        {isWorker && task.lens && (
          <Badge
            variant="outline"
            className={`text-[10px] ${task.status === 'RUNNING' ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400'}`}
          >
            עדשה: {LENS_LABEL[task.lens] ?? task.lens}
          </Badge>
        )}
        {task.repo && (
          <Badge
            variant="outline"
            dir="ltr"
            className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono text-[10px]"
          >
            <GitBranch className="h-3 w-3" />
            {task.repo}
          </Badge>
        )}
        {task.batchId && (
          <Badge
            variant="outline"
            dir="ltr"
            className="gap-1 border-zinc-400/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 font-mono text-[10px]"
            title={`אצווה מקבילה: ${task.batchId}`}
          >
            <Layers className="h-2.5 w-2.5" />
            batch:{task.batchId.slice(0, 6)}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground ms-auto">{fmtTime(task.createdAt)}</span>
      </div>
      <p className="font-medium leading-snug">{task.title}</p>
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{task.prompt}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground" dir="ltr">
        <span>worker: {task.worker ?? '—'}</span>
        <span>attempts: {task.attempts}</span>
        <span>duration: {fmtMs(task.durationMs)}</span>
      </div>

      {task.status === 'DONE' && task.output && (
        <div className="pt-1">
          <Separator className="mb-3" />
          {isFleetRoot ? <SynthesisView output={task.output} /> : <OutputView kind={task.kind} output={task.output} />}
        </div>
      )}

      {task.status === 'FAILED' && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 space-y-1">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />
            <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
              כשל-כן — לא הומצא פלט
            </span>
            {task.errorClass && (
              <Badge variant="outline" dir="ltr" className="text-[10px] font-mono border-rose-500/30">
                {task.errorClass}
              </Badge>
            )}
          </div>
          {task.error && (
            <p dir="ltr" className="text-[11px] text-muted-foreground font-mono break-all">
              {task.error}
            </p>
          )}
        </div>
      )}

      {!isWorker && (task.status === 'QUEUED' || task.status === 'FAILED') &&
        (isFleetRoot ? (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onRunFleet(task.id)}>
            {fleetBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
            {task.status === 'FAILED' ? 'הרץ צי מחדש' : 'הרץ צי במקביל'}
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5" disabled={!canRun} onClick={() => onRun(task.id)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : task.status === 'FAILED' ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {task.status === 'FAILED' ? 'הרץ מחדש' : 'הרץ ברשת'}
          </Button>
        ))}

      {task.status === 'DONE' && task.output && !isWorker && (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onHandoff(task)}>
          <Upload className="h-3.5 w-3.5" />
          העבר לגיט
        </Button>
      )}
    </div>
  )
}

// ===== הדף =====

export default function Home() {
  const { toast } = useToast()
  const [tasks, setTasks] = useState<TaskDto[] | null>(null)
  const [ledger, setLedger] = useState<LedgerDto | null>(null)
  const [dbOk, setDbOk] = useState<boolean | null>(null)
  const [rails, setRails] = useState<RailsDto | null>(null)

  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<TaskKind>('CODE')
  const [prompt, setPrompt] = useState('')
  const [repo, setRepo] = useState('')
  const [batchCount, setBatchCount] = useState(1)
  const [knownRepos, setKnownRepos] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [drilling, setDrilling] = useState(false)
  const [batches, setBatches] = useState<BatchDto[] | null>(null)

  // התפתחות-עצמית + מדדי-הרשת (Task 26)
  const [evolution, setEvolution] = useState<EvolutionDto | null>(null)
  const [metrics, setMetrics] = useState<MetricsDto | null>(null)
  const [evolving, setEvolving] = useState(false)

  // עובד-רקע (Task 23): ריצה-אוטומטית של משימות-QUEUED ברירת-מחדל דלוקה
  const [autoRun, setAutoRun] = useState(true)
  const [workerLoopAlive, setWorkerLoopAlive] = useState(false)

  // צי-ביקורת מקבילי
  const [fleetTitle, setFleetTitle] = useState('')
  const [fleetTarget, setFleetTarget] = useState('')
  const [fleetLenses, setFleetLenses] = useState<string[]>(['CORRECTNESS', 'SECURITY', 'PERFORMANCE'])
  const [fleetRunningId, setFleetRunningId] = useState<string | null>(null)

  // שער-העברה לגיט (Task 20)
  const [handoffs, setHandoffs] = useState<HandoffDto[] | null>(null)
  const [gateTaskId, setGateTaskId] = useState('')
  const [gateRepo, setGateRepo] = useState('')
  const [gatePath, setGatePath] = useState('')
  const [gateField, setGateField] = useState('')
  const [gateMessage, setGateMessage] = useState('')
  const [proposing, setProposing] = useState(false)
  const [handoffBusyId, setHandoffBusyId] = useState<string | null>(null)

  const runningRef = useRef<string | null>(null)
  runningRef.current = runningId
  const fleetRunningRef = useRef<string | null>(null)
  fleetRunningRef.current = fleetRunningId
  const autoRunRef = useRef(true)
  autoRunRef.current = autoRun
  const workerLoopActive = useRef(false)

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks')
      const j = await res.json()
      if (j.ok) setTasks(j.tasks)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadLedger = useCallback(async () => {
    try {
      const res = await fetch('/api/ledger')
      const j = await res.json()
      if (j.ok) setLedger(j)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health')
      const j = await res.json()
      setDbOk(j.ok === true && j.db === true)
    } catch {
      setDbOk(false)
    }
  }, [])

  const loadRails = useCallback(async () => {
    try {
      const res = await fetch('/api/providers')
      const j = await res.json()
      if (j.ok) setRails(j.rails)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadKnownRepos = useCallback(async () => {
    try {
      const res = await fetch('/api/github/repos')
      const j = await res.json()
      if (j.ok) setKnownRepos(j.repos)
    } catch {
      /* רשימת-הצעות בלבד — שקט */
    }
  }, [])

  const loadHandoffs = useCallback(async () => {
    try {
      const res = await fetch('/api/handoffs')
      const j = await res.json()
      if (j.ok) setHandoffs(j.handoffs)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadBatches = useCallback(async () => {
    try {
      const res = await fetch('/api/batches')
      const j = await res.json()
      if (j.ok) setBatches(j.batches)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadEvolution = useCallback(async () => {
    try {
      const res = await fetch('/api/evolution')
      const j = await res.json()
      if (j.ok) setEvolution(j)
    } catch {
      /* polling — שקט */
    }
  }, [])

  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/metrics')
      const j = await res.json()
      if (j.ok) setMetrics(j)
    } catch {
      /* polling — שקט */
    }
  }, [])

  // מחזור-הצעה ידני אחד (Task 26) — ירי-LLM אמיתי; 429 = תקציב-שעתי מוצה (כנות)
  const triggerEvolution = useCallback(async () => {
    setEvolving(true)
    try {
      const res = await fetch('/api/evolution', { method: 'POST' })
      const j = await res.json()
      if (res.status === 201 && j.ok) {
        toast({
          title: `הרשת הציעה לעצמה משימה (${j.proposal?.kind ?? '?'})`,
          description: `${j.proposal?.title ?? ''} — שוגרה לתור, העובד-החי יקלוט אותה מיידית`,
        })
      } else if (res.status === 429) {
        toast({
          title: 'תקציב-ההתפתחות השעתי מוצה',
          description: String(j.error ?? ''),
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'מחזור-ההצעה נכשל בכנות',
          description: `${j.errorClass ?? res.status}: ${j.error ?? ''}`.slice(0, 200),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: 'שגיאת-רשת במחזור-ההצעה', variant: 'destructive' })
    } finally {
      setEvolving(false)
      loadEvolution()
      loadTasks()
      loadMetrics()
    }
  }, [toast, loadEvolution, loadTasks, loadMetrics])

  useEffect(() => {
    loadTasks()
    loadLedger()
    loadHealth()
    loadRails()
    loadKnownRepos()
    loadHandoffs()
    loadBatches()
    loadEvolution()
    loadMetrics()
    const iv = setInterval(() => {
      loadTasks()
      loadLedger()
      loadHandoffs()
      loadBatches()
      loadEvolution()
    }, 4000)
    const ivh = setInterval(() => {
      loadHealth()
      loadRails()
      loadMetrics()
    }, 15000)
    return () => {
      clearInterval(iv)
      clearInterval(ivh)
    }
  }, [loadTasks, loadLedger, loadHealth, loadRails, loadKnownRepos, loadHandoffs, loadBatches, loadEvolution, loadMetrics])

  // לולאת-עובד-הרקע (Task 23): tick חי — משימת-QUEUED ותיקה אחת בכל-סבב, עד-סיומה.
  // אין-תור → המתנה-שקטה. משימות-FAILED לא נתפסות-שוב אוטומטית — ניסיון-חוזר הוא החלטה-אנושית.
  useEffect(() => {
    if (!autoRun || workerLoopActive.current) return
    workerLoopActive.current = true
    setWorkerLoopAlive(true)
    ;(async () => {
      try {
        while (autoRunRef.current) {
          let picked = false
          try {
            const res = await fetch('/api/worker/tick', { method: 'POST' })
            const j = await res.json()
            if (j?.picked) {
              picked = true
              await loadTasks()
              await loadLedger()
            }
          } catch {
            /* השרת לא זמין — ננסה שוב בסבב-הבא */
          }
          if (!picked || !autoRunRef.current) {
            await new Promise((res) => setTimeout(res, 3000))
          }
        }
      } finally {
        workerLoopActive.current = false
        setWorkerLoopAlive(false)
      }
    })()
  }, [autoRun, loadTasks, loadLedger])

  const submitTask = async () => {
    if (submitting) return
    const count = Math.min(8, Math.max(1, Math.round(batchCount || 1)))
    setSubmitting(true)
    try {
      if (count > 1) {
        // שגירת-אצווה (Task 24): השרת מנקז בעצמו — בלי תלות בלוח-הפתוח
        const res = await fetch('/api/batches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, title, prompt, repo: repo.trim() || undefined, count }),
        })
        const j = await res.json()
        if (res.ok && j.ok) {
          toast({
            title: `אצווה שוגרה — ${j.created.length} משימות`,
            description: `batchId ${j.batchId} · השרת מנקז בעצמו (${j.parallel} במקביל) — עקוב בכרטיס "שער-תכנות"`,
          })
          setTitle('')
          setPrompt('')
          setRepo('')
          await loadTasks()
          await loadBatches()
        } else {
          toast({ title: 'נדחה', description: j.error ?? 'שגיאה', variant: 'destructive' })
        }
        return
      }
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, kind, prompt, repo: repo.trim() }),
      })
      const j = await res.json()
      if (res.ok && j.ok) {
        toast({
          title: 'המשימה נשלחה לרשת',
          description: repo.trim()
            ? `יעד-ריפו אומת חי: ${repo.trim()} — ההקשר יישלף בהרצה`
            : autoRun
              ? 'עובד-הרקע יריץ אותה מיד — עקוב בלוח'
              : 'הרץ אותה כדי לקבל תוצר מאומת',
        })
        setTitle('')
        setPrompt('')
        setRepo('')
        await loadTasks()
      } else {
        toast({ title: 'נדחה', description: j.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', description: 'לא ניתן ליצור קשר עם השרת', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const runTask = async (id: string) => {
    if (runningRef.current !== null || fleetRunningRef.current !== null) return
    setRunningId(id)
    try {
      const res = await fetch(`/api/tasks/${id}/run`, { method: 'POST' })
      const j = await res.json()
      if (res.ok && j.ok) {
        if (j.executed) {
          toast({ title: 'ביצוע הושלם', description: 'התוצר אומת ונחתם בשרשרת-האמת' })
        } else {
          toast({
            title: 'הביצוע נכשל כנות',
            description: `errorClass: ${j.task?.errorClass ?? 'unknown'} — הפלט לא הומצא`,
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: 'שגיאה', description: j.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setRunningId(null)
      await loadTasks()
      await loadLedger()
    }
  }

  const runFleetRoot = async (id: string) => {
    if (fleetRunningRef.current !== null) return
    setFleetRunningId(id)
    try {
      const runRes = await fetch(`/api/fleets/${id}/run`, { method: 'POST' })
      const rj = await runRes.json()
      if (runRes.ok && rj.ok) {
        if (rj.executed) {
          toast({ title: 'קונסנזוס הצי מוכן', description: 'הסינתזה אומתה ונחתמה בשרשרת-האמת' })
        } else {
          toast({
            title: 'הצי נכשל כנות',
            description: `errorClass: ${rj.root?.errorClass ?? 'unknown'} — אף תוצר לא הומצא`,
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: 'שגיאה', description: rj.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setFleetRunningId(null)
      await loadTasks()
      await loadLedger()
    }
  }

  const toggleLens = (l: string) => {
    setFleetLenses((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))
  }

  const dispatchFleet = async () => {
    if (fleetRunningRef.current !== null) return
    try {
      const res = await fetch('/api/fleets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: fleetTitle, target: fleetTarget, lenses: fleetLenses }),
      })
      const j = await res.json()
      if (!(res.ok && j.ok)) {
        toast({ title: 'נדחה', description: j.error ?? 'שגיאה', variant: 'destructive' })
        return
      }
      toast({ title: 'הצי שוגר', description: `${j.children.length} עדשות יורות במקביל — עקוב בלוח` })
      setFleetTitle('')
      setFleetTarget('')
      await loadTasks()
      await runFleetRoot(j.root.id)
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    }
  }

  // שער-העברה לגיט: בחירת-משימה-DONE ממלאת ברירות-מחדל
  const selectGateTask = (id: string) => {
    setGateTaskId(id)
    const t = tasks?.find((x) => x.id === id)
    if (t) {
      setGateRepo(t.repo ?? '')
      setGateMessage(`handoff: ${t.title} — רשת-הביצוע (אישור-בעלים)`)
    }
  }

  const proposeHandoff = async () => {
    if (proposing || !gateTaskId) return
    setProposing(true)
    try {
      const res = await fetch('/api/handoffs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: gateTaskId,
          repo: gateRepo.trim(),
          path: gatePath.trim(),
          message: gateMessage.trim(),
          field: gateField.trim(),
        }),
      })
      const j = await res.json()
      if (res.ok && j.ok) {
        toast({
          title: 'ההצעה רשומה — ממתינה לאישורך',
          description: 'סריקת-הסודות ואימות-הריפו עברו. לחץ "אשר והעבר" כדי ליצור קומיט אמיתי.',
        })
        setGatePath('')
        setGateField('')
        await loadHandoffs()
      } else {
        toast({ title: 'נדחה', description: j.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setProposing(false)
    }
  }

  const executeHandoff = async (h: HandoffDto, afterApprove: boolean) => {
    if (handoffBusyId !== null) return
    setHandoffBusyId(h.id)
    try {
      if (afterApprove) {
        const aRes = await fetch(`/api/handoffs/${h.id}/approve`, { method: 'POST' })
        const aj = await aRes.json()
        if (!(aRes.ok && aj.ok)) {
          toast({ title: 'האישור נדחה', description: aj.error ?? 'שגיאה', variant: 'destructive' })
          return
        }
      }
      const res = await fetch(`/api/handoffs/${h.id}/execute`, { method: 'POST' })
      const j = await res.json()
      if (res.ok && j.ok) {
        if (j.executed) {
          toast({
            title: 'הועבר לגיט ואומת בקריאה-חוזרת',
            description: `commit ${j.handoff?.commitSha?.slice(0, 10) ?? ''} — ${h.repo}/${h.path}`,
          })
        } else {
          toast({
            title: 'ההעברה נכשלה כנות',
            description: `errorClass: ${j.handoff?.errorClass ?? 'unknown'} — מדווח בשרשרת`,
            variant: 'destructive',
          })
        }
      } else {
        toast({ title: 'נחסם', description: j.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setHandoffBusyId(null)
      await loadHandoffs()
      await loadLedger()
    }
  }

  const withdrawHandoff = async (h: HandoffDto) => {
    if (handoffBusyId !== null) return
    setHandoffBusyId(h.id)
    try {
      const res = await fetch(`/api/handoffs/${h.id}/withdraw`, { method: 'POST' })
      const j = await res.json()
      if (res.ok && j.ok) {
        toast({ title: 'ההצעה נמשכה', description: 'לא נשלח דבר לגיט — המצב נחתם בשרשרת' })
      } else {
        toast({ title: 'נחסם', description: j.error ?? 'שגיאה', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setHandoffBusyId(null)
      await loadHandoffs()
      await loadLedger()
    }
  }

  const approveAndExecute = (h: HandoffDto) => {
    const target = h.branch ? `${h.repo}@${h.branch}` : h.repo
    const okToGo = window.confirm(
      `אישור-בעלים מפורש: ליצור קומיט אמיתי?\n\n${target} · ${h.path}\n\nלאחר-האישור תוכן המשימה ישוגר לגיט הארגוני ויאומת בקריאה-חוזרת.`
    )
    if (!okToGo) return
    void executeHandoff(h, true)
  }

  const fireDrill = async () => {
    if (drilling) return
    setDrilling(true)
    try {
      const res = await fetch('/api/drill', { method: 'POST' })
      const j = (await res.json()) as { ok: boolean; rails: DrillRailResult[] }
      if (j.rails?.length) {
        for (const r of j.rails) {
          if (r.ok) {
            toast({
              title: `מסילת ${r.rail.toUpperCase()} חיה`,
              description: `DRILL-OK חזר ב-${fmtMs(r.ms)} — תשובה אמיתית מהספק`,
            })
          } else {
            toast({
              title: `מסילת ${r.rail.toUpperCase()} נכשלה`,
              description: `errorClass: ${r.errorClass ?? 'unknown'} — מדווח בכנות, אין תשובה`,
              variant: 'destructive',
            })
          }
        }
      } else {
        toast({ title: 'שגיאת-רשת', variant: 'destructive' })
      }
      await loadLedger()
    } catch {
      toast({ title: 'שגיאת-רשת', variant: 'destructive' })
    } finally {
      setDrilling(false)
    }
  }

  const drillEntries = ledger?.recent.filter((e) => e.kind === 'DRILL') ?? []

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-background">
      {/* כותרת */}
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Network className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">רשת הביצוע — Execution Fabric</h1>
            <p className="text-xs text-muted-foreground">משימה → סוכן מבצע → תוצר מאומת. אפס סימולציה.</p>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Badge
              variant="outline"
              className={`gap-1.5 ${
                autoRun
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-zinc-500/30 text-zinc-500'
              }`}
              title={autoRun ? 'עובד-הרקע דלוק — משימות שנשלחות רצות מיד' : 'עובד-הרקע כבוי — הרצה ידנית בלבד'}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${autoRun ? 'animate-pulse bg-emerald-500' : 'bg-zinc-400'}`} />
              <Bot className="h-3 w-3" />
              {autoRun
                ? `עובד-רקע חי${workerLoopAlive ? ' · פעיל' : ''}`
                : 'עובד-רקע כבוי'}
            </Badge>
            <Badge
              variant="outline"
              className={`gap-1.5 ${
                dbOk === null
                  ? 'border-zinc-500/30 text-zinc-500'
                  : dbOk
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dbOk ? 'bg-emerald-500' : dbOk === false ? 'bg-rose-500' : 'bg-zinc-400'}`} />
              DB
            </Badge>
          </div>
        </div>
      </header>

      {/* תוכן */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* עמודת-צד: שיגור + שרשרת */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Send className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                שיגור-משימה
              </CardTitle>
              <CardDescription>
              המשימה תבוצע על-ידי סולם-מועמדים חי — עם או בלי יעד-ריפו אמיתי. פלט בלי ולידציה = כשל כן.
            </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="task-title">כותרת</Label>
                <Input
                  id="task-title"
                  placeholder="למשל: פונקציית אימות-בלנס ל-DEX"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label>סוג-משימה</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as TaskKind)}>
                  <SelectTrigger aria-label="סוג-משימה">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CODE">{KIND_LABEL.CODE}</SelectItem>
                    <SelectItem value="AUDIT">{KIND_LABEL.AUDIT}</SelectItem>
                    <SelectItem value="PLAN">{KIND_LABEL.PLAN}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-repo">יעד-ריפו (רשותי) — מתוך הארגון</Label>
                <Input
                  id="task-repo"
                  dir="ltr"
                  placeholder="למשל: saos-dex"
                  list="known-repos-list"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  maxLength={100}
                />
                <datalist id="known-repos-list">
                  {knownRepos.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <p className="text-[11px] text-muted-foreground">
                  אם ימולא — הרשת מאמתת את הריפו חי עוד-לפני-השיגור, ובהרצה שולפת עכשיו עץ-קבצים וקבצים נבחרים מהריפו האמיתי ומבצעת עליהם.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-prompt">המשימה</Label>
                <Textarea
                  id="task-prompt"
                  placeholder="תאר במדויק מה לבצע. ככל שהחוזה ברור יותר — התוצר מדויק יותר."
                  className="min-h-28"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  maxLength={4000}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-batch">מספר-מופעים באצווה (1 = משימה בודדת)</Label>
                <Input
                  id="task-batch"
                  dir="ltr"
                  type="number"
                  min={1}
                  max={8}
                  value={batchCount}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    setBatchCount(Number.isNaN(v) ? 1 : Math.min(8, Math.max(1, v)))
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  מעל 1 — נשלחת אצווה מקבילה: כל מופע משימה נפרדת (כותרת #i), והשרת עצמו מנקז עד 4 במקביל — בלי תלות בלוח הפתוח.
                </p>
              </div>
              <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2.5">
                <div className="min-w-0 pe-2">
                  <p className="text-sm font-medium leading-tight">ריצה-אוטומטית</p>
                  <p className="text-[11px] text-muted-foreground">
                    {autoRun
                      ? 'עובד-הרקע קולט משימות שנשלחות מיד — בלי לחיצת “הרץ”'
                      : 'כבוי — הרצה ידנית בלבד (כפתור הרץ)'}
                  </p>
                </div>
                <Switch checked={autoRun} onCheckedChange={setAutoRun} aria-label="ריצה-אוטומטית" />
              </div>
              <Button className="w-full gap-2" onClick={submitTask} disabled={submitting || title.trim().length < 3 || prompt.trim().length < 10 || fleetRunningId !== null}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {batchCount > 1 ? `שגר אצווה ×${Math.min(8, Math.max(1, Math.round(batchCount || 1)))}` : 'שגר לרשת'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                שער-תכנות — לארכיטקטורה ולריבונות
              </CardTitle>
              <CardDescription>
                צריכה תכנותית של הרשת בלי דפדפן: שיגור אצווה ← השרת מנקז בעצמו ← סקר-מצב ← קבלה חתומה בשרשרת.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border" dir="ltr">
                <table className="w-full text-[11px] font-mono">
                  <tbody>
                    {(
                      [
                        ['POST', '/api/batches', 'שגירת אצווה + ניקוז-שרת מיידי'],
                        ['GET', '/api/batches/<id>', 'סקר-אצווה: משימות, ספירות, קבלה'],
                        ['GET', '/api/tasks/<id>', 'סקר-משימה בודדת'],
                        ['POST', '/api/tasks', 'שגירת משימה בודדת'],
                        ['POST', '/api/evolution', 'מחזור-הצעה עצמי: הרשת מציעה לעצמה משימה (תקציב 3/שעה)'],
                        ['GET', '/api/evolution', 'היסטוריית-ההצעות-העצמיות + תקציב'],
                        ['GET', '/api/metrics', 'מדדי-הרשת: אימות-שרשרת + פילוחי-יעילות'],
                        ['GET', '/api/ledger', 'שרשרת-האמת + אימות חי'],
                        ['POST', '/api/drill', 'בדיקת-חיות מסילות-מוח'],
                      ] as const
                    ).map(([m, p, d]) => (
                      <tr key={p} className="border-b last:border-b-0">
                        <td className={`px-2 py-1.5 font-bold ${m === 'GET' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {m}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{p}</td>
                        <td dir="rtl" className="px-2 py-1.5 text-muted-foreground font-sans">{d}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <pre dir="ltr" className="rounded-md bg-zinc-950 text-zinc-100 text-[10px] leading-relaxed p-2.5 overflow-x-auto max-h-44">
                <code>{`curl -s -X POST http://127.0.0.1:3000/api/batches \\
  -H 'content-type: application/json' \\
  -d '{"kind":"PLAN","count":3,"title":"workplan v2","prompt":"plan the next hardening sprint for saos-dex"}'

# -> {"ok":true,"batchId":"a1b2c3d4e5f6",...}  (201, מיידי)
curl -s http://127.0.0.1:3000/api/batches/a1b2c3d4e5f6`}</code>
              </pre>
              {batches && batches.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">אצוות אחרונות ({batches.length})</p>
                  <div className="max-h-40 space-y-1.5 overflow-y-auto pe-1">
                    {batches.map((b) => (
                      <div key={b.batchId} className="rounded-md border p-2 flex flex-wrap items-center gap-2">
                        <Badge variant="outline" dir="ltr" className="font-mono text-[10px]">
                          {b.batchId.slice(0, 6)}…
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                          {b.kinds.join('+')}
                        </span>
                        <span className="ms-auto text-[11px] font-mono" dir="ltr">
                          <span className="text-emerald-600 dark:text-emerald-400">{b.done}✓</span>{' '}
                          {b.failed > 0 && <span className="text-rose-600 dark:text-rose-400">{b.failed}✗</span>}
                          {b.pending > 0 && <span className="text-amber-600 dark:text-amber-400"> {b.pending}…</span>}
                          <span className="text-muted-foreground"> / {b.total}</span>
                        </span>
                        {b.pending === 0 &&
                          (b.summary?.status === 'DONE' ? (
                            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                התפתחות-עצמית
              </CardTitle>
              <CardDescription>
                עורק-ג בלב: כל 20 דק' הרשת קוראת את מצב-האמת שלה (מטא-דאטה בלבד), מציעה משימה אחת קונקרטית בירי-LLM אמיתי ומשגרת אותה לתור — העובד-החי קולט ומבצע כרגיל. תקציב-כן: 3 הצעות/שעה.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  תקציב: {evolution ? `${evolution.budget.used}/${evolution.budget.cap} בשעה` : '…'}
                </Badge>
                {evolution && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {evolution.counts.total} הצעות ·{' '}
                    <span className="text-emerald-600 dark:text-emerald-400">{evolution.counts.done}✓</span>
                    {evolution.counts.failed > 0 && (
                      <span className="text-rose-600 dark:text-rose-400"> · {evolution.counts.failed}✗</span>
                    )}
                    {evolution.counts.queued > 0 && (
                      <span className="text-amber-600 dark:text-amber-400"> · {evolution.counts.queued}…</span>
                    )}
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto gap-1.5"
                  onClick={triggerEvolution}
                  disabled={evolving}
                >
                  {evolving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {evolving ? 'מציע…' : 'הצע עכשיו — מחזור אחד'}
                </Button>
              </div>
              {!evolution && <Skeleton className="h-16 w-full" />}
              {evolution && evolution.recent.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  עדיין אין הצעות-עצמיות — פעימת-הלב הראשונה תגיע ~2 דק' אחרי-הזנקתו ואז כל 20 דק', או לחץ "הצע עכשיו".
                </p>
              )}
              {evolution && evolution.recent.length > 0 && (
                <div className="max-h-44 space-y-1.5 overflow-y-auto pe-1">
                  {evolution.recent.map((r) => (
                    <div key={r.id} className="rounded-md border p-2 flex flex-wrap items-center gap-2">
                      <KindBadge kind={r.kind} />
                      <span className="text-xs font-medium flex-1 min-w-40">{r.title}</span>
                      <StatusBadge status={r.status} />
                      {r.worker && (
                        <span className="text-[10px] font-mono text-muted-foreground" dir="ltr">
                          {r.worker}
                        </span>
                      )}
                      {r.durationMs != null && r.status === 'DONE' && (
                        <span className="text-[10px] font-mono text-muted-foreground" dir="ltr">
                          {fmtMs(r.durationMs)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                מדדי-הרשת — הרשת מדווחת על עצמה
              </CardTitle>
              <CardDescription>
                כל מספר נגזר מהדאטה בזמן-בקשה (GET /api/metrics) — אימות-שרשרת fail-closed + פילוחי-יעילות אמת. אפס-השערות.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!metrics && <Skeleton className="h-24 w-full" />}
              {metrics && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-md border p-2.5">
                      <p className="text-[10px] text-muted-foreground">שרשרת</p>
                      <p
                        className={`text-sm font-bold font-mono ${
                          metrics.ledger.verify.ok
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}
                        dir="ltr"
                      >
                        {metrics.ledger.verify.ok
                          ? `${metrics.ledger.verify.verified}/${metrics.ledger.total}`
                          : `BROKEN@${metrics.ledger.verify.brokenAt}`}
                      </p>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <p className="text-[10px] text-muted-foreground">ירי-ראשון-מצליח</p>
                      <p className="text-sm font-bold font-mono" dir="ltr">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {metrics.ledger.ladder.firstTry}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {' '}
                          · {metrics.ledger.ladder.activationRatePct}% סולם
                        </span>
                      </p>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <p className="text-[10px] text-muted-foreground">תור חי</p>
                      <p className="text-sm font-bold font-mono" dir="ltr">
                        {metrics.queue.queued}Q · {metrics.queue.running}R
                      </p>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <p className="text-[10px] text-muted-foreground">מוצא-משימות</p>
                      <p className="text-sm font-bold font-mono" dir="ltr">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {metrics.tasks.fromEvolution}
                        </span>
                        <span className="text-[10px] text-muted-foreground">עצמי</span> · {metrics.tasks.fromHuman}
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">
                      עובדים (יריות-שנות · ממוצע-ירי)
                    </p>
                    <div className="max-h-36 space-y-1 overflow-y-auto pe-1">
                      {metrics.workers.map((w) => (
                        <div key={w.name} className="flex items-center gap-2 text-[11px] font-mono" dir="ltr">
                          <span className="w-44 truncate">{w.name}</span>
                          <span className="text-muted-foreground">{w.shots} shots</span>
                          <span className="ms-auto text-muted-foreground">{fmtMs(w.avgMs)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {Object.keys(metrics.ledger.errorClasses).length > 0 && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 font-mono break-all" dir="ltr">
                      errorClasses: {JSON.stringify(metrics.ledger.errorClasses)}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                צי-ביקורת מקבילי
              </CardTitle>
              <CardDescription>
                N עדשות יורות במקביל על אותו יעד, ומנהל-הצי ממזג קונסנזוס. העובדים אף-פעם לא ממזגים את עצמן.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="fleet-title">כותרת</Label>
                <Input
                  id="fleet-title"
                  placeholder="למשל: ביקורת פונקציית ההעברה"
                  value={fleetTitle}
                  onChange={(e) => setFleetTitle(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fleet-target">יעד-הביקורת (קוד / תיאור)</Label>
                <Textarea
                  id="fleet-target"
                  placeholder="הדבק קוד או תאר את המערכת שתיבדק מכל העדשות..."
                  className="min-h-28 font-mono text-xs"
                  dir="auto"
                  value={fleetTarget}
                  onChange={(e) => setFleetTarget(e.target.value)}
                  maxLength={6000}
                />
              </div>
              <div className="space-y-2">
                <Label>עדשות (בחר 2-4)</Label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(LENS_LABEL).map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded-md border p-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <Checkbox
                        checked={fleetLenses.includes(key)}
                        onCheckedChange={() => toggleLens(key)}
                        aria-label={`עדשת ${label}`}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <Button
                className="w-full gap-2"
                onClick={dispatchFleet}
                disabled={
                  fleetRunningId !== null ||
                  fleetTitle.trim().length < 3 ||
                  fleetTarget.trim().length < 20 ||
                  fleetLenses.length < 2
                }
              >
                {fleetRunningId !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                {fleetRunningId !== null ? 'הצי יורה...' : `שגר צי (${fleetLenses.length} עדשות)`}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Upload className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                שער-העברה לגיט (פסיבי)
              </CardTitle>
              <CardDescription>
                הרשת מבצעת, הגיט מקבל. כל-העברה: סריקת-סודות ← אישור מפורש שלך ← קומיט אמיתי ← read-back מאומת.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>משימת-מקור (הושלמה עם תוצר)</Label>
                <Select value={gateTaskId} onValueChange={selectGateTask}>
                  <SelectTrigger aria-label="משימת-מקור להעברה">
                    <SelectValue placeholder="בחר משימה שהושלמה..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {(tasks ?? [])
                      .filter((t) => t.status === 'DONE' && t.output && t.role !== 'worker')
                      .slice(0, 30)
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span className="truncate max-w-72 block">{t.title}</span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="gate-repo">ריפו-יעד</Label>
                  <Input
                    id="gate-repo"
                    dir="ltr"
                    placeholder="Defi"
                    list="known-repos-list"
                    value={gateRepo}
                    onChange={(e) => setGateRepo(e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gate-field">שדה-תוכן (רשותי)</Label>
                  <Input
                    id="gate-field"
                    dir="ltr"
                    placeholder="למשל: code"
                    value={gateField}
                    onChange={(e) => setGateField(e.target.value)}
                    maxLength={40}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gate-path">נתיב-קובץ-יעד</Label>
                <Input
                  id="gate-path"
                  dir="ltr"
                  className="font-mono text-xs"
                  placeholder="handoffs/2026-10-17/artifact.json"
                  value={gatePath}
                  onChange={(e) => setGatePath(e.target.value)}
                  maxLength={220}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gate-message">הודעת-קומיט (ייחוס כן)</Label>
                <Input
                  id="gate-message"
                  value={gateMessage}
                  onChange={(e) => setGateMessage(e.target.value)}
                  maxLength={400}
                />
              </div>
              <Button
                className="w-full gap-2"
                onClick={proposeHandoff}
                disabled={
                  proposing ||
                  !gateTaskId ||
                  gateRepo.trim().length < 1 ||
                  gatePath.trim().length < 3 ||
                  gateMessage.trim().length < 5
                }
              >
                {proposing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                הגש הצעת-העברה
              </Button>

              {handoffs && handoffs.length > 0 && (
                <div className="space-y-2 pt-1">
                  <Separator />
                  <p className="text-xs font-medium text-muted-foreground">
                    הצעות וקבלות ({handoffs.length})
                  </p>
                  <div className="max-h-80 space-y-2 overflow-y-auto pe-1">
                    {handoffs.map((h) => (
                      <div key={h.id} className="rounded-md border p-2.5 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <HandoffStatusBadge status={h.status} />
                          <Badge
                            variant="outline"
                            dir="ltr"
                            className="font-mono text-[10px] border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          >
                            <GitBranch className="h-2.5 w-2.5" />
                            {h.repo}
                          </Badge>
                          {h.field && (
                            <Badge variant="outline" dir="ltr" className="font-mono text-[10px]">
                              field: {h.field}
                            </Badge>
                          )}
                          <span className="text-[10px] text-muted-foreground ms-auto">{fmtTime(h.createdAt)}</span>
                        </div>
                        <p dir="ltr" className="font-mono text-[11px] break-all text-muted-foreground">
                          {h.path}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-snug line-clamp-1">
                          ← {h.task.title}
                        </p>
                        {h.status === 'DONE' && h.commitSha && (
                          <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            {h.verified ? (
                              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                read-back אומת
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                לא אומת
                              </span>
                            )}
                            <a
                              href={`https://github.com/roshpinacare-sys/${h.repo}/commit/${h.commitSha}`}
                              target="_blank"
                              rel="noreferrer"
                              dir="ltr"
                              className="inline-flex items-center gap-1 font-mono hover:underline"
                            >
                              {h.commitSha.slice(0, 10)}…
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <span className="text-muted-foreground">{fmtMs(h.durationMs)}</span>
                          </div>
                        )}
                        {h.status === 'FAILED' && (
                          <div className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <ShieldAlert className="h-3 w-3 text-rose-500" />
                              {h.errorClass && (
                                <Badge variant="outline" dir="ltr" className="text-[10px] font-mono border-rose-500/30">
                                  {h.errorClass}
                                </Badge>
                              )}
                              {h.commitSha && (
                                <span dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                                  commit: {h.commitSha.slice(0, 10)}…
                                </span>
                              )}
                            </div>
                            {h.error && (
                              <p dir="auto" className="text-[10px] text-muted-foreground break-words line-clamp-2">
                                {h.error}
                              </p>
                            )}
                          </div>
                        )}
                        {(h.status === 'PROPOSED' || h.status === 'APPROVED' || h.status === 'FAILED') && (
                          <div className="flex flex-wrap gap-1.5">
                            {h.status === 'PROPOSED' && (
                              <>
                                <Button
                                  size="sm"
                                  className="h-7 gap-1 text-xs"
                                  disabled={handoffBusyId !== null}
                                  onClick={() => approveAndExecute(h)}
                                >
                                  {handoffBusyId === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                                  אשר והעבר
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 gap-1 text-xs text-muted-foreground"
                                  disabled={handoffBusyId !== null}
                                  onClick={() => void withdrawHandoff(h)}
                                >
                                  משוך
                                </Button>
                              </>
                            )}
                            {h.status === 'APPROVED' && (
                              <Button
                                size="sm"
                                className="h-7 gap-1 text-xs"
                                disabled={handoffBusyId !== null}
                                onClick={() => void executeHandoff(h, false)}
                              >
                                {handoffBusyId === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                                בצע העברה
                              </Button>
                            )}
                            {h.status === 'FAILED' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 text-xs"
                                disabled={handoffBusyId !== null}
                                onClick={() => void executeHandoff(h, false)}
                              >
                                {handoffBusyId === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                נסה שוב
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Terminal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                מסילות-המוח
              </CardTitle>
              <CardDescription>
                סולם רב-ספקי: zai → nvidia-nim → zai-compact. בדיקת-חיות יורה כל מסילה בנפרד — בלי תשובה = כשל כן.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  ZAI
                </Badge>
                {rails?.nvidia.present ? (
                  <Badge variant="outline" className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    NVIDIA · {rails.nvidia.preferredModel ?? 'nim'}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1.5 border-zinc-500/30 text-zinc-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
                    NVIDIA · לא-מוגדר
                  </Badge>
                )}
                {rails?.ipai.present && (
                  <Badge variant="outline" className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400" title={rails.ipai.note}>
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    IPAI · לא-מחובר
                  </Badge>
                )}
              </div>
              <Button variant="outline" className="w-full gap-2" onClick={fireDrill} disabled={drilling}>
                {drilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <HeartPulse className="h-4 w-4" />}
                ירי בדיקת-חיות (כל המסילות)
              </Button>
              {drillEntries.length > 0 && (
                <div className="space-y-1">
                  {drillEntries.slice(0, 4).map((e) => (
                    <div key={e.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      {e.status === 'DONE' ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />
                      )}
                      <span dir="ltr" className="font-mono">{e.worker}</span>
                      <span>· {e.status === 'DONE' ? 'חי' : `נכשל (${e.errorClass ?? '?'})`}</span>
                      <span>· {fmtMs(e.durationMs)}</span>
                      <span>· seq #{e.id}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base flex items-center gap-2">
                {ledger?.verify.ok === false ? (
                  <ShieldAlert className="h-4 w-4 text-rose-500" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
                שרשרת-האמת
              </CardTitle>
              <CardDescription>
                sha256 על כל מצב-סופי. האימות מחושב-מחדש חי על כל-ריענון — לא סטטוס שמור.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!ledger ? (
                <Skeleton className="h-16 w-full" />
              ) : ledger.verify.ok ? (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
                    <ShieldCheck className="h-4 w-4" />
                    {ledger.verify.verified === 0 ? 'שרשרת ריקה (GENESIS)' : `שרשרת תקינה — ${ledger.verify.verified} רשומות מאומתות`}
                  </div>
                  {ledger.verify.verified > 0 && (
                    <p dir="ltr" className="mt-1 font-mono text-[11px] text-muted-foreground">
                      head: {ledger.verify.head}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-rose-600 dark:text-rose-400">
                    <ShieldAlert className="h-4 w-4" />
                    שרשרת שבורה ב-seq #{ledger.verify.brokenAt}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">fail-closed — אימות עצר בנקודת-השבר הראשונה.</p>
                </div>
              )}

              {ledger && ledger.recent.length > 0 && (
                <div className="max-h-52 overflow-y-auto rounded-md border" dir="ltr">
                  <table className="w-full text-[11px] font-mono">
                    <tbody>
                      {ledger.recent.map((e) => (
                        <tr key={e.id} className="border-b last:border-b-0">
                          <td className="px-2 py-1.5 text-muted-foreground">#{e.id}</td>
                          <td className="px-2 py-1.5">{e.kind}</td>
                          <td className={`px-2 py-1.5 ${e.status === 'DONE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {e.status}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{fmtMs(e.durationMs)}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{e.hash.slice(0, 8)}…</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* לוח-המשימות */}
        <div className="lg:col-span-3">
          <Card className="h-full">
            <CardHeader className="pb-4">
              <CardTitle className="text-base">לוח-הביצוע</CardTitle>
              <CardDescription>כל הרצה היא עבודה אמיתית של הרשת — או תוצר מאומת, או כשל כן.</CardDescription>
            </CardHeader>
            <CardContent>
              {!tasks ? (
                <div className="space-y-3">
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center">
                  <Network className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">אין משימות עדיין. שגר את הראשונה מהעמודה הצדדית.</p>
                </div>
              ) : (
                <div className="max-h-[44rem] space-y-3 overflow-y-auto pe-1">
                  {tasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      runningId={runningId}
                      fleetRunningId={fleetRunningId}
                      onRun={runTask}
                      onRunFleet={runFleetRoot}
                      onHandoff={(task) => {
                        selectGateTask(task.id)
                        toast({
                          title: 'המשימה נבחרה לשער-ההעברה',
                          description: 'מלא ריפו/נתיב בכרטיס "שער-העברה לגיט" והגש הצעה.',
                        })
                      }}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* פוטר דביק */}
      <footer className="mt-auto border-t bg-card pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>רשת הביצוע — סולם-מועמדים כן (fcc-llm-chain) + שרשרת-אמת sha256 + אצוות מקביליות + שער-העברה עם read-back</span>
          <span dir="ltr">honest exhaustion · ok:false · אפס סימולציה</span>
        </div>
      </footer>
    </div>
  )
}

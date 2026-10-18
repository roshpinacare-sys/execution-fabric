'use client'

// מנווט-נייד תחתון (Task 40 — יישום הצעה id=9 מקיר-הצמיחה: "ממשק קונסולה רספונסיבי לנייד").
// הרחבה-אדיטיבית בלבד: אין-כרטיס קיים שנגע בו; הכרטיסים קיבלו id/scroll-mt בלבד.
// סף-מסך: מוצג מתחת ל-lg בלבד; פלטה-קיימת (emerald/zinc) — אפס-תלות-חדשה.

import { useEffect, useState } from 'react'
import {
  Send,
  BarChart3,
  ShieldCheck,
  Boxes,
  BookOpenText,
  LayoutDashboard,
} from 'lucide-react'

const SECTIONS = [
  { id: 'sec-dispatch', label: 'שיגור', icon: Send },
  { id: 'sec-metrics', label: 'מדדים', icon: BarChart3 },
  { id: 'sec-chain', label: 'שרשרת', icon: ShieldCheck },
  { id: 'sec-map', label: 'ריבונות', icon: Boxes },
  { id: 'sec-content', label: 'תוכן', icon: BookOpenText },
  { id: 'sec-board', label: 'לוח', icon: LayoutDashboard },
] as const

export function MobileNav() {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null
    )
    if (els.length === 0) return
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (top?.target.id) setActive(top.target.id)
      },
      { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.1, 0.25] }
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  return (
    <nav
      aria-label="ניווט קונסולה לנייד"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mx-auto grid max-w-6xl grid-cols-6">
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const isActive = active === id
          return (
            <a
              key={id}
              href={`#${id}`}
              aria-label={`מעבר ל${label}`}
              aria-current={isActive ? 'true' : undefined}
              className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] transition-colors ${
                isActive
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
            </a>
          )
        })}
      </div>
    </nav>
  )
}

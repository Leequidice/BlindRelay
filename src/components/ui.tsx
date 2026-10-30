/**
 * Shared UI primitives for BlindRelay.
 * Arc Light mode: warm neutral canvas, white cards, navy CTAs.
 */

import { type ReactNode } from 'react'
import { ExternalLink, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react'
import { buildTxUrl } from '../lib/blindrelay'

// ─── Layout ────────────────────────────────────────────────────────────────

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-white/80 backdrop-blur-sm border border-slate-200 rounded-2xl shadow-sm ${className}`}
    >
      {children}
    </div>
  )
}

export function PageWrapper({ children }: { children: ReactNode }) {
  return <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">{children}</div>
}

// ─── Typography ────────────────────────────────────────────────────────────

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-2xl font-bold text-slate-900 tracking-tight font-display">{children}</h1>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">{children}</p>
  )
}

// ─── Form ──────────────────────────────────────────────────────────────────

export function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700 mb-1">
      {children}
    </label>
  )
}

export function Input({
  id,
  type = 'text',
  placeholder,
  value,
  onChange,
  disabled,
  className = '',
  min,
  step,
}: {
  id?: string
  type?: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  min?: string
  step?: string
}) {
  return (
    <input
      id={id}
      type={type}
      placeholder={placeholder}
      value={value}
      min={min}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-mono ${className}`}
    />
  )
}

export function Textarea({
  id,
  placeholder,
  value,
  onChange,
  rows = 3,
}: {
  id?: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
  rows?: number
}) {
  return (
    <textarea
      id={id}
      placeholder={placeholder}
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
    />
  )
}

// ─── Buttons ───────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  fullWidth,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: ButtonVariant
  fullWidth?: boolean
  type?: 'button' | 'submit'
}) {
  const base =
    'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 min-h-[44px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-900',
    secondary:
      'bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 focus:ring-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-600',
    ghost: 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 focus:ring-slate-400',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${fullWidth ? 'w-full' : ''}`}
    >
      {children}
    </button>
  )
}

// ─── Status / Alerts ───────────────────────────────────────────────────────

export function Alert({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'warning' | 'success' | 'error'
  children: ReactNode
}) {
  const styles = {
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
  }
  const icons = {
    info: <Info size={16} className="shrink-0 mt-0.5" />,
    warning: <AlertTriangle size={16} className="shrink-0 mt-0.5" />,
    success: <CheckCircle2 size={16} className="shrink-0 mt-0.5" />,
    error: <XCircle size={16} className="shrink-0 mt-0.5" />,
  }
  return (
    <div className={`flex gap-2 p-3 rounded-xl border text-sm ${styles[variant]}`}>
      {icons[variant]}
      <div>{children}</div>
    </div>
  )
}

// ─── Transaction receipt ───────────────────────────────────────────────────

export function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={buildTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-mono underline underline-offset-2"
    >
      {hash.slice(0, 10)}...{hash.slice(-6)}
      <ExternalLink size={11} />
    </a>
  )
}

// ─── Phase badge ───────────────────────────────────────────────────────────

export function PhaseBadge({ phase }: { phase: string }) {
  const colors: Record<string, string> = {
    Commit: 'bg-blue-100 text-blue-700',
    Reveal: 'bg-violet-100 text-violet-700',
    Ended: 'bg-slate-100 text-slate-600',
    Finalized: 'bg-green-100 text-green-700',
    Cancelled: 'bg-red-100 text-red-600',
    Unknown: 'bg-slate-100 text-slate-400',
  }
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold tracking-wide ${colors[phase] ?? colors.Unknown}`}
    >
      {phase}
    </span>
  )
}

// ─── Row helper ────────────────────────────────────────────────────────────

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500 shrink-0">{label}</span>
      <span className="text-sm text-slate-900 text-right break-all">{value}</span>
    </div>
  )
}

// ─── Spinner ───────────────────────────────────────────────────────────────

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─── Chain guard banner ────────────────────────────────────────────────────

export function WrongChainBanner({
  chainName,
  chainId,
  onSwitch,
}: {
  chainName: string
  chainId: number
  onSwitch: () => void
}) {
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 px-4 py-3 bg-amber-500 text-white text-sm font-medium shadow-lg">
      <div className="flex items-center gap-2 flex-wrap">
        <AlertTriangle size={16} className="shrink-0" />
        <span>Switch to <strong>{chainName}</strong> (chain {chainId}) to use this app.</span>
      </div>
      <button
        onClick={onSwitch}
        className="shrink-0 px-3 py-1 bg-white text-amber-700 rounded-lg text-xs font-semibold hover:bg-amber-50 transition-colors"
      >
        Switch to Arc
      </button>
    </div>
  )
}

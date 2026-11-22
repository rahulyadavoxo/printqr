import { ClipboardEvent, KeyboardEvent, useEffect, useRef, useState } from 'react'

/** Digits Supabase sends in the signup email code. A project setting (Auth → Email → OTP length, 6-10);
 *  ours is the default 6 (README). Change it here only if the dashboard value changes. */
export const EMAIL_OTP_LENGTH = 6
/** Longest email code we still accept (Supabase allows up to 10), so an autofilled / pasted longer code works. */
export const EMAIL_OTP_MAX = 10
/** SMS login code length (Supabase → Phone provider, 6). */
export const SMS_OTP_LENGTH = 6

// Zero code points of the digit sets an Indian keyboard / SMS may produce. ASCII is handled directly.
const DIGIT_ZEROS = [
  0x0966, // Devanagari ०
  0x09e6, // Bengali ০
  0x0a66, // Gurmukhi ੦
  0x0ae6, // Gujarati ૦
  0x0b66, // Odia ୦
  0x0be6, // Tamil ௦
  0x0c66, // Telugu ౦
  0x0ce6, // Kannada ೦
  0x0d66, // Malayalam ൦
  0x0660, // Arabic-Indic ٠
  0x06f0, // Extended Arabic-Indic ۰
  0xff10 // Fullwidth ０
]

/** Keeps digits only (Devanagari and other Indian digits become 0-9), up to max. */
export function cleanOtp(raw: string, max: number): string {
  let out = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) || 0
    if (c >= 48 && c <= 57) out += ch
    else {
      const z = DIGIT_ZEROS.find((zero) => c >= zero && c <= zero + 9)
      if (z !== undefined) out += String(c - z)
    }
    if (out.length >= max) break
  }
  return out
}

type Props = {
  value: string
  onChange: (v: string) => void
  /** Boxes shown (and the length that counts as complete). */
  length: number
  /** Longest code accepted; extra boxes appear when a longer code is pasted / autofilled. Default: length. */
  maxLength?: number
  /** Called once when the user's typing / paste / autofill fills the code. */
  onComplete?: (v: string) => void
  /** Read-only while a check runs (the keyboard stays open). */
  disabled?: boolean
  error?: boolean
  /** Bump to shake the boxes and put the focus back on the first box (wrong code). */
  shakeKey?: number
  autoFocus?: boolean
  id?: string
  ariaLabel?: string
  ariaDescribedBy?: string
}

/**
 * Looks like one box per digit but is a single real <input> laid over the boxes, so
 * autocomplete="one-time-code" (iOS / Android keyboard suggestion, SMS autofill), paste and
 * screen readers all see one normal text field holding the whole code.
 */
export default function OtpInput({
  value, onChange, length, maxLength, onComplete, disabled, error, shakeKey, autoFocus, id, ariaLabel, ariaDescribedBy
}: Props) {
  const max = Math.max(length, maxLength || length)
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [shaking, setShaking] = useState(false)
  const completed = useRef('')

  // Wrong code: shake (CSS skips it for reduced motion) and focus the first box again.
  useEffect(() => {
    if (!shakeKey) return
    setShaking(false)
    const raf = requestAnimationFrame(() => setShaking(true))
    const tm = window.setTimeout(() => setShaking(false), 500)
    ref.current?.focus()
    return () => { cancelAnimationFrame(raf); window.clearTimeout(tm) }
  }, [shakeKey])

  // Whatever set the value, a value shorter than complete allows the next completion again.
  useEffect(() => {
    if (value.length < length) completed.current = ''
  }, [value, length])

  function commit(next: string) {
    const v = cleanOtp(next, max)
    if (v !== value) onChange(v)
    if (v.length >= length && completed.current !== v) {
      completed.current = v
      onComplete?.(v)
    } else if (v.length < length) completed.current = ''
  }

  /** Editing always happens at the end of the code, so the caret box and the text agree. */
  function caretToEnd() {
    const el = ref.current
    if (!el || document.activeElement !== el) return
    const n = el.value.length
    if (el.selectionStart !== n || el.selectionEnd !== n) {
      try { el.setSelectionRange(n, n) } catch { /* ignore */ }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    if (disabled) return
    const text = e.clipboardData.getData('text')
    const digits = cleanOtp(text, max)
    e.preventDefault()
    if (digits) commit(digits) // a pasted code fills from the first box
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Arrows / Home would move the hidden caret away from the active box: keep it at the end.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) e.preventDefault()
  }

  const boxes = Math.min(max, Math.max(length, value.length))
  const active = Math.min(value.length, boxes - 1)
  const full = value.length >= boxes

  return (
    <div className={`otp${shaking ? ' shake' : ''}${error ? ' has-error' : ''}${disabled ? ' is-disabled' : ''}${boxes > 6 ? ' is-long' : ''}`}
      style={{ ['--otp-n' as string]: boxes }}>
      <input
        ref={ref}
        id={id}
        className="otp-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        name="otp"
        enterKeyHint="done"
        value={value}
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        aria-invalid={error || undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        autoFocus={autoFocus}
        onChange={(e) => commit(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onSelect={caretToEnd}
        onClick={caretToEnd}
        onFocus={() => { setFocused(true); requestAnimationFrame(caretToEnd) }}
        onBlur={() => setFocused(false)}
      />
      <div className="otp-boxes" aria-hidden="true">
        {Array.from({ length: boxes }, (_, i) => {
          const isActive = focused && !disabled && i === active
          return (
            <span key={i} className={`otp-box${value[i] ? ' filled' : ''}${isActive ? ' active' : ''}`}>
              {value[i] || ''}
              {isActive && !(full && value[i]) && <span className="otp-caret" />}
            </span>
          )
        })}
      </div>
    </div>
  )
}

import { InputHTMLAttributes, useState } from 'react'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'

/** Password field with a show / hide eye button. */
export default function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useI18n()
  const [show, setShow] = useState(false)
  return (
    <span className="pw-wrap">
      <input {...props} type={show ? 'text' : 'password'} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="pw-eye" onClick={(e) => { e.preventDefault(); setShow((v) => !v) }}
        aria-label={show ? t('pwHide') : t('pwShow')} aria-pressed={show}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </span>
  )
}

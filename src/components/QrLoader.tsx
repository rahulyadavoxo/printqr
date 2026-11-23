import { useI18n } from '../lib/i18n'

/* QR loading mark (owner's artwork, 2026-11-23). Used where the page's layout or content is not known yet
   (a skeleton would guess wrong): the app-level fallback for /, /login and unknown routes, the dynamic QR
   lookup (/q/:code) and the first visit to Home / Login before the admin's chosen design is known.
   Colour follows currentColor (ink in light, white in dark); styles in styles.css (.qr-loader). */
export function QrLoader({ size = 64 }: { size?: number }) {
  return (
    <svg className="qr-loader" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect className="fnd" x="10.8" y="10.8" width="30.4" height="30.4" rx="3"/>
      <rect className="core" x="21" y="21" width="10" height="10" rx="2"/>
      <rect className="fnd" x="58.8" y="10.8" width="30.4" height="30.4" rx="3"/>
      <rect className="core" x="69" y="21" width="10" height="10" rx="2"/>
      <rect className="fnd" x="10.8" y="58.8" width="30.4" height="30.4" rx="3"/>
      <rect className="core" x="21" y="69" width="10" height="10" rx="2"/>
      <rect className="px" x="45" y="9" width="10" height="10" rx="2" style={{ animationDelay: '0.42s' }}/>
      <rect className="px" x="45" y="21" width="10" height="10" rx="2" style={{ animationDelay: '0.56s' }}/>
      <rect className="px" x="45" y="33" width="10" height="10" rx="2" style={{ animationDelay: '0.70s' }}/>
      <rect className="px" x="9" y="45" width="10" height="10" rx="2" style={{ animationDelay: '0.42s' }}/>
      <rect className="px" x="21" y="45" width="10" height="10" rx="2" style={{ animationDelay: '0.56s' }}/>
      <rect className="px" x="33" y="45" width="10" height="10" rx="2" style={{ animationDelay: '0.70s' }}/>
      <rect className="px" x="45" y="45" width="10" height="10" rx="2" style={{ animationDelay: '0.84s' }}/>
      <rect className="px" x="57" y="45" width="10" height="10" rx="2" style={{ animationDelay: '0.98s' }}/>
      <rect className="px" x="69" y="45" width="10" height="10" rx="2" style={{ animationDelay: '1.12s' }}/>
      <rect className="px" x="81" y="45" width="10" height="10" rx="2" style={{ animationDelay: '1.26s' }}/>
      <rect className="px" x="45" y="57" width="10" height="10" rx="2" style={{ animationDelay: '0.98s' }}/>
      <rect className="px" x="57" y="57" width="10" height="10" rx="2" style={{ animationDelay: '1.12s' }}/>
      <rect className="px" x="69" y="57" width="10" height="10" rx="2" style={{ animationDelay: '1.26s' }}/>
      <rect className="px" x="81" y="57" width="10" height="10" rx="2" style={{ animationDelay: '1.40s' }}/>
      <rect className="px" x="45" y="69" width="10" height="10" rx="2" style={{ animationDelay: '1.12s' }}/>
      <rect className="px" x="57" y="69" width="10" height="10" rx="2" style={{ animationDelay: '1.26s' }}/>
      <rect className="px" x="69" y="69" width="10" height="10" rx="2" style={{ animationDelay: '1.40s' }}/>
      <rect className="px" x="81" y="69" width="10" height="10" rx="2" style={{ animationDelay: '1.54s' }}/>
      <rect className="px" x="45" y="81" width="10" height="10" rx="2" style={{ animationDelay: '1.26s' }}/>
      <rect className="px" x="57" y="81" width="10" height="10" rx="2" style={{ animationDelay: '1.40s' }}/>
      <rect className="px" x="69" y="81" width="10" height="10" rx="2" style={{ animationDelay: '1.54s' }}/>
      <rect className="px" x="81" y="81" width="10" height="10" rx="2" style={{ animationDelay: '1.68s' }}/>
    </svg>
  )
}

/** Full-screen centred loader with a screen-reader "Loading…". */
export function QrLoadPage() {
  const { t } = useI18n()
  return (
    <div className="qr-load-page" role="status" aria-busy="true">
      <QrLoader />
      <span className="sr-only">{t('loading')}</span>
    </div>
  )
}

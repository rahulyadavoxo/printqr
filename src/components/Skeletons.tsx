import { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { LogoMark, TopBar } from './TopBar'
import Icon from './Icon'
import BarStory from './BarStory'
import { useI18n } from '../lib/i18n'
import { IN_APP, ON_ANDROID } from '../lib/app'
import { BOTTOM, isTab, NAV, savedSidebar, Tab, TABS } from '../lib/dashNav'

/* Loading skeletons, one per page. Each one uses the page's own layout classes (cards, grids, top bar,
   sidebar) with shimmer blocks in place of the data, so nothing jumps when the real page appears.
   Keep each skeleton in step with its page when that page's layout changes. */

/** One shimmer block. w / h in px (number) or any CSS length (string). */
function B({ w = '100%', h = 14, r, style, className = '' }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties; className?: string }) {
  return <div className={`skel ${className}`} style={{ width: w, height: h, borderRadius: r, flex: 'none', ...style }} />
}
const Busy = () => {
  const { t } = useI18n()
  return <span className="sr-only">{t('loading')}</span>
}

/* ------------------------------------------------------------------ */
/* Customer pages: Upload (#/s/:slug), dynamic QR (#/q/:code), Status (#/o/:id/:key) */

/** Body of the upload page: shop header card, 3-step flow, drop zone. */
export function UploadSkelBody() {
  return (
    <div className="skeleton-wrap" aria-busy="true">
      <Busy />
      <header className="shop-head card">
        <div className="shop-head-row">
          <B w={52} h={52} r={15} />
          <div className="shop-head-text skel-stack">
            <B w="62%" h={22} />
            <B w="44%" h={13} />
          </div>
          <B w={66} h={24} r={999} style={{ alignSelf: 'flex-start' }} />
        </div>
        <div className="shop-head-foot">
          <B w={210} h={34} r={999} style={{ marginTop: 14, maxWidth: '70%' }} />
          <B w={96} h={64} r={12} style={{ opacity: 0.6 }} />
        </div>
      </header>
      <ol className="flow" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i}><span className="flow-dot" /><B w={54} h={11} /></li>
        ))}
      </ol>
      <div className="dropzone skel-dropzone" aria-hidden="true">
        <B w={60} h={60} r={18} />
        <B w="52%" h={18} style={{ marginTop: 6 }} />
        <B w="70%" h={12} />
        <div className="skel-inline"><B w={38} h={20} r={6} /><B w={38} h={20} r={6} /><B w={38} h={20} r={6} /></div>
      </div>
    </div>
  )
}

/** Whole upload page (used before the page code loads, and by the dynamic QR redirect). */
export function UploadSkeleton() {
  return (
    <div className="app-page">
      <TopBar to={null} />
      <main className="page narrow"><UploadSkelBody /></main>
    </div>
  )
}

/** Body of the order status page: the token ticket and the hint lines under it. */
export function StatusSkelBody() {
  return (
    <div className="skeleton-wrap" aria-busy="true">
      <Busy />
      <div className="card token-card skel-ticket">
        <div className="ticket-band"><B w="46%" h={16} /><B w={58} h={24} r={999} /></div>
        <B w={110} h={12} style={{ margin: '22px auto 0' }} />
        <B w={150} h={86} r={16} style={{ margin: '10px auto 14px' }} />
        <B w={132} h={40} r={999} style={{ margin: '0 auto' }} />
        <ol className="tracker" aria-hidden="true">
          {[0, 1].map((i) => (
            <li key={i}><span className="dot" /><B w={70} h={12} /></li>
          ))}
        </ol>
        <div className="ticket-cut" aria-hidden="true" />
        <div className="ticket-foot"><B w={76} h={18} /><B w={118} h={28} /></div>
      </div>
      <p className="hint-line"><B w="78%" h={13} /></p>
      <p className="hint-line"><B w="64%" h={13} /></p>
    </div>
  )
}

export function StatusSkeleton() {
  return (
    <div className="app-page">
      <TopBar to={null} />
      <main className="page narrow"><StatusSkelBody /></main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Auth-style pages: Setup (#/setup), Reset password (#/reset) */

function FieldSkel({ hint = false, label = '34%' }: { hint?: boolean; label?: string }) {
  return (
    <div className="field skel-field-real">
      <B w={label} h={13} style={{ marginBottom: 8 }} />
      <B h={50} r={12} />
      {hint && <B w="72%" h={11} style={{ marginTop: 8 }} />}
    </div>
  )
}

/** Shop setup form: logo, step chip, title, subtitle, 4 fields (2 with hints), button. */
export function SetupSkelCard() {
  return (
    <div className="card auth-card skeleton-wrap" aria-busy="true">
      <Busy />
      <div className="auth-logo"><LogoMark size={44} /></div>
      <B w={110} h={24} r={999} style={{ margin: '0 auto 10px' }} />
      <B w="66%" h={28} style={{ margin: '0 auto 8px' }} />
      <B w="84%" h={13} style={{ margin: '0 auto 6px' }} />
      <B w="58%" h={13} style={{ margin: '0 auto 8px' }} />
      <FieldSkel label="30%" />
      <FieldSkel label="22%" />
      <FieldSkel label="36%" hint />
      <FieldSkel label="32%" hint />
      <B h={54} r={14} style={{ marginTop: 18 }} />
    </div>
  )
}

export function SetupSkeleton() {
  return (
    <div className="auth-page">
      <TopBar to={null} />
      <main className="auth-wrap"><SetupSkelCard /></main>
    </div>
  )
}

/** Inside the reset-password card (logo and title are real): subtitle, 2 password fields, button. */
export function ResetSkelBody() {
  return (
    <div className="skeleton-wrap" aria-busy="true">
      <Busy />
      <B w="80%" h={13} style={{ margin: '4px auto 8px' }} />
      <FieldSkel label="36%" hint />
      <FieldSkel label="42%" />
      <B h={54} r={14} style={{ marginTop: 18 }} />
    </div>
  )
}

export function ResetSkeleton() {
  const { t } = useI18n()
  return (
    <div className="auth-page">
      <TopBar />
      <main className="auth-wrap">
        <div className="card auth-card">
          <div className="auth-logo"><LogoMark size={44} /></div>
          <h1 className="auth-title">{t('rpTitle')}</h1>
          <ResetSkelBody />
        </div>
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Legal pages (#/legal/:doc) */

export function LegalSkeleton() {
  return (
    <div>
      <TopBar />
      <main className="page narrow legal">
        <div className="card skeleton-wrap skel-stack" aria-busy="true">
          <Busy />
          <B w="55%" h={30} />
          <B w={150} h={12} />
          {[96, 88, 92, 70, 0, 90, 94, 60].map((w, i) => (w ? <B key={i} w={`${w}%`} h={13} /> : <div key={i} style={{ height: 8 }} />))}
        </div>
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Admin (#/admin) */

/** Stat cards (Admin overview, Dashboard report). */
export function SkelStats({ n = 4 }: { n?: number }) {
  return (
    <div className="stats skeleton-wrap" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card stat skel-stat">
          <div className="skel skel-line w40" />
          <div className="skel skel-num" />
          <div className="skel skel-line w60" />
        </div>
      ))}
    </div>
  )
}

export function SkelList({ n = 5 }: { n?: number }) {
  return (
    <div className="admin-list skeleton-wrap" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card skel-row">
          <div className="skel skel-dot" />
          <div className="skel-row-text">
            <div className="skel skel-line w60" />
            <div className="skel skel-line w40" />
          </div>
          <div className="skel skel-pill" />
        </div>
      ))}
    </div>
  )
}

export function SkelLog({ n = 6 }: { n?: number }) {
  return (
    <div className="card admin-log skeleton-wrap" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="admin-log-row">
          <div className="skel skel-line skel-time" />
          <div className="skel skel-line" style={{ width: `${45 + ((i * 17) % 40)}%` }} />
        </div>
      ))}
    </div>
  )
}

export function SkelForm({ n = 4 }: { n?: number }) {
  return (
    <div className="card skeleton-wrap skel-form-admin" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel-field">
          <div className="skel skel-line w40" />
          <div className="skel skel-input" />
        </div>
      ))}
    </div>
  )
}

/** Admin body: title + Refresh, the 8 tab pills, the Overview heading and its 8 stat cards. */
export function AdminSkelBody() {
  return (
    <div aria-busy="true">
      <Busy />
      <div className="admin-head"><B w={170} h={30} /><B w={84} h={36} r={10} /></div>
      <div className="tabs admin-tabs skel-tabs-row" aria-hidden="true">
        {[82, 64, 60, 66, 82, 58, 74, 48].map((w, i) => <B key={i} w={w} h={40} r={999} />)}
      </div>
      <B w={130} h={20} style={{ margin: '26px 0 12px' }} />
      <SkelStats n={8} />
    </div>
  )
}

export function AdminSkeleton() {
  return (
    <div className="app-page">
      <TopBar to="/dashboard" wide />
      <main className="page"><AdminSkelBody /></main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dashboard (#/dashboard?tab=...) */

/** Orders tab: the queue card with its status pills and two order cards (token, name, files, buttons). */
export function OrdersSkel() {
  return (
    <div className="card fold-card has-orders skel-queue" aria-busy="true">
      <Busy />
      <div className="queue-summary" aria-hidden="true"><B w={92} h={22} r={999} /><B w={80} h={22} r={999} /></div>
      <div className="orders-grid">
        {[0, 1].map((i) => (
          <div className="card order skel-order-card" key={i} aria-hidden="true">
            <div className="order-top">
              <B w={64} h={44} r={12} />
              <div className="order-who skel-stack"><B w="58%" h={16} /><B w="34%" h={12} /></div>
              <div className="order-right"><B w={70} h={22} r={999} /><B w={60} h={24} /></div>
            </div>
            <ul className="files">
              <li>
                <B w="70%" h={14} />
                <div className="file-meta"><B w={44} h={20} r={6} /><B w={64} h={20} r={6} /><B w={90} h={12} /><B w={40} h={14} style={{ marginLeft: 'auto' }} /></div>
                <div className="file-actions"><B h={44} r={12} style={{ flex: '1 1 130px', width: 'auto' }} /><B h={44} r={12} style={{ flex: '1 1 130px', width: 'auto' }} /></div>
              </li>
            </ul>
            <B h={50} r={14} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A form card: title, subtitle, then fields (in a 2-column grid when `grid`), and a save button. */
function FormCardSkel({ fields, grid = false, sub = true, button = true }: { fields: number; grid?: boolean; sub?: boolean; button?: boolean }) {
  const list = Array.from({ length: fields }, (_, i) => <FieldSkel key={i} label={`${26 + ((i * 13) % 20)}%`} hint={grid} />)
  return (
    <div className="card form-card" aria-hidden="true">
      <B w="42%" h={22} style={{ marginBottom: 8 }} />
      {sub && <B w="76%" h={13} />}
      {grid ? <div className="rates-grid">{list}</div> : list}
      {button && <B h={54} r={14} style={{ marginTop: 18 }} />}
    </div>
  )
}

/** Edit tab start screen: title, subtitle, 3 big buttons, privacy line. */
export function EditorSkel() {
  return (
    <div className="ed-start" aria-busy="true">
      <Busy />
      <div className="card ed-start-card" aria-hidden="true">
        <B w="46%" h={24} style={{ marginBottom: 8 }} />
        <B w="70%" h={13} />
        <div className="ed-start-btns">
          {[0, 1, 2].map((i) => <B key={i} h={132} r={14} className="skel-edbig" />)}
        </div>
        <B w="54%" h={12} style={{ marginTop: 14 }} />
      </div>
    </div>
  )
}

function QrSkel() {
  return (
    <section aria-busy="true">
      <Busy />
      <div className="card qr-actions" aria-hidden="true">
        <B w="82%" h={13} />
        <div className="skel-inline" style={{ marginTop: 14 }}><B w={140} h={48} r={12} /><B w={140} h={48} r={12} /><B w={120} h={48} r={12} /></div>
      </div>
      <div className="poster skel-poster" aria-hidden="true">
        <B w={86} h={34} style={{ margin: '0 auto' }} />
        <B w="56%" h={32} style={{ margin: '10px auto 0' }} />
        <B w="74%" h={34} style={{ margin: '14px auto 6px' }} />
        <div className="poster-qr"><div className="skel skel-qr" /></div>
        <div className="poster-rates"><B w={120} h={74} r={14} /><B w={120} h={74} r={14} /></div>
        <div className="poster-steps">
          {[78, 66, 72].map((w, i) => <div key={i} className="skel-inline"><B w={34} h={34} r={999} /><B w={`${w}%`} h={16} /></div>)}
        </div>
      </div>
    </section>
  )
}

function ReportSkel() {
  return (
    <section aria-busy="true">
      <Busy />
      <SkelStats n={3} />
      <B w="60%" h={12} style={{ margin: '14px 0' }} />
      <div className="card form-card history-card" aria-hidden="true">
        <B w="40%" h={22} style={{ marginBottom: 8 }} />
        <B w="66%" h={13} />
        <B h={46} r={999} style={{ margin: '16px 0' }} />
        <B h={140} r={12} />
      </div>
    </section>
  )
}

function PlanSkel() {
  return (
    <section aria-busy="true">
      <Busy />
      <div className="card plan-current" aria-hidden="true">
        <div className="plan-current-top">
          <div className="skel-stack" style={{ flex: 1 }}><B w={90} h={12} /><B w={140} h={26} /></div>
          <B w={48} h={48} r={14} />
        </div>
        <B w="64%" h={13} style={{ marginTop: 12 }} />
      </div>
      <B w={220} h={44} r={999} style={{ margin: '18px 0 4px' }} />
      <div className="plan-grid" aria-hidden="true">
        {[0, 1].map((i) => (
          <div className="card plan-card skel-stack" key={i}>
            <B w={70} h={12} />
            <B w={120} h={36} />
            {[80, 70, 86, 62, 74].map((w, j) => <B key={j} w={`${w}%`} h={13} />)}
            <B h={50} r={14} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** Main area of one dashboard tab while it loads. */
export function DashTabSkel({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'orders': return <OrdersSkel />
    case 'rates': return <section aria-busy="true"><Busy /><FormCardSkel fields={4} grid /></section>
    case 'qr': return <QrSkel />
    case 'edit': return <EditorSkel />
    case 'report': return <ReportSkel />
    case 'settings': return <section aria-busy="true"><Busy /><FormCardSkel fields={5} /><FormCardSkel fields={2} /></section>
    case 'plan': return <PlanSkel />
  }
}

/** The whole dashboard while the shop loads: the real top bar, sidebar menu and bottom bar (labels are known
 *  already), with shimmer only where shop data goes (shop name, plan, open toggle, the tab's content). */
export function DashSkeleton({ tab = 'orders' }: { tab?: Tab }) {
  const { t } = useI18n()
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 1023.98px)').matches
  const bottomNav = ON_ANDROID && narrow
  const nav = bottomNav ? NAV.map((g) => ({ ...g, items: g.items.filter((id) => !BOTTOM.includes(id)) })).filter((g) => g.items.length) : NAV
  const current = TABS.find((x) => x.id === tab) || TABS[0]
  return (
    <div className={`app-page dash sb-${savedSidebar()}${bottomNav ? ' has-bnav' : ''}`} aria-busy="true">
      <header className="topbar dash-bar no-print">
        <div className="topbar-in wide">
          <span className="menu-btn" aria-hidden="true"><Icon name="menu" size={24} /></span>
          {IN_APP && <BarStory />}
          <div className="bar-tab m-only"><Icon name={current.icon} size={16} /><span>{t(current.label)}</span></div>
          <div className="bar-title d-only"><h1>{t(current.label)}</h1></div>
          <div className="bar-actions d-only" aria-hidden="true">
            <B w={104} h={40} r={10} /><B w={40} h={40} r={10} /><B w={40} h={40} r={10} /><B w={40} h={40} r={10} />
          </div>
        </div>
      </header>
      <aside className="drawer no-print" aria-hidden="true">
        <div className="drawer-head">
          <B w={44} h={44} r={10} />
          <div className="drawer-title"><B w={140} h={18} /><B w={46} h={20} r={999} /></div>
        </div>
        <nav className="drawer-nav">
          {nav.map((g) => (
            <div className="drawer-group" key={g.group}>
              <div className="drawer-label">{t(g.group)}</div>
              {g.items.map((id) => {
                const x = TABS.find((y) => y.id === id)!
                return (
                  <div key={id} className={`drawer-item${tab === id ? ' on' : ''}`}>
                    <Icon name={x.icon} size={22} />
                    <span>{t(x.label)}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>
      <div className="page wide dash-main">
        <span className="sr-only">{t('loading')}</span>
        <DashTabSkel tab={tab} />
      </div>
      {bottomNav && (
        <nav className="bnav m-only no-print" aria-hidden="true">
          {BOTTOM.map((id) => {
            const x = TABS.find((y) => y.id === id)!
            return (
              <div key={id} className={`bnav-item${id === 'orders' ? ' bnav-main' : ''}${tab === id ? ' on' : ''}`}>
                <span className="bnav-ic"><Icon name={x.icon} size={id === 'orders' ? 26 : 22} /></span>
                <span className="bnav-lbl">{t(x.label)}</span>
              </div>
            )
          })}
        </nav>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/** App-level fallback while a page's code loads: the skeleton of the page being opened. */
export function RouteSkeleton() {
  const { pathname, search } = useLocation()
  if (pathname.startsWith('/dashboard')) {
    const tab = new URLSearchParams(search).get('tab')
    return <DashSkeleton tab={isTab(tab) ? tab : 'orders'} />
  }
  if (pathname.startsWith('/admin')) return <AdminSkeleton />
  if (pathname.startsWith('/setup')) return <SetupSkeleton />
  if (pathname.startsWith('/reset')) return <ResetSkeleton />
  if (pathname.startsWith('/legal')) return <LegalSkeleton />
  if (pathname.startsWith('/o/')) return <StatusSkeleton />
  if (pathname.startsWith('/s/') || pathname.startsWith('/q/')) return <UploadSkeleton />
  return <div className="app-page" aria-busy="true"><TopBar to={null} /></div>
}

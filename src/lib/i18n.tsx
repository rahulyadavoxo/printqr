import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { errMsg } from './supabase'

/* English is the source dictionary. Every key here must also exist in `hi` (TypeScript enforces it). */
const en = {
  // common
  loading: 'Loading…',
  pleaseWait: 'Please wait…',
  login: 'Log in',
  logout: 'Log out',
  save: 'Save',
  saved: 'Saved ✓',
  language: 'Language',
  bw: 'B/W',
  color: 'Color',
  oneSide: 'One side',
  bothSides: 'Both sides',
  total: 'Total',
  customer: 'Customer',
  optional: 'optional',
  ratesLine: 'B/W {bw}/page · Color {color}/page',
  calcLine: 'Pages: {p} · Copies: {c}',
  files_one: '{n} file',
  files_other: '{n} files',

  // errors
  errGeneric: 'Something went wrong. Please try again.',
  errShopNotFound: 'Shop not found.',
  errShopClosed: 'This shop is closed right now.',
  errNoFiles: 'Please add at least one file.',
  errMaxFiles: 'You can send up to 20 files in one order.',
  errOrderNotFound: 'Order not found.',
  errBadLogin: 'Wrong email or password.',
  errUserExists: 'An account with this email already exists. Please log in.',
  errEmailNotConfirmed: 'Please confirm your email first. Check your inbox for the link.',

  // not configured
  ncTitle: 'Setup is not finished',
  ncBody1: 'Supabase keys are missing. In your GitHub repo, open Settings → Secrets and variables → Actions and add',
  ncAnd: 'and',
  ncBody2: ', then run the workflow again. The README has all the steps.',

  // home
  homeBadge: 'Made for cyber cafes',
  homeTitle1: 'Scan. Upload.',
  homeTitle2: 'Print.',
  homeSub: 'Customers scan the QR at your counter and send PDFs or photos straight to your screen. No WhatsApp, no saving numbers.',
  ctaRegister: 'Register your shop',
  homeTrust: 'Works on any phone · No app to install',
  mockWant: 'Need a print?',
  mockScan: 'Scan the QR',
  mockToken: 'Your token',
  mockReady: 'Ready – collect at counter',
  howTitle: 'How it works',
  how1Title: 'Register your shop',
  how1Body: 'Sign up and set your print rates in a minute.',
  how2Title: 'Stick the QR',
  how2Body: 'Print your QR poster and put it on the counter.',
  how3Title: 'Customer uploads',
  how3Body: 'They scan, upload files and see the price upfront.',
  how4Title: 'Print and hand over',
  how4Body: 'You get the order with a token number. Print it and mark it Ready.',
  featTitle: 'Everything a busy counter needs',
  feat1Title: 'No app needed',
  feat1Body: 'Works in the phone browser. Just scan and upload.',
  feat2Title: 'Price shown upfront',
  feat2Body: 'Customers see the total before they send. No arguments at the counter.',
  feat3Title: 'Live token updates',
  feat3Body: 'Customers see on their phone when the print is ready.',
  feat4Title: 'Files auto-delete',
  feat4Body: 'Files are removed a few hours after printing, for privacy.',
  feat5Title: 'UPI payment',
  feat5Body: 'Customers can pay you directly by UPI.',
  footer: 'PrintQR · Scan, upload, print',

  // login
  loginTitle: 'Welcome back',
  loginSub: 'Log in to see your orders.',
  signupTitle: 'Register your shop',
  signupSub: 'Create an account to get your shop QR.',
  email: 'Email',
  password: 'Password',
  passwordHint: 'At least 6 characters',
  createAccount: 'Create account',
  confirmSent: 'We sent a confirmation link to your email. Open it, then log in here.',
  haveAccount: 'Already have an account?',
  noAccount: 'New here?',
  switchSignup: 'Create an account',

  // setup
  setupTitle: 'Your shop details',
  setupSub: 'This shows on your QR poster and on the customer page.',
  shopName: 'Shop name',
  address: 'Address',
  phone: 'Phone',
  phoneHint: 'Shown on the poster',
  upiId: 'UPI ID',
  upiHint: 'So customers can pay you directly',
  creating: 'Creating…',
  createShop: 'Create shop',

  // upload
  uShopNotFound: 'Shop not found. Please scan the QR again.',
  uClosedTitle: 'This shop is closed right now',
  uClosedBody: 'Please try again in a little while.',
  uDropTitle: 'Choose files to print',
  uDropSub: 'PDF, photos or Word · up to 20 files, 50 MB each',
  uAddMore: '+ Add more files',
  uRemove: 'Remove',
  uCounting: 'Counting pages…',
  uPages_one: '{n} page',
  uPages_other: '{n} pages',
  uWhichPages: 'Which pages (empty = all)',
  uNumPages: 'Number of pages',
  uCopies: 'Copies',
  uBadRange: 'Wrong page range (example: 1-3,5)',
  uYourName: 'Your name',
  uNote: 'Note for the shop',
  uNotePh: 'Example: spiral binding too',
  uSend: 'Send for printing',
  uUploading: 'Uploading {i} of {n}…',
  uSending: 'Sending…',
  uAutoDelete: 'Your files are deleted automatically after printing.',
  uMaxFiles: 'You can send up to {n} files in one order.',
  uTooBig: '{name} is bigger than 50 MB.',
  uCountFail: "Couldn't count the pages in {name}. Please enter the page count yourself.",
  uDetails: 'Your details',

  // status
  sNotFound: 'Order not found.',
  sYourToken: 'Your token',
  st_uploading: 'Upload not finished',
  st_received: 'Received – in queue',
  st_printing: 'Printing',
  st_ready: 'Ready – collect at counter',
  st_done: 'Done – thank you!',
  st_cancelled: 'Cancelled',
  step_received: 'Received',
  step_printing: 'Printing',
  step_ready: 'Ready',
  sHint: 'Tell your token number at the counter. This page updates by itself.',
  sPay: 'Pay {amount} by UPI',

  // dashboard
  tabOrders: 'Orders',
  tabRates: 'Rates',
  tabQr: 'QR poster',
  tabReport: 'Earnings',
  tabSettings: 'Settings',
  shopOpen: 'Shop open',
  shopClosed: 'Shop closed',
  actStart: 'Start printing',
  actReady: 'Mark ready',
  actDone: 'Handed over',
  dst_uploading: 'Uploading',
  dst_received: 'New',
  dst_printing: 'Printing',
  dst_ready: 'Ready',
  dst_done: 'Done',
  dst_cancelled: 'Cancelled',
  dActive: 'Active orders',
  newOrderNotif: 'New order #{token}',
  fileOpenFail: "Couldn't open the file.",
  downloadFail: 'Download failed.',
  confirmDelete: 'Delete the files for token #{token} now?',
  confirmCancel: 'Cancel this order?',
  noOrders: 'No new orders yet',
  noOrdersSub: 'New orders show up here with a ding sound.',
  hideFinished: 'Hide finished orders',
  showFinished: 'Finished / cancelled orders ({n})',
  openPrint: 'Open / Print',
  download: 'Download',
  filesDeleted: 'Files have been deleted.',
  cancel: 'Cancel',
  deleteNow: 'Delete files now',
  ratesTitle: 'Print rates (A4)',
  ratesSub: 'Customers see the total at these rates when they upload.',
  rate_bw_single: 'B/W, one side',
  rate_bw_double: 'B/W, both sides',
  rate_color_single: 'Color, one side',
  rate_color_double: 'Color, both sides',
  perPage: '₹ per page',
  ratesSaved: 'Rates saved ✓',
  printPoster: 'Print poster',
  downloadQr: 'Download QR',
  copyLink: 'Copy link',
  linkCopied: 'Link copied ✓',
  qrHint: 'Print this poster and stick it on your counter. It prints in the language selected above.',
  posterHeadline: 'Scan to send your files for printing',
  posterSub: 'No need to save any WhatsApp number.',
  posterStep1: 'Scan the QR with your phone camera',
  posterStep2: 'Choose your PDF or photo – the price shows right away',
  posterStep3: 'Tell your token number at the counter',
  perPageShort: 'per page',
  today: 'Today',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  orders_one: '{n} order',
  orders_other: '{n} orders',
  reportNote: 'Cancelled orders are not counted.',
  settingsTitle: 'Shop settings',
  autoDeleteLabel: 'Delete files automatically after',
  hours_one: '{n} hour',
  hours_other: '{n} hours'
}

export type Key = keyof typeof en

const hi: Record<Key, string> = {
  loading: 'लोड हो रहा है…',
  pleaseWait: 'रुकिए…',
  login: 'लॉगिन',
  logout: 'लॉग आउट',
  save: 'सेव करें',
  saved: 'सेव हो गया ✓',
  language: 'भाषा',
  bw: 'B/W',
  color: 'कलर',
  oneSide: 'एक तरफ',
  bothSides: 'दोनों तरफ',
  total: 'कुल',
  customer: 'ग्राहक',
  optional: 'ज़रूरी नहीं',
  ratesLine: 'B/W {bw}/पेज · कलर {color}/पेज',
  calcLine: 'पेज: {p} · कॉपी: {c}',
  files_one: '{n} फ़ाइल',
  files_other: '{n} फ़ाइलें',

  errGeneric: 'कुछ गड़बड़ हो गई। फिर से कोशिश करें।',
  errShopNotFound: 'दुकान नहीं मिली।',
  errShopClosed: 'दुकान अभी बंद है।',
  errNoFiles: 'कम से कम एक फ़ाइल जोड़ें।',
  errMaxFiles: 'एक ऑर्डर में ज़्यादा से ज़्यादा 20 फ़ाइलें भेज सकते हैं।',
  errOrderNotFound: 'ऑर्डर नहीं मिला।',
  errBadLogin: 'ईमेल या पासवर्ड गलत है।',
  errUserExists: 'इस ईमेल से पहले से अकाउंट है। लॉगिन करें।',
  errEmailNotConfirmed: 'पहले अपना ईमेल कन्फ़र्म करें। ईमेल में आया लिंक खोलें।',

  ncTitle: 'सेटअप अभी पूरा नहीं हुआ',
  ncBody1: 'Supabase keys नहीं मिलीं। GitHub repo में Settings → Secrets and variables → Actions खोलें और जोड़ें',
  ncAnd: 'और',
  ncBody2: ', फिर workflow दोबारा चलाएँ। पूरे स्टेप README में हैं।',

  homeBadge: 'साइबर कैफ़े के लिए बना',
  homeTitle1: 'स्कैन करें। फ़ाइल भेजें।',
  homeTitle2: 'प्रिंट लें।',
  homeSub: 'ग्राहक काउंटर पर लगा QR स्कैन करके PDF या फ़ोटो सीधे आपकी स्क्रीन पर भेजते हैं। न WhatsApp, न नंबर सेव करने का झंझट।',
  ctaRegister: 'अपनी दुकान रजिस्टर करें',
  homeTrust: 'हर फ़ोन पर चलता है · कोई ऐप नहीं डालना',
  mockWant: 'प्रिंट चाहिए?',
  mockScan: 'QR स्कैन करें',
  mockToken: 'आपका टोकन',
  mockReady: 'तैयार है – काउंटर से लें',
  howTitle: 'कैसे काम करता है',
  how1Title: 'दुकान रजिस्टर करें',
  how1Body: 'साइन अप करें और एक मिनट में प्रिंट रेट सेट करें।',
  how2Title: 'QR चिपकाएँ',
  how2Body: 'अपना QR पोस्टर प्रिंट करके काउंटर पर लगाएँ।',
  how3Title: 'ग्राहक फ़ाइल भेजे',
  how3Body: 'ग्राहक स्कैन करके फ़ाइल भेजे, दाम पहले ही दिख जाता है।',
  how4Title: 'प्रिंट करके दें',
  how4Body: 'टोकन नंबर के साथ ऑर्डर आता है। प्रिंट करें और "तैयार" दबाएँ।',
  featTitle: 'भीड़ वाले काउंटर के लिए सब कुछ',
  feat1Title: 'कोई ऐप नहीं चाहिए',
  feat1Body: 'फ़ोन के ब्राउज़र में चलता है। बस स्कैन करें और भेजें।',
  feat2Title: 'दाम पहले दिखे',
  feat2Body: 'भेजने से पहले ग्राहक को कुल दाम दिखता है। काउंटर पर बहस नहीं।',
  feat3Title: 'टोकन का लाइव हाल',
  feat3Body: 'प्रिंट तैयार होते ही ग्राहक के फ़ोन पर दिख जाता है।',
  feat4Title: 'फ़ाइलें अपने आप डिलीट',
  feat4Body: 'प्रिंट के कुछ घंटे बाद फ़ाइलें हट जाती हैं, ताकि प्राइवेसी बनी रहे।',
  feat5Title: 'UPI से पेमेंट',
  feat5Body: 'ग्राहक सीधे आपको UPI से पैसे दे सकते हैं।',
  footer: 'PrintQR · स्कैन करें, भेजें, प्रिंट लें',

  loginTitle: 'फिर से स्वागत है',
  loginSub: 'अपने ऑर्डर देखने के लिए लॉगिन करें।',
  signupTitle: 'अपनी दुकान रजिस्टर करें',
  signupSub: 'अपनी दुकान का QR पाने के लिए अकाउंट बनाएँ।',
  email: 'ईमेल',
  password: 'पासवर्ड',
  passwordHint: 'कम से कम 6 अक्षर',
  createAccount: 'अकाउंट बनाएँ',
  confirmSent: 'आपके ईमेल पर कन्फ़र्म लिंक भेजा है। लिंक खोलें, फिर यहाँ लॉगिन करें।',
  haveAccount: 'पहले से अकाउंट है?',
  noAccount: 'नए हैं?',
  switchSignup: 'अकाउंट बनाएँ',

  setupTitle: 'आपकी दुकान की जानकारी',
  setupSub: 'यह आपके QR पोस्टर और ग्राहक वाले पेज पर दिखेगा।',
  shopName: 'दुकान का नाम',
  address: 'पता',
  phone: 'फ़ोन',
  phoneHint: 'पोस्टर पर दिखेगा',
  upiId: 'UPI ID',
  upiHint: 'ताकि ग्राहक सीधे पेमेंट कर सकें',
  creating: 'बन रहा है…',
  createShop: 'दुकान बनाएँ',

  uShopNotFound: 'दुकान नहीं मिली। QR फिर से स्कैन करें।',
  uClosedTitle: 'दुकान अभी बंद है',
  uClosedBody: 'थोड़ी देर बाद फिर कोशिश करें।',
  uDropTitle: 'प्रिंट के लिए फ़ाइल चुनें',
  uDropSub: 'PDF, फ़ोटो या Word · 20 फ़ाइलें तक, हर फ़ाइल 50 MB तक',
  uAddMore: '+ और फ़ाइल जोड़ें',
  uRemove: 'हटाएँ',
  uCounting: 'पेज गिने जा रहे हैं…',
  uPages_one: '{n} पेज',
  uPages_other: '{n} पेज',
  uWhichPages: 'कौन से पेज (खाली = सारे)',
  uNumPages: 'कितने पेज',
  uCopies: 'कॉपी',
  uBadRange: 'पेज रेंज गलत है (जैसे: 1-3,5)',
  uYourName: 'आपका नाम',
  uNote: 'दुकान वाले के लिए नोट',
  uNotePh: 'जैसे: स्पाइरल बाइंडिंग भी करनी है',
  uSend: 'प्रिंट के लिए भेजें',
  uUploading: '{n} में से {i} अपलोड हो रही है…',
  uSending: 'भेज रहे हैं…',
  uAutoDelete: 'प्रिंट के बाद आपकी फ़ाइलें अपने आप डिलीट हो जाती हैं।',
  uMaxFiles: 'एक ऑर्डर में ज़्यादा से ज़्यादा {n} फ़ाइलें भेज सकते हैं।',
  uTooBig: '{name} 50 MB से बड़ी है।',
  uCountFail: '{name} के पेज गिन नहीं पाए। पेज की गिनती खुद लिखें।',
  uDetails: 'आपकी जानकारी',

  sNotFound: 'ऑर्डर नहीं मिला।',
  sYourToken: 'आपका टोकन',
  st_uploading: 'अपलोड पूरा नहीं हुआ',
  st_received: 'मिल गया – लाइन में है',
  st_printing: 'प्रिंट हो रहा है',
  st_ready: 'तैयार है – काउंटर से लें',
  st_done: 'हो गया – धन्यवाद!',
  st_cancelled: 'कैंसल हो गया',
  step_received: 'मिला',
  step_printing: 'प्रिंट',
  step_ready: 'तैयार',
  sHint: 'काउंटर पर अपना टोकन नंबर बताएँ। यह पेज अपने आप अपडेट होता है।',
  sPay: 'UPI से {amount} दें',

  tabOrders: 'ऑर्डर',
  tabRates: 'रेट',
  tabQr: 'QR पोस्टर',
  tabReport: 'हिसाब',
  tabSettings: 'सेटिंग',
  shopOpen: 'दुकान खुली',
  shopClosed: 'दुकान बंद',
  actStart: 'प्रिंट शुरू',
  actReady: 'तैयार है',
  actDone: 'दे दिया',
  dst_uploading: 'अपलोड हो रहा',
  dst_received: 'नया',
  dst_printing: 'प्रिंट हो रहा',
  dst_ready: 'तैयार',
  dst_done: 'हो गया',
  dst_cancelled: 'कैंसल',
  dActive: 'चालू ऑर्डर',
  newOrderNotif: 'नया ऑर्डर #{token}',
  fileOpenFail: 'फ़ाइल नहीं खुली।',
  downloadFail: 'डाउनलोड नहीं हुआ।',
  confirmDelete: 'टोकन #{token} की फ़ाइलें अभी डिलीट करें?',
  confirmCancel: 'यह ऑर्डर कैंसल करें?',
  noOrders: 'अभी कोई नया ऑर्डर नहीं',
  noOrdersSub: 'नया ऑर्डर आते ही यहाँ दिखेगा और घंटी बजेगी।',
  hideFinished: 'पुराने ऑर्डर छुपाएँ',
  showFinished: 'पूरे / कैंसल ऑर्डर ({n})',
  openPrint: 'खोलें / प्रिंट',
  download: 'डाउनलोड',
  filesDeleted: 'फ़ाइलें डिलीट हो चुकी हैं।',
  cancel: 'कैंसल',
  deleteNow: 'फ़ाइलें अभी डिलीट करें',
  ratesTitle: 'प्रिंट रेट (A4)',
  ratesSub: 'फ़ाइल भेजते समय ग्राहक को इसी रेट से कुल दाम दिखेगा।',
  rate_bw_single: 'B/W, एक तरफ',
  rate_bw_double: 'B/W, दोनों तरफ',
  rate_color_single: 'कलर, एक तरफ',
  rate_color_double: 'कलर, दोनों तरफ',
  perPage: '₹ प्रति पेज',
  ratesSaved: 'रेट सेव हो गया ✓',
  printPoster: 'पोस्टर प्रिंट करें',
  downloadQr: 'QR डाउनलोड',
  copyLink: 'लिंक कॉपी',
  linkCopied: 'लिंक कॉपी हो गया ✓',
  qrHint: 'यह पोस्टर प्रिंट करके काउंटर पर चिपकाएँ। पोस्टर ऊपर चुनी गई भाषा में प्रिंट होगा।',
  posterHeadline: 'प्रिंट के लिए फ़ाइल भेजने को स्कैन करें',
  posterSub: 'कोई WhatsApp नंबर सेव करने की ज़रूरत नहीं।',
  posterStep1: 'फ़ोन के कैमरे से QR स्कैन करें',
  posterStep2: 'PDF या फ़ोटो चुनें – दाम तुरंत दिखेगा',
  posterStep3: 'काउंटर पर अपना टोकन नंबर बताएँ',
  perPageShort: 'प्रति पेज',
  today: 'आज',
  last7: 'पिछले 7 दिन',
  last30: 'पिछले 30 दिन',
  orders_one: '{n} ऑर्डर',
  orders_other: '{n} ऑर्डर',
  reportNote: 'कैंसल ऑर्डर हिसाब में नहीं गिने जाते।',
  settingsTitle: 'दुकान की सेटिंग',
  autoDeleteLabel: 'फ़ाइलें अपने आप डिलीट हों',
  hours_one: '{n} घंटे बाद',
  hours_other: '{n} घंटे बाद'
}

export type Lang = 'en' | 'hi'
const DICTS: Record<Lang, Record<Key, string>> = { en, hi }
const STORAGE_KEY = 'printqr-lang'

type Vars = Record<string, string | number>

/* Known English server / auth messages mapped to dictionary keys. */
const SERVER_ERRORS: Record<string, Key> = {
  'shop not found': 'errShopNotFound',
  'shop is closed right now': 'errShopClosed',
  'no files': 'errNoFiles',
  'max 20 files per order': 'errMaxFiles',
  'order not found': 'errOrderNotFound',
  'invalid login credentials': 'errBadLogin',
  'user already registered': 'errUserExists',
  'email not confirmed': 'errEmailNotConfirmed',
  'something went wrong': 'errGeneric'
}

type Ctx = {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: Key, vars?: Vars) => string
  tn: (one: Key, other: Key, n: number) => string
  te: (e: unknown) => string
}

function fill(s: string, vars?: Vars): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'hi') return v
  } catch {
    /* ignore */
  }
  return 'en'
}

const I18nContext = createContext<Ctx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<Ctx>(() => {
    const dict = DICTS[lang]
    const t = (key: Key, vars?: Vars) => fill(dict[key] ?? en[key], vars)
    const tn = (one: Key, other: Key, n: number) => t(n === 1 ? one : other, { n })
    const te = (e: unknown) => {
      const raw = errMsg(e)
      const k = SERVER_ERRORS[raw.trim().replace(/\.$/, '').toLowerCase()]
      return k ? t(k) : raw
    }
    return { lang, setLang, t, tn, te }
  }, [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext)
  if (!c) throw new Error('useI18n must be used inside I18nProvider')
  return c
}

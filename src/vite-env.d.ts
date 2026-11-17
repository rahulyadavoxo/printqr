/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** Google AdSense publisher id, e.g. ca-pub-1234567890123456. Unset = no ads. */
  readonly VITE_ADSENSE_CLIENT?: string
  /** AdSense display ad unit (slot) id. Unset = no ads. */
  readonly VITE_ADSENSE_SLOT?: string
}

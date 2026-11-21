// Problems worth an alert go to public.ops_events (v25). The "Health check" GitHub workflow reads them
// every 15 minutes and opens a GitHub issue (you get a notification). Never throws.
// No personal data: email addresses are masked, messages are cut to 300 characters.
export async function logOps(source: string, message: unknown, level: 'error' | 'warn' = 'error'): Promise<void> {
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !key) return
    const text = (message instanceof Error ? message.message : String(message))
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '<token>')
      .slice(0, 300)
    await fetch(`${url}/rest/v1/ops_events`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ source: source.slice(0, 40), level, message: text })
    })
  } catch (e) {
    console.error('ops log failed', e)
  }
}

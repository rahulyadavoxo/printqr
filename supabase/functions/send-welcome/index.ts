// POST (JWT required): send the logged-in user one welcome mail from your Gmail, once.
// Only after the email is confirmed. The "sent" flag lives in the user's app_metadata (users can't edit it).
import { button, layout, note, para, sendGmail, steps as stepList } from '../_shared/gmail.ts'

const URL_ = Deno.env.get('SUPABASE_URL') || ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const SITE = 'https://print.receipto.in/'
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405)
  try {
    const auth = req.headers.get('Authorization') || ''
    const me = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || KEY, Authorization: auth } })
    if (!me.ok) return reply({ error: 'not_logged_in' }, 401)
    const user = (await me.json()) as { id: string; email?: string; email_confirmed_at?: string | null; app_metadata?: Record<string, unknown> }
    if (!user.email || !user.email_confirmed_at) return reply({ ok: false, reason: 'not_confirmed' })
    if (user.app_metadata?.welcome_sent) return reply({ ok: true, already: true })

    // Mark first so two tabs never send twice.
    const mark = await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_metadata: { ...(user.app_metadata || {}), welcome_sent: new Date().toISOString() } })
    })
    if (!mark.ok) throw new Error(`mark failed ${mark.status}`)

    const steps = [
      'Shop ka naam aur print rate set karo. / दुकान का नाम और प्रिंट रेट सेट करें।',
      'Apna QR print karke counter pe lagao. / अपना QR प्रिंट करके काउंटर पर लगाएँ।',
      'Customer QR scan karke file bhejega, order dashboard pe aa jayega. / ग्राहक QR स्कैन करके फ़ाइल भेजेगा, ऑर्डर डैशबोर्ड पर आएगा।'
    ]
    const html = layout('Welcome to PrintQR!', [
      para('Aapka shop account ban gaya hai. Ab customers bina koi app ya WhatsApp ke, sirf QR scan karke print ke liye file bhej sakte hain.'),
      para('आपका अकाउंट बन गया है। अब ग्राहक सिर्फ़ QR स्कैन करके प्रिंट के लिए फ़ाइल भेज सकते हैं।', true),
      `<div style="margin:22px 0 4px;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#586274">3 steps mein shuru karein</div>`,
      stepList(steps),
      button(`${SITE}#/dashboard`, 'Open dashboard'),
      note('Koi sawaal ho to bas is mail ka reply kar dijiye, hum madad karenge. / कोई सवाल हो तो इस मेल का जवाब दें।')
    ].join('\n'), { icon: '🎉', subtitle: 'PrintQR में आपका स्वागत है', preheader: 'Your shop is ready. 3 quick steps to get your first print order.' })
    const text = `Welcome to PrintQR!\n\nAapka account ban gaya hai.\n\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nDashboard: ${SITE}#/dashboard\n\nKoi sawaal ho to is mail ka reply kar dijiye.`
    await sendGmail(user.email, 'Welcome to PrintQR 🎉', html, text)
    return reply({ ok: true })
  } catch (e) {
    console.error('send-welcome', e)
    return reply({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500)
  }
})

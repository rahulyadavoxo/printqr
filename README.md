# PrintQR

**Scan karo, file bhejo, print lo.** Cyber cafe ke liye QR se file upload aur print queue.

Customer ko shop ka WhatsApp number save nahi karna padta. Shop wala apna QR poster counter pe chipkata hai, customer scan karke PDF ya photo upload karta hai, total price pehle hi dekh leta hai, aur file token number ke saath seedha shop ke dashboard pe pahunch jaati hai.

## V1 features

**Customer (no app, no login)**
- QR scan → us shop ka upload page
- PDF, photo, Word/Excel/PPT upload, ek order mein 20 files tak (50 MB each)
- PDF ke pages apne aap gine jaate hain, page range (jaise `1-3,5`) choose kar sakte hain
- Copies, B/W ya Color, ek side ya dono side
- Shop ke rate se total live dikhta hai (price server pe dobara calculate hota hai, browser pe trust nahi)
- Token number, live status page (Line mein → Printing → Ready)
- UPI pay button (agar shop ne UPI ID daali hai)

**Shop owner**
- Email/password signup, shop details
- Apna rate card (B/W/Color × ek side/dono side, per page)
- QR poster print + QR PNG download
- Live order queue, naye order pe ding sound aur notification
- File kholo/print, download, status badlo (Print shuru → Ready → Done), cancel
- Hisaab: aaj, 7 din, 30 din ki kamai
- Shop khuli/band toggle
- Files auto-delete (1 se 48 ghante, shop choose kare) + "files abhi delete karo" button

## Tech

- React + TypeScript + Vite, PWA (phone/PC pe install ho sakta hai)
- Supabase: Auth, Postgres (RLS), Storage, Realtime
- Hosting: GitHub Pages (free), build GitHub Actions pe
- Auto-delete: Supabase pg_cron har 15 minute `cleanup-files` Edge Function chalata hai (backup: GitHub Actions har 6 ghante `scripts/cleanup.mjs`)

## Setup (ek baar, ~10 minute)

### 1. Supabase project
1. https://supabase.com pe free account banao → **New project** (region: Mumbai / `ap-south-1`).
2. **SQL Editor → New query** mein `supabase/schema.sql` ka poora content paste karo → **Run**.
3. **Authentication → URL Configuration** (custom domain ho to wahi, jaise `https://print.receipto.in/`):
   - Site URL: `https://<github-username>.github.io/printqr/`
   - Redirect URLs mein bhi yahi add karo, aur `https://<github-username>.github.io/printqr/**` bhi (password reset link isi pe aata hai).
4. (Testing ke liye optional) **Authentication → Sign In / Providers → Email** mein *Confirm email* off kar sakte ho.
5. **Project Settings → API** se copy karo: Project URL, `anon` public key, `service_role` key.

### 1b. Purane database ka upgrade (v2: counters, passport photo, forgot password)
Agar `schema.sql` pehle chala chuke ho, to **SQL Editor** mein `supabase/migrations/2026-11-17-v2.sql` ka poora content paste karke **Run** karo. Ye file kitni bhi baar chala sakte ho.

### 1c. Plans (v3: Free + Pro, Razorpay subscriptions)
1. **SQL Editor** mein `supabase/migrations/2026-11-17-v3-plans.sql` paste karke **Run** karo (v2 ke baad). Isse pehle app purane tarike se chalta hai (koi ads/lock nahi).
2. Supabase → **Edge Functions → Secrets**: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
3. GitHub secret `SUPABASE_ACCESS_TOKEN` (Supabase → Account → Access Tokens). Workflow **"Deploy Supabase Edge Functions"** functions deploy karta hai: `create-subscription`, `verify-payment`, `cancel-subscription`, `razorpay-webhook`.
4. Razorpay Dashboard → **Settings → Webhooks → Add**: URL `https://<project-ref>.supabase.co/functions/v1/razorpay-webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`, events: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`, `subscription.completed` (optional: `subscription.pending`, `subscription.paused`, `subscription.resumed`).
5. Ads (optional): GitHub repo **variables** (ya secrets) `VITE_ADSENSE_CLIENT` (`ca-pub-…`) aur `VITE_ADSENSE_SLOT` (ad unit id). Dono na ho to koi ad nahi dikhta. Client id milne par `public/ads.txt` bhi add karna.

| Plan | Price | Features |
|---|---|---|
| Free | ₹0 | Ads, sirf main QR queue, passport sheet nahi |
| Pro | ₹49/month ya ₹539/year (1 month free) | No ads, unlimited counters, passport photo sheet, dynamic QR |

### 1d. Auto-delete Supabase se (v4: har 15 minute)
1. Workflow **"Deploy Supabase Edge Functions"** `cleanup-files` function bhi deploy karta hai (push pe apne aap).
2. Uske baad **SQL Editor** mein `supabase/migrations/2026-11-17-v4-cleanup-cron.sql` paste karke **Run** karo. Ye pg_cron + pg_net on karta hai aur har 15 minute cleanup chalata hai. Koi naya secret nahi chahiye.
3. Check: `select * from cron.job_run_details order by start_time desc limit 5;`

### 1e. Dynamic QR (v5, Pro)
SQL Editor mein `supabase/migrations/2026-11-18-v5-dynamic-qr.sql` paste karke **Run** karo. Iske baad Pro shop ka QR short code wala banega (`#/q/CODE`). Owner QR tab se badal sakta hai ki QR kaunsi queue khole, use pause kar sakta hai aur scans dekh sakta hai, bina poster dobara print kiye. Pro khatam hone par bhi printed code chalta rahega. Free shops ka QR static rahega.

Limits server pe bhi lagte hain (counter trigger, `create_order`, `get_shop_public.is_pro`). Owner plan columns khud update nahi kar sakta.

### 2. GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | Supabase Project URL |
| `VITE_SUPABASE_ANON_KEY` | `anon` public key |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key (sirf cleanup job ke liye, kabhi frontend mein mat daalna) |

### 3. GitHub Pages
Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Phir **Actions → "Build & deploy to GitHub Pages" → Run workflow**. Build ho jaane ke baad app yahan live hoga:
`https://<github-username>.github.io/printqr/`

## Local development

```bash
cp .env.example .env   # apni Supabase keys daalo
npm install
npm run dev
```

## Notes
- Supabase free plan 7 din tak koi activity na ho to project pause kar deta hai. Roz use hoga to koi dikkat nahi.
- Customer ki files private bucket mein rehti hain. Sirf us shop ka owner signed link se khol sakta hai.
- Owner orders ka sirf status badal sakta hai, price ya token nahi.

## Version 2 ideas
Photo → PDF, passport photo layout, desktop print agent (direct printer pe), multiple counters, Hindi/English toggle, owner subscription plans.

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
- ID card (Aadhaar / PAN) sheet (Pro shop): front + back photo, crop, ek A4 pe asli card size (85.6 × 54 mm) cut line ke saath
- Status page pe **Dobara print karo**: purani files dobara upload kiye bina naya order (naya token), copies aur B/W/Color chuno

**Shop owner**
- Email/password signup, shop details
- Apna rate card (B/W/Color × ek side/dono side, per page)
- QR poster print + QR PNG download
- Live order queue, naye order pe ding sound aur notification
- File kholo/print, download, status badlo (Print shuru → Ready → Done), cancel
- Hisaab: aaj, 7 din, 30 din ki kamai
- Shop khuli/band toggle
- Files auto-delete (plan ke hisaab se: Free 3 ghante, Pro 24 ghante, Plus 7 din; jo order abhi print nahi hua uski files kam se kam 48 ghante rehti hain) + "files abhi delete karo" button
- Kaagaz ka stock (sheets ya reams): order Done karne pe sheets apne aap ghat-ti hain, kam hone pe banner + phone pe ek push (sab plans)

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
| Free | ₹0 | Owner dashboard pe ads, sirf main QR queue, passport / ID card sheet nahi, files 3 ghante, order 50 MB, history 7 din |
| Pro | ₹49/month ya ₹539/year (1 month free) | Customers ke liye no ads, 2 naye counters, passport photo sheet, ID card sheet, dynamic QR, QR card design, auto-print, files 24 ghante, order 100 MB, history 6 mahine |
| Plus | ₹99/month ya ₹999/year | Pro ka sab kuch + kahin bhi ads nahi, unlimited counters, apna colour/logo (branding), staff logins, files 7 din, order 200 MB, history 1 saal |

Plus ke liye Razorpay mein alag plan banane ki zaroorat nahi, functions khud banate hain (v16 SQL ke baad). Pro se Plus upgrade purani subscription cancel kar deta hai.

### 1d. Auto-delete Supabase se (v4: har 15 minute)
1. Workflow **"Deploy Supabase Edge Functions"** `cleanup-files` function bhi deploy karta hai (push pe apne aap).
2. Uske baad **SQL Editor** mein `supabase/migrations/2026-11-17-v4-cleanup-cron.sql` paste karke **Run** karo. Ye pg_cron + pg_net on karta hai aur har 15 minute cleanup chalata hai. Koi naya secret nahi chahiye.
3. Check: `select * from cron.job_run_details order by start_time desc limit 5;`

### 1e. Dynamic QR (v5, Pro)
SQL Editor mein `supabase/migrations/2026-11-18-v5-dynamic-qr.sql` paste karke **Run** karo. Iske baad Pro shop ka QR short code wala banega (`#/q/CODE`). Owner QR tab se badal sakta hai ki QR kaunsi queue khole, use pause kar sakta hai aur scans dekh sakta hai, bina poster dobara print kiye. Pro khatam hone par bhi printed code chalta rahega. Free shops ka QR static rahega.

Limits server pe bhi lagte hain (counter trigger, `create_order`, `get_shop_public.is_pro`). Owner plan columns khud update nahi kar sakta.

### 1f. Baaki database updates (v6 se v25)

**Ab apne aap, aapki approval ke baad:** `supabase/migrations/` mein nayi ya badli hui `.sql` file `main` pe push hote hi workflow **"Run Supabase SQL migrations"** ruk kar aapki approval maangta hai (GitHub environment `production`, required reviewer: aap). Actions → us run → **Review deployments → production → Approve** dabate hi wo use live DB pe chala deta hai (version order mein, wahi `SUPABASE_ACCESS_TOKEN` secret). Haath se chalana ho to Actions → is workflow → **Run workflow** → file ka naam ya `all`. Log mein sirf OK/FAIL aata hai. Har nayi migration file dobara chalane pe safe honi chahiye.

`supabase/migrations/` ki files **version number ke order mein** (v6, v7, … v18) SQL Editor mein paste karke **Run** karo. Sab file kitni bhi baar chala sakte ho.

| File | Kya karti hai | Pehle chahiye |
|---|---|---|
| v6-shop-photo | Shop profile photo (`shop-logos` bucket) | |
| v7-upload-security | Upload rate limits, file-type allowlist, size checks | |
| v8-privacy-rates | Files delete hone par customer naam/note saaf, rate checks | |
| v9-turnstile | Cloudflare Turnstile bot check | Edge Function secret `TURNSTILE_SECRET` |
| v10-no-order-captcha | Orders pe CAPTCHA wapas band (v7 limits chalu) | |
| v11-server-page-count | Server PDF pages ginta hai, price fix (`finalize-order`) | |
| v12-admin, v13-admin-full | Admin panel `#/admin` (apna user `public.admins` mein daalo) | |
| v14-push, v15-push-grant | Naye order pe push (FCM, `push-new-order`) | v4, secret `FCM_SERVICE_ACCOUNT` |
| v16-plus | Plus plan | v3 |
| v17-plan-features | Plan limits, staff, shop timings, binding/lamination, ready push | v16 |
| v18-order-lang | Notification sirf customer/owner ki bhasha mein | v17 |
| v19-admin-plus | Admin panel mein Plus plan (Plus ko din dene par Plus hi rahe, MRR, Plus tag) | v16 |
| v20-admin-grants | Edge Functions ko admins list padhne ki permission (admin panel ka "Something went wrong" fix) | v13 |
| v23-idcard-reorder-paper | ID card sheet (Pro), Dobara print (`reorder`), kaagaz stock + low alert | v4, v14, v17, v18; functions `reorder`, `finalize-order`, `push-new-order` |
| v24-photo-thumbs | Photo ke chhote thumbnails owner list ke liye | v23 |
| v25-launch-safety | Bina print hue order ki files nahi mitti (max 48 ghante), Free 3 ghante, storage budget, zarurat pe hi bot check (`upload-pass`), "Block sender", finalize limit, `ops_events` + `ops_health` (alerts) | v24; secret `TURNSTILE_SECRET`; function `upload-pass` |

**Fresh install:** `supabase/schema.sql` ab generated hai (`supabase/schema-base.sql` + saari migrations). Nayi migration ke baad `scripts/build-schema.sh` chalao; CI (pull request pe) check karta hai ki schema.sql purana na ho, aur ek local Supabase pe poora install + har migration dobara chala ke dekhta hai.

### 1g. v23: ID card sheet, Dobara print, kaagaz stock
1. `main` pe push hote hi workflow **"Run Supabase SQL migrations"** `2026-11-21-v23-idcard-reorder-paper.sql` chala deta hai, aur **"Deploy Supabase Edge Functions"** naya `reorder` function (aur badle hue `finalize-order`, `push-new-order`) deploy karta hai. Koi naya secret nahi.
2. ID card: `order_files.item_kind = 'idcard'`, rate `rates.idcard_sheet` (na ho to ₹20) × copies. Sirf Pro / Plus. Windows app mein 100% (no scaling) pe print hota hai.
3. Dobara print: `reorder()` naya order banata hai, phir `reorder` function purani files ko naye order ke apne path pe copy karta hai (har order ki apni files, isliye auto-delete ek order ki files dusre order se kabhi nahi hatata). Files delete ho chuki hon ya shop band ho to button nahi dikhta.
4. Kaagaz: Settings → Paper stock. Order **Done** hone pe ek hi baar sheets ghat-ti hain (dono side = pages/2 upar round, passport / ID card = sheet × copies), 0 se neeche nahi. Limit se neeche jaane pe ek push, stock badhane ke baad hi agla.

Function SQL se pehle deploy ho jaaye to zyada tar functions purane tarike se chalte rehte hain, lekin naye features SQL chalne ke baad hi on hote hain.

### 1h. Launch safety (v25): alerts, backups, approval

- **SQL approval:** Repo → Settings → Environments → **New environment** `production` → **Required reviewers**: apna GitHub user → Save. Iske baad koi bhi migration live DB pe tabhi chalegi jab aap Approve karoge.
- **Branch protection:** Settings → Branches → Add rule `main` → *Require a pull request before merging* (approvals 0) + *Require status checks*: `web`, `sql` (workflow **CI**).
- **Alerts:** workflow **"Health check"** har 15 minute site, Supabase, Edge Function errors (`ops_events`), pg_cron, auto-delete aur storage/DB size check karta hai. Problem par label `alert` wala GitHub issue khulta hai (theek hone par band). GitHub app mein is repo ki notifications ON rakho. Supabase Pro lene ke baad repo **variables** `STORAGE_LIMIT_MB=102400`, `DB_LIMIT_MB=8192` set karo.
- **Backups:** nightly backup ab GnuPG AES-256 (integrity check ke saath, `.tar.gz.gpg`). Fail hone ya secrets na hone par alert issue. **"Backup restore test"** har mahine (aur manually) sabse naya backup ek local Supabase mein restore karke check karta hai.
- **Restore (asli disaster mein):** R2 se file lo → `gpg --decrypt printqr-db-....tar.gz.gpg | tar -xz` (purani `.enc`: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in FILE | tar -xz`) → naye Supabase project pe `psql "<DB URL>" --single-transaction -f roles.sql -f schema.sql -c 'SET session_replication_role = replica' -f data.sql`. Uploaded files backup mein nahi hote (wo 3 ghante se 7 din mein waise bhi mit jaate hain).
- **Bot check:** `app_settings.order_captcha` = `auto` (default: sirf jab ek network se 10 min mein 3+ ya ek shop pe 20+ order), `always`, ya `off`. Edge Function secret `TURNSTILE_SECRET` zaroori hai.
- **Storage budget:** `app_settings.storage_budget_mb` (poori service, default 700), `shop_storage_free_mb` (150), `shop_storage_paid_mb` (500). Supabase Pro ke baad badha do.
- **Email:** `RESEND_API_KEY` + `MAIL_FROM` (jaise `no-reply@receipto.in`, domain Resend mein verify) secrets daalte hi mail Resend se jaata hai, Gmail sirf fallback. Dono na ho to pehle jaisa Gmail.

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

## Email apne Gmail se (send-email hook)

Signup, password reset aur baaki saare Auth mail `supabase/functions/send-email` se Gmail API ke through jaate hain. Ye bilkul Receipto wala tarika hai, isme SMTP ya App Password nahi lagta.

1. Supabase → Edge Functions → Secrets mein ye daalo. Values wahi hain jo Receipto ke Render env mein hain:
   - `GMAIL_CLIENT_ID`
   - `GMAIL_CLIENT_SECRET`
   - `GMAIL_REFRESH_TOKEN`
   - `GMAIL_SENDER`
2. Supabase → Authentication → Hooks → **Send Email** → HTTPS mein URL `https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/send-email` daalo.
3. **Generate secret** karke copy karo. Use Secrets mein `SEND_EMAIL_HOOK_SECRET` naam se daalo, phir hook ko Enable karke Save karo.
4. Authentication → Rate Limits mein "emails per hour" badha do.
5. Authentication → Sign In / Providers → Email mein **Confirm email** ON karo. Iske baad signup karne par 6 digit code mail pe jayega, aur bina code daale account nahi banega.

Welcome mail `supabase/functions/send-welcome` bhejta hai. Email confirm hone ke baad naya owner jab Setup page pe aata hai, tab ek hi baar mail jata hai (flag `app_metadata.welcome_sent` mein rehta hai). Iske liye bhi wahi GMAIL_* secrets use hote hain.

Agar refresh token kabhi badla, to use Render aur Supabase dono jagah update karna hoga.

## Mobile OTP login (SMSGate)

Login / signup page pe **Email / Mobile** switch hai. Mobile chuno → +91 ke baad 10 digit number → **OTP bhejo** → SMS mein aaya 6 digit code daalo. Naya number ho to account apne aap ban jata hai (phir Setup page), purana ho to seedha Dashboard. SMS `supabase/functions/send-sms` (Supabase ka "Send SMS" hook) ek spare Android phone se bhejta hai, jisme **SMS Gateway for Android (SMSGate)** app chal raha ho. Koi SMS company / DLT nahi, SIM ka apna SMS pack use hota hai. Sirf Indian mobile numbers (+91, 6-9 se shuru) pe SMS jata hai. Message: `PrintQR code: 123456. Do not share. किसी को न बताएं।` (52 akshar, ek SMS).

Ek baar ka setup (isi order mein; jab tak (c) aur (d) nahi hote, Mobile wala button "Mobile login abhi chalu nahi hai" ya "SMS nahi bhej paaye" dikhata hai, email / Google login waise hi chalte hain):

a. **SMSGate phone:** spare Android phone (SIM ke saath, SMS pack active) mein Play Store / GitHub se "SMS Gateway for Android" (docs.sms-gate.app) install karo → SMS permission do → **Cloud server** ON karo → **Start** (Start Service) dabao. App jo **username** aur **password** dikhata hai, wo copy kar lo. Phone ko charger aur internet pe rakho, aur app ke liye battery optimisation band kar do, warna OTP late aayega.
b. **Secrets:** `supabase secrets set SMSGATE_USERNAME=... SMSGATE_PASSWORD=... --project-ref asqgdgzxkdksoikmffmd` (ya Supabase → Edge Functions → Secrets). Apna SMSGate server ho to `SMSGATE_URL` bhi daal sakte ho (default `https://api.sms-gate.app/3rdparty/v1/messages`). `send-sms` function `main` pe push hote hi "Deploy Supabase Edge Functions" workflow se deploy ho jata hai.
c. **Phone provider:** Supabase → Authentication → Sign In / Providers → **Phone** → Enable karo (phone signup bhi allowed rakho). Agar dashboard SMS provider (Twilio waghera) chunne ko bole, to koi bhi chun lo; hook ON hone par SMS hamara hook hi bhejta hai. Yahin **SMS OTP Expiry** dikhe to use 300-600 second kar do (phone se SMS kabhi 1-2 minute late aata hai).
d. **Hook:** Supabase → Authentication → Hooks → **Send SMS** → HTTPS → URL `https://asqgdgzxkdksoikmffmd.supabase.co/functions/v1/send-sms` → **Generate secret** → copy karke Secrets mein `SEND_SMS_HOOK_SECRET` naam se daalo (poora `v1,whsec_...`) → hook Enable karke Save.
e. **Rate limits:** Supabase → Authentication → Rate Limits mein "SMS messages per hour" (default 30, poore project ke liye) apne SIM pack ke hisaab se rakho, jaise 50-100. Ek number pe naya code 60 second baad hi milta hai (app mein bhi 60 second ka timer hai). Bot check (Turnstile) mobile OTP pe bhi lagta hai.

Test: Mobile tab → apna number → OTP bhejo. SMS na aaye to Supabase → Edge Functions → `send-sms` → Logs dekho (number aadha chhupa hota hai, OTP kabhi log nahi hota) aur SMSGate app ka Messages tab. Fail hone par alert `ops_events` mein bhi jata hai (Health check workflow).

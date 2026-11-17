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
- Auto-delete: GitHub Actions har ghante `scripts/cleanup.mjs` chalata hai

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

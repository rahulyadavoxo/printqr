# PrintQR: file report, takedown and evidence SOP

What to do when a shop presses **Report file** on an order, or when anyone (police, a court, a government
agency, a rights holder, a person in the document) tells us about an uploaded file.

> This is an operating procedure, not legal advice. The law references below are the ones we follow as an
> intermediary in India; have a lawyer check them before relying on them in a real case.

## Who handles it

- **Owner / Grievance Officer:** Rahul Kumar, as named on the Privacy page (`/legal/privacy`, section
  "Grievance Officer") and the Contact page (`/legal/contact`). Reports, police requests and notices go to the
  grievance email shown there.
- Only an **admin** (a row in `public.admins`) can see file reports and act on them, in **Admin → Spam watch →
  File reports**.

## How the system behaves (v34)

1. The shop owner or staff opens the order on the dashboard, presses **Report file**, picks a reason and may
   add a short note.
2. `report_order_files()` creates a row in `public.file_reports` and puts the order **on hold**
   (`orders.hold = true`). At that moment:
   - the automatic cleanup (`cleanup_candidates()`) **skips** the order, so the files are **kept**;
   - the shop can no longer open, download, print or delete the files (storage policies and the
     `orders_hold_guard` trigger), and the dashboard hides them;
   - the customer cannot use **Print again** on that order.
3. The report row keeps the token, shop name, file names and storage paths, so the record survives even if
   the order or shop is removed later.
4. The hold ends only when an admin acts (both actions are written to `admin_log`):
   - **Nothing wrong** (`admin-action` → `report_dismiss`): the report is closed as *dismissed*; if there is no
     other open report on the order, the hold is removed and normal auto-delete applies again.
   - **Delete files** (`admin-action` → `report_delete_files`): the files are deleted from storage now, the
     order is marked *files deleted*, and every open report on it is closed as *files_deleted*.

## Time limits we work to

| Situation | Act within |
|---|---|
| New report from a shop | Look at it within **24 hours** |
| Complaint from a person that a file shows them nude / in a sexual act, or is a morphed image of them | Make it unavailable within **24 hours** (IT Rules 2021, rule 3(2)(b)). The hold already does this; confirm it. |
| Court order, or notice from the government / its authorised agency | Remove within **36 hours** (IT Rules 2021, rule 3(1)(d)) |
| Any other grievance | Acknowledge within **24 hours**, resolve within **15 days** (IT Rules 2021, rule 3(2)(a)) |
| Police / agency request for information | Within the time the request gives (IT Rules 2021, rule 3(1)(j): within 72 hours) |

## Step by step

### 1. Triage (admin)

Open **Admin → Spam watch → File reports**. Open reports are at the top. A report with the reason
**Child sexual abuse material** is marked in red: handle it first.

Read the reason, the note and the file names. **Do not download a file to look at it** unless you must to
decide, and never for a CSAM report (see step 3).

### 2. Not a problem (wrong report, normal document)

Press **Nothing wrong**. The order leaves hold and its files follow the shop's normal auto-delete time.

### 3. Child sexual abuse material (CSAM)

1. **Do not open, download, copy, forward or keep the file anywhere.** Possessing or sharing it is itself an
   offence (POCSO Act s.15, IT Act s.67B). The hold already keeps it safely in storage, hidden from everyone.
2. **Report it the same day** at <https://cybercrime.gov.in> (National Cyber Crime Reporting Portal,
   "Report child pornography / rape content") or to the local police / Special Juvenile Police Unit
   (POCSO Act s.19-20 and POCSO Rules 2020, rule 11). Helpline: **1930**. Give the order token, shop,
   time, file names and the storage folder shown in the report (`uploads/<shop>/<order>/`), not the file.
3. Note the complaint / acknowledgement number in a private record (not in the repo).
4. **Keep the files on hold.** Hand them over only through the police / agency's written request (export from
   Supabase → Storage → `uploads` by someone authorised, straight to the officer).
5. Keep them for at least **180 days** after the report, or longer if the police ask
   (IT Rules 2021, rule 3(1)(g)). After that, or when the police confirm they have what they need, press
   **Delete files**.

### 4. Other illegal content (fake documents, fraud, violence, terrorism)

1. Keep the order on hold.
2. If it points to a crime (for example forged ID cards, threats, terror material), report it at
   <https://cybercrime.gov.in> or to the local police, as above.
3. Preserve the evidence: the files stay in storage while on hold. If the police want a copy, give it only on
   their written request.
4. Keep for at least **180 days** (rule 3(1)(g)), then **Delete files**. If no crime is involved and no one
   asked to keep it, you may delete sooner.

### 5. Copyright or privacy

1. Copyright (for example a pirated book): the shop should not print it. If the rights holder sent a notice,
   reply to them, then **Delete files**.
2. Someone else's private documents or photos: contact the person if they complained, then **Delete files**
   within 24 hours for intimate images (rule 3(2)(b)) and within 15 days otherwise.

### 6. Requests from police, courts or government (no shop report)

1. Check the request is genuine (official email / letter, officer's name, case number).
2. If it names an order or shop, find the order in **Admin → Orders**. To keep its files, put it on hold by
   reporting it from that shop's dashboard, or run in the SQL editor:
   `update public.orders set hold = true where id = '<order id>';`
3. Give only what the request asks for, in writing. Write down what was shared, with whom and when (private
   record, not in the repo).

## Records

- `public.file_reports`: every report, its status and when / by whom it was closed.
- `public.admin_log`: every admin action (`file_report_dismissed`, `file_report_files_deleted`, `files_deleted`).
- Private notes (complaint numbers, police contacts) stay outside this public repository.

## What the shop is told

On the dashboard: the order shows "Reported: files are kept for review and hidden." The shop is told not to
print, save or share reported files, and, for CSAM, that it can also report at cybercrime.gov.in or 1930.

---

## Hinglish summary

- **Report file:** shop owner/staff dashboard pe order ka **Report file** dabata hai, reason chunta hai. Order
  turant **hold** pe chala jata hai: files auto-delete **nahi** hongi, shop unhe khol/print/delete nahi kar
  sakti, customer "Print again" nahi kar sakta.
- **Admin:** Admin → Spam watch → **File reports**. 24 ghante ke andar dekho. Red wala (CSAM) sabse pehle.
- **Kuch galat nahi:** **Nothing wrong** dabao. Hold hat jayega, files normal time pe delete hongi.
- **CSAM (bachchon ka sexual content):** file **mat kholo, mat download karo, kisi ko mat bhejo**. Usi din
  <https://cybercrime.gov.in> pe ya police ko report karo (helpline **1930**). Token, shop, time aur storage
  folder batao, file nahi. Files hold pe rakho, police likhit mein maange tabhi do. Kam se kam **180 din**
  rakho, phir **Delete files**.
- **Baaki illegal (fake document, fraud, hinsa):** hold pe rakho, zarurat ho to police/cybercrime pe report
  karo, 180 din rakho, phir delete.
- **Copyright / privacy:** notice ya complaint aaye to **Delete files**. Kisi ki nangi/morphed photo ki
  complaint ho to 24 ghante ke andar.
- **Police / court / sarkar ka order:** 36 ghante ke andar hatao. Request asli hai ya nahi check karo, sirf
  maanga hua data do, aur private record rakho (repo mein nahi).
- **Contact:** Grievance Officer Rahul Kumar (Privacy/Contact page pe email). Ye legal advice nahi hai,
  ek baar lawyer se check karwa lo.

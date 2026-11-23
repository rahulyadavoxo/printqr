import { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { TIER_PRICES } from '../lib/billing'
import { FILE_HOURS } from '../lib/plans'
import { SELLER_NAME } from '../lib/seller'

const UPDATED = '23 November 2026'
const OWNER = SELLER_NAME
const P = TIER_PRICES
/** Plan file-keeping caps in words (from FILE_HOURS: 3h / 24h / 168h). */
const hrs = (h: number) => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h} hour${h === 1 ? '' : 's'}`)
const ADDRESS = 'Abadganj, Mission School Road, Near Shiv Temple, Daltonganj, Jharkhand 822101, India'
const SUPPORT = 'receipto.support@gmail.com'
const GRIEVANCE = 'rahulkumaryadav7090@gmail.com'

const Mail = ({ to }: { to: string }) => <a href={`mailto:${to}`}>{to}</a>

type Doc = { title: string; body: ReactNode }

const DOCS: Record<string, Doc> = {
  privacy: {
    title: 'Privacy Policy',
    body: (
      <>
        <p>
          PrintQR (print.receipto.in), run by {OWNER} as part of Receipto ("we"), lets print and cyber cafe shops receive
          files from customers by QR code. This policy explains what we collect, why, and how long we keep it.
        </p>
        <h2>1. Who is responsible (DPDP Act, 2023)</h2>
        <ul>
          <li><b>Customer files and order details:</b> the shop you send them to decides why and how they are used, so the shop is the <b>Data Fiduciary</b>. PrintQR only stores and delivers them for the shop and is its <b>Data Processor</b>.</li>
          <li><b>Shop owner account data:</b> PrintQR is the Data Fiduciary for the details shop owners give us to run their account.</li>
        </ul>
        <h2>2. What we collect</h2>
        <ul>
          <li><b>Shop owners:</b> email address or mobile number, password (stored only as a one-way hash by our login provider), shop name, address, phone, UPI ID, print rates and settings, and the phone/browser push token if you turn on notifications.</li>
          <li><b>Customers:</b> the files you upload (PDFs and photos), the optional name and note you type, the print options you pick, and your order token and status. Customers do not need an account.</li>
          <li><b>Payments:</b> for paid plans, Razorpay processes the payment. We store the subscription ID, plan, status, dates, and for each payment its ID, amount and date (for your receipts). We never see or store card, UPI PIN or bank details.</li>
          <li><b>Technical data:</b> basic logs (time, browser, IP address) kept by our hosting providers for security, abuse prevention and to fix errors.</li>
        </ul>
        <h2>3. How long data is kept</h2>
        <ul>
          <li><b>Uploaded files</b> are deleted automatically after the shop's auto-delete time. The shop chooses it, from 1 hour up to its plan's limit: {hrs(FILE_HOURS.free)} on Free, {hrs(FILE_HOURS.pro)} on Pro and {hrs(FILE_HOURS.plus)} on Plus.</li>
          <li>Files of an order still <b>received or printing</b> are kept until at least 48 hours after it was placed (or the shop's time, if longer), so the shop can finish it.</li>
          <li>Files from uploads that were <b>never finished</b> are deleted after 35 minutes.</li>
          <li>After the files are deleted, the order shows as files removed; the token, name and amount stay in the shop's order history. <b>Order records</b> are deleted after 366 days.</li>
          <li><b>Backups:</b> the database (not the uploaded files) is backed up every night, encrypted, to Cloudflare R2.</li>
          <li><b>Shop owner accounts</b> are kept while the account is open; ask us to close it and we delete it.</li>
        </ul>
        <h2>4. Aadhaar and ID documents</h2>
        <p>
          Many customers print ID documents. Please upload a <b>masked Aadhaar</b> (only the last 4 digits shown,
          downloadable from the UIDAI website) wherever it is accepted. Shops must use ID files only to print them and
          must <b>not keep copies</b>, photos or scans of them. PrintQR deletes every uploaded file automatically as
          described above.
        </p>
        <h2>5. Who can see your files</h2>
        <p>
          Only the shop you sent them to, through its signed-in dashboard, and our automated cleanup job. We do not
          read, sell, share or use your files for any other purpose. Shops are responsible for how they handle
          printed copies.
        </p>
        <h2>6. Service providers (processors)</h2>
        <ul>
          <li>Supabase: database, login, file storage and server functions.</li>
          <li>GitHub Pages: hosting of this website.</li>
          <li>Razorpay: subscription payments for shops.</li>
          <li>Cloudflare: Turnstile (bot check on uploads and login) and R2 (encrypted database backups).</li>
          <li>Google: Firebase Cloud Messaging (order notifications to the shop's phone), Gmail API (account emails), Google Fonts (website fonts) and Google AdSense (ads may be shown on the Free plan).</li>
          <li>Resend: account emails, when it is set up.</li>
          <li>SMSGate (sms-gate.app): sends the one-time login code by SMS for mobile-number logins.</li>
        </ul>
        <h2>7. Cookies and ads</h2>
        <p>
          We use your browser's local storage to keep you signed in and remember your language. On Free-plan pages,
          Google and its partners may use cookies to show and measure ads, including ads based on your previous visits
          to this and other websites. You can turn off personalised ads at{' '}
          <a href="https://adssettings.google.com" target="_blank" rel="noreferrer">adssettings.google.com</a>, and
          learn more at{' '}
          <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noreferrer">policies.google.com/technologies/ads</a>.
        </p>
        <h2>8. Your rights</h2>
        <p>
          You can ask us to access, correct or delete your personal data, or close your shop account, by writing to{' '}
          <Mail to={SUPPORT} />. Customers can ask the shop to delete their files before the auto-delete time, or
          write to us and we will pass the request to the shop.
        </p>
        <h2>9. Security</h2>
        <p>
          Data is sent over HTTPS. Files are kept in private storage and opened only through short-lived links. No
          system is perfectly secure, so please do not upload documents you are not comfortable sharing with the shop.
        </p>
        <h2>10. Children</h2>
        <p>Users under 18 may use PrintQR only with the consent of a parent or guardian.</p>
        <h2>11. Changes</h2>
        <p>We may update this policy. The date at the top shows the latest version.</p>
        <h2>12. Grievance Officer (DPDP Act, 2023)</h2>
        <p>
          Name: {OWNER}
          <br />
          Email: <Mail to={GRIEVANCE} />
          <br />
          Address: {ADDRESS}
        </p>
      </>
    )
  },
  terms: {
    title: 'Terms and Conditions',
    body: (
      <>
        <p>
          These terms apply to your use of PrintQR (print.receipto.in), run by {OWNER} as part of Receipto. By using
          PrintQR you agree to them.
        </p>
        <h2>1. The service</h2>
        <p>
          PrintQR lets shops show a QR code so customers can upload files, see the price and get a token. PrintQR does
          not print anything itself. The printing, the final price charged at the counter and the quality of prints
          are the shop's responsibility.
        </p>
        <h2>2. Shop accounts</h2>
        <ul>
          <li>Users under 18 may use PrintQR only with the consent of a parent or guardian.</li>
          <li>You must give correct details and keep your password safe. You are responsible for activity on your account.</li>
          <li>You must handle customers' files only to print them, and not copy, keep or share them. This includes Aadhaar and other ID documents: do not keep copies of them.</li>
          <li>For your customers' files you are the Data Fiduciary under the DPDP Act, 2023; PrintQR processes them for you.</li>
          <li>Payments customers make to your UPI ID go directly to you. We are not part of that payment.</li>
        </ul>
        <h2>3. Customers</h2>
        <p>
          Upload only files you have the right to print. Do not upload illegal, harmful or copyrighted material you do
          not own. The price shown is an estimate from the shop's rates; the shop may confirm the final amount.
        </p>
        <h2>4. Plans and payments</h2>
        <ul>
          <li>The Free plan is free and may show ads and have limits.</li>
          <li>Pro costs ₹{P.pro.monthly} per month or ₹{P.pro.yearly} per year. Plus costs ₹{P.plus.monthly} per month or ₹{P.plus.yearly} per year. Plans are billed in advance through Razorpay as a subscription that renews automatically until cancelled.</li>
          <li>Moving from Pro to Plus stops the Pro subscription at once; the unused Pro days are added to Plus as extra days.</li>
          <li>The seller is {OWNER} (PrintQR). A receipt for every payment can be downloaded from the Plan tab.</li>
          <li>You can cancel any time from the Plan tab. The paid plan stays active until the end of the period already paid. Refunds follow our <Link to="/legal/refund">Refund and Cancellation Policy</Link>.</li>
          <li>We may change prices with notice; changes apply from your next billing period.</li>
        </ul>
        <h2>5. Acceptable use</h2>
        <p>
          Do not misuse the service, try to access other shops' data, overload it, or use it for anything unlawful.
          We may suspend accounts that break these terms.
        </p>
        <h2>6. Availability and liability</h2>
        <p>
          We try to keep PrintQR running but do not promise it will always be available or error free. To the extent
          the law allows, our total liability is limited to the amount you paid us in the 3 months before the claim.
          We are not liable for lost files, missed orders or business losses.
        </p>
        <h2>7. Governing law</h2>
        <p>These terms are governed by the laws of India. Courts in Daltonganj, Jharkhand have jurisdiction.</p>
        <h2>8. Contact</h2>
        <p>
          {OWNER}, {ADDRESS}. Email: <Mail to={SUPPORT} />
        </p>
      </>
    )
  },
  refund: {
    title: 'Refund and Cancellation Policy',
    body: (
      <>
        <p>
          This policy covers PrintQR Pro and Plus plan payments made to {OWNER} (PrintQR) through Razorpay. Pro costs
          ₹{P.pro.monthly} per month or ₹{P.pro.yearly} per year; Plus costs ₹{P.plus.monthly} per month or
          ₹{P.plus.yearly} per year.
        </p>
        <h2>1. Cancellation</h2>
        <p>
          You can cancel your Pro or Plus subscription any time from the Plan tab in your dashboard. No further charges
          will be made after cancellation. The plan's features stay active until the end of the period you already
          paid for. When you move from Pro to Plus, the unused Pro days are added to Plus instead of being refunded.
        </p>
        <h2>2. Refunds</h2>
        <ul>
          <li>If you were charged twice, or charged after you cancelled, we refund the extra charge in full.</li>
          <li>If the plan did not work for you because of a fault on our side and we could not fix it, write to us within 7 days of the payment for a full refund of that payment.</li>
          <li>Apart from these cases, payments for a period already started are not refundable.</li>
        </ul>
        <h2>3. How to ask</h2>
        <p>
          Email <Mail to={SUPPORT} /> from your shop's email address with your shop name and the Razorpay payment ID (shown on the receipt in the Plan tab).
          We reply within 2 working days.
        </p>
        <h2>4. Timeline</h2>
        <p>
          Approved refunds are sent back to the original payment method through Razorpay within 5 to 7 working days.
          Your bank may take a few more days to show it.
        </p>
        <h2>5. Prints at the shop</h2>
        <p>
          Money paid to a shop for printing goes directly to that shop. For refunds on prints, please contact the
          shop.
        </p>
      </>
    )
  },
  contact: {
    title: 'Contact Us',
    body: (
      <>
        <p>For help with PrintQR, payments, refunds or your data, reach us here:</p>
        <p>
          <b>{OWNER}</b> (PrintQR by Receipto)
          <br />
          {ADDRESS}
        </p>
        <p>
          Support email: <Mail to={SUPPORT} />
          <br />
          Grievance Officer: <Mail to={GRIEVANCE} />
        </p>
        <p>We usually reply within 2 working days. For a print order, please contact the shop directly.</p>
      </>
    )
  }
}

export function LegalLinks() {
  return (
    <nav className="legal-links no-print" aria-label="Policies">
      <Link to="/legal/privacy">Privacy</Link>
      <Link to="/legal/terms">Terms</Link>
      <Link to="/legal/refund">Refunds</Link>
      <Link to="/legal/contact">Contact</Link>
    </nav>
  )
}

export default function Legal() {
  const { doc = '' } = useParams()
  const d = DOCS[doc] || DOCS.privacy
  return (
    <div>
      <TopBar />
      <main className="page narrow legal">
        <div className="card">
          <h1>{d.title}</h1>
          {doc !== 'contact' && <p className="small muted">Last updated: {UPDATED}</p>}
          {d.body}
        </div>
        <LegalLinks />
      </main>
    </div>
  )
}

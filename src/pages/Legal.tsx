import { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TopBar } from '../components/TopBar'

const UPDATED = '17 November 2026'
const OWNER = 'Rahul Kumar'
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
        <h2>1. What we collect</h2>
        <ul>
          <li><b>Shop owners:</b> email address, password (stored only as a one-way hash by our login provider), shop name, address, phone, UPI ID, print rates and settings.</li>
          <li><b>Customers:</b> the files you upload (PDFs and photos), the optional name and note you type, the print options you pick, and your order token and status. Customers do not need an account.</li>
          <li><b>Payments:</b> for Pro plans, Razorpay processes the payment. We store only the subscription ID, plan, status and dates. We never see or store card, UPI PIN or bank details.</li>
          <li><b>Technical data:</b> basic logs (time, browser, IP address) kept by our hosting providers for security and to fix errors.</li>
        </ul>
        <h2>2. How long files are kept</h2>
        <p>
          Uploaded files are deleted automatically after the shop's auto-delete time, which is 24 hours by default and
          can be set by the shop between 1 hour and 7 days. Files from uploads that were never finished are deleted
          after about 1 hour. After deletion the order shows as files removed; the token, name and amount stay in the
          shop's order history.
        </p>
        <h2>3. Who can see your files</h2>
        <p>
          Only the shop you sent them to, through its signed-in dashboard, and our automated cleanup job. We do not
          read, sell, share or use your files for any other purpose. Shops are responsible for how they handle
          printed copies.
        </p>
        <h2>4. Service providers</h2>
        <ul>
          <li>Supabase: database, login and file storage.</li>
          <li>GitHub Pages: hosting of this website.</li>
          <li>Razorpay: subscription payments for shops.</li>
          <li>Google AdSense: ads shown to free-plan shops and their customers.</li>
          <li>Google Fonts: website fonts.</li>
        </ul>
        <h2>5. Cookies and ads</h2>
        <p>
          We use your browser's local storage to keep you signed in and remember your language. On free-plan pages,
          Google and its partners may use cookies to show and measure ads, including ads based on your previous visits
          to this and other websites. You can turn off personalised ads at{' '}
          <a href="https://adssettings.google.com" target="_blank" rel="noreferrer">adssettings.google.com</a>, and
          learn more at{' '}
          <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noreferrer">policies.google.com/technologies/ads</a>.
        </p>
        <h2>6. Your rights</h2>
        <p>
          You can ask us to access, correct or delete your personal data, or close your shop account, by writing to{' '}
          <Mail to={SUPPORT} />. Customers can also ask the shop to delete their files before the auto-delete time.
        </p>
        <h2>7. Security</h2>
        <p>
          Data is sent over HTTPS. Files are kept in private storage and opened only through short-lived links. No
          system is perfectly secure, so please do not upload documents you are not comfortable sharing with the shop.
        </p>
        <h2>8. Children</h2>
        <p>PrintQR is not meant for children under 18 to use without a parent or guardian.</p>
        <h2>9. Changes</h2>
        <p>We may update this policy. The date at the top shows the latest version.</p>
        <h2>10. Grievance Officer (DPDP Act, 2023)</h2>
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
          <li>You must give correct details and keep your password safe. You are responsible for activity on your account.</li>
          <li>You must handle customers' files only to print them, and not copy, keep or share them.</li>
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
          <li>Pro costs ₹49 per month or ₹539 per year, billed in advance through Razorpay as a subscription that renews automatically until cancelled.</li>
          <li>You can cancel any time from the Plan tab. Pro stays active until the end of the period already paid. Refunds follow our <Link to="/legal/refund">Refund and Cancellation Policy</Link>.</li>
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
        <p>This policy covers PrintQR Pro plan payments made to us through Razorpay.</p>
        <h2>1. Cancellation</h2>
        <p>
          You can cancel your Pro subscription any time from the Plan tab in your dashboard. No further charges will
          be made after cancellation. Pro features stay active until the end of the period you already paid for.
        </p>
        <h2>2. Refunds</h2>
        <ul>
          <li>If you were charged twice, or charged after you cancelled, we refund the extra charge in full.</li>
          <li>If Pro did not work for you because of a fault on our side and we could not fix it, write to us within 7 days of the payment for a full refund of that payment.</li>
          <li>Apart from these cases, payments for a period already started are not refundable.</li>
        </ul>
        <h2>3. How to ask</h2>
        <p>
          Email <Mail to={SUPPORT} /> from your shop's email address with your shop name and the Razorpay payment ID.
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

import type {ReactNode} from 'react'
import {ArrowUpRight, BookOpen} from 'lucide-react'
import {Link} from 'react-router-dom'
import {APP_EDITION} from '@/lib/edition'

const APP_URL = 'https://main.d35ht8wka9lmbz.amplifyapp.com/'
const DEMO_URL = 'https://main.d23gra1a9ugqjs.amplifyapp.com'

function DemoLink({to, children}: {to: string; children: ReactNode}) {
  const className = 'inline-flex min-h-11 items-center gap-2 font-semibold text-blue hover:underline'
  return APP_EDITION ? <a href={`${DEMO_URL}${to}`} target="_blank" rel="noreferrer" className={className}>{children}<ArrowUpRight className="size-4" /></a> : <Link to={to} className={className}>{children}<ArrowUpRight className="size-4" /></Link>
}

function Steps({items}: {items: Array<{title: string; body: ReactNode}>}) {
  return <ol className="divide-y divide-ink/15">{items.map((item, index) => <li key={item.title} className="flex gap-4 py-6 sm:gap-6">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-ink text-[13px] font-semibold text-white" aria-hidden>{index + 1}</span>
    <div className="min-w-0"><h3 className="text-[16px] font-semibold">{item.title}</h3><div className="mt-2 max-w-[65ch] space-y-3 text-[14px] leading-relaxed text-ink-2">{item.body}</div></div>
  </li>)}</ol>
}

export function TutorialPage() {
  return <div className="space-y-10">
    <header>
      <h1 className="display max-w-[18ch] text-[36px] sm:text-[52px]">Your first trade, step by step.</h1>
      <p className="mt-5 max-w-[65ch] text-[15px] leading-relaxed text-ink-2">Explore the public showcase without signing in. Then create a test account to rehearse your own paper deal. Paper deals move no funds; identity checks are mocked.</p>
      <nav aria-label="Tutorial sections" className="mt-6 flex flex-wrap gap-3">
        <a href="#explore" className="inline-flex min-h-11 items-center rounded-[9px] bg-ink px-4 text-[13px] font-semibold text-white hover:bg-ink-2">Explore the demo</a>
        <a href="#account-setup" className="inline-flex min-h-11 items-center rounded-[9px] border border-ink/20 bg-white px-4 text-[13px] font-semibold hover:bg-blue-wash">Create a test account</a>
      </nav>
    </header>

    <section id="explore" aria-labelledby="explore-title" className="scroll-mt-20">
      <h2 id="explore-title" className="display text-[24px]">Explore before you sign in</h2>
      <p className="mt-3 text-[14px] text-ink-2">Use the public demo for this walkthrough. Its companies and deals are fictional.</p>
      <Steps items={[
        {title: 'Check the company record', body: <><p>Open Companies. Choose Highland Estates Coffee. Review its completed deals, disputes, and provisional reliability score.</p><DemoLink to="/companies">Browse companies</DemoLink></>},
        {title: 'Ask Trust Check', body: <><p>Open Chat, choose Trust Check, and send <code className="break-words rounded bg-white px-1.5 py-1">company: highland-estates</code>. This fill-in format works without an AI answer.</p><DemoLink to="/ask?coworker=trust-check&prompt=company%3A+highland-estates">Try the company check</DemoLink></>},
        {title: 'Preview a deal', body: <><p>Open Deal Desk. Keep the coffee example and continue through the steps. Select <strong>Draft with the engine</strong>. Review the payouts, deadlines, and remedy. This previews terms; it does not create or fund a deal.</p><DemoLink to="/deal-desk">Open Deal Desk</DemoLink></>},
        {title: 'Inspect settlement and payment evidence', body: <><p>Return to Deals. Open a <strong>Settled</strong> paper deal to inspect its terms and record. Then open the payment checker and load the Masumi example.</p><p>The example is a separate 1 test USDM preprod payment. Check its recipient, amount, and observation time. Use the transaction explorer to compare it independently. The checker uses a CRE simulation; it has no DON signature.</p><a href="https://13.210.42.0/evidence" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue hover:underline">Open the payment checker<ArrowUpRight className="size-4" /></a></>},
      ]} />
    </section>

    <section id="account-setup" aria-labelledby="account-setup-title" className="scroll-mt-20">
      <div className="surface-ink rounded-[16px] p-6 text-white sm:p-8">
        <BookOpen className="size-6 text-yellow" aria-hidden />
        <h2 id="account-setup-title" className="display mt-4 text-[24px]">Create your test account</h2>
        <p className="mt-3 max-w-[65ch] text-[14px] leading-relaxed text-white/80">The signed-in app is a separate website. It uses your wallet to identify your account. Follow these steps in your own browser.</p>
        {APP_EDITION ? <Link to="/account" className="mt-5 inline-flex min-h-11 items-center gap-3 rounded-[9px] bg-yellow px-4 text-[13px] font-semibold text-ink hover:bg-yellow-wash">Open Account<ArrowUpRight className="size-4" /></Link> : <a href={APP_URL} target="_blank" rel="noreferrer" className="mt-5 inline-flex min-h-11 items-center gap-3 rounded-[9px] bg-yellow px-4 text-[13px] font-semibold text-ink hover:bg-yellow-wash">Open the signed-in app in a new tab<ArrowUpRight className="size-4" /></a>}
      </div>
      <Steps items={[
        {title: 'Open Account and name your business', body: <><p>On the signed-in app homepage, select <strong>Go to Account</strong>. Enter <strong>Demo Buyer Ltd</strong> under Name. Select <strong>Business</strong>.</p><p>Starting from the homepage also works if a direct Account link fails.</p></>},
        {title: 'Create a test wallet', body: <><p>Select <strong>Create a wallet in this browser</strong>. Save the 24-word recovery phrase privately, in order. Do not paste it into chat or show it during the presentation.</p><p>Tick <strong>I wrote down my recovery phrase</strong>. Set a device password with at least eight characters. Select <strong>Create my account</strong>.</p><p>If you already have a separate preprod test wallet, connect that wallet instead.</p></>},
        {title: 'Pass the mock identity check', body: <><p>After sign-in, find <strong>Identity (KYC)</strong>. Use these fictional values:</p><dl className="grid gap-3 rounded-[12px] bg-white p-4 sm:grid-cols-2"><div><dt className="text-[12px]">Company registration number</dt><dd className="mt-1 break-all font-mono text-[12px] text-ink">REG-DEMO-BUYER-001</dd></div><div><dt className="text-[12px]">Beneficial owner document</dt><dd className="mt-1 break-all font-mono text-[12px] text-ink">DOC-DEMO-BUYER-001</dd></div></dl><p>Select <strong>Verify</strong>. Look for <strong>KYC passed</strong>. This is a mock check, so no real identity document is needed.</p></>},
        {title: 'Enable deal signing', body: <><p>Find <strong>Set up deal signing</strong>. Enter your device wallet password and select <strong>Set up deal signing</strong>. Look for <strong>Deal key registered</strong>.</p><p>Keep using the same wallet for this account. Paper deals need no deposit. Live preprod deals require confirmed test funds.</p></>},
        {title: 'Prepare the other party', body: <><p>Use a separate browser profile for the seller. Repeat account setup as <strong>Demo Seller Ltd</strong>, with its own wallet. Use <code className="break-all">REG-DEMO-SELLER-001</code> and <code className="break-all">DOC-DEMO-SELLER-001</code> for mock KYC. Enable its deal signing too.</p><p>Keep the buyer and seller in separate browser profiles so their accounts stay signed in.</p></>},
        {title: 'Create and sign your first paper deal', body: <><p>Return to the buyer profile. Open <strong>New deal</strong>. Choose a template. Search for Demo Seller Ltd and select it. Fill the milestone title, amount, and required deliverable fields.</p><p>Select <strong>Preview payouts, timeline, and fees</strong>. Review the preview. Select <strong>Create deal</strong>, then submit it for acceptance on the deal page.</p><p>In the seller profile, open the deal and accept it. Each party signs the frozen terms. Follow <strong>Your next action</strong> to submit the required evidence and inspect delivery. Check that the deal is labelled <strong>Paper</strong> before the rehearsal.</p></>},
      ]} />
      <details className="border-t border-ink/15 py-5 text-[14px]">
        <summary className="cursor-pointer font-semibold">Need help signing in again?</summary>
        <div className="mt-3 max-w-[65ch] space-y-3 leading-relaxed text-ink-2"><p>On Account, choose <strong>Use this device’s wallet</strong> and enter the device password. If the wallet is not saved in this browser, choose <strong>Restore from a recovery phrase</strong> and use your original 24 words.</p><p>If registration reports a connection error, keep your saved phrase and retry with the same wallet when the service is available. Do not create another wallet for each retry.</p></div>
      </details>
    </section>
  </div>
}

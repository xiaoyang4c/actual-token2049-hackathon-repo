import {useMemo, useState, type ReactNode} from 'react'
import {Link, NavLink} from 'react-router-dom'
import {BookOpen, Bot, Building2, FilePenLine, Gavel, LayoutList, Menu, MessageSquareText, TableProperties, Wallet} from 'lucide-react'
import {Brand, useLens} from '@/components/kit'
import Waves from '@/components/reactbits/Waves'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {Sheet, SheetContent, SheetTitle, SheetTrigger} from '@/components/ui/sheet'
import {APP_EDITION} from '@/lib/edition'
import {useAppSession} from '@/lib/app-session'
import {api, type Party} from '@/lib/api'
import {useAsync} from '@/lib/useAsync'
import {cn} from '@/lib/utils'

const DEMO_NAV = [
  {to: '/', label: 'Deals', icon: LayoutList, end: true},
  {to: '/mediation', label: 'Mediation', icon: Gavel},
  {to: '/companies', label: 'Companies', icon: Building2},
  {to: '/deal-desk', label: 'Deal Desk', icon: FilePenLine},
  {to: '/ask', label: 'Chat', icon: MessageSquareText},
  {to: '/tutorial', label: 'Tutorial', icon: BookOpen},
  {to: '/coworkers', label: 'Coworkers', icon: Bot},
  {to: '/operator', label: 'Operator', icon: TableProperties},
  {to: '/account', label: 'Account', icon: Wallet},
]

const NAV = APP_EDITION ? [
  {to: '/', label: 'My deals', icon: LayoutList, end: true},
  {to: '/deals/new', label: 'New deal', icon: FilePenLine},
  ...DEMO_NAV.filter(({to}) => !['/', '/mediation', '/operator'].includes(to)),
] : DEMO_NAV

function SignedIn() {
  const {session, me, signOut} = useAppSession()
  return <div className="space-y-2 px-1 text-[13px]">
    <p className="text-ink-2">{session ? `Signed in as ${me?.displayName ?? 'your wallet account'}` : 'Sign in to see your deals'}</p>
    {session ? <button type="button" onClick={() => void signOut()} className="font-medium text-ink underline underline-offset-4">Sign out</button> : <Link to="/account" className="font-medium underline underline-offset-4">Go to Account</Link>}
  </div>
}

function Nav({onNavigate}: {onNavigate?: () => void}) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV.map(({to, label, icon: Icon, end}) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({isActive}) => cn(
            'group relative flex h-10 items-center gap-3 rounded-[9px] px-3 text-[14px] font-medium transition-colors',
            isActive ? 'bg-white text-ink shadow-[0_1px_2px_rgb(11_14_15/0.06),0_0_0_1px_rgb(11_14_15/0.06)]' : 'text-ink-3 hover:bg-white/60 hover:text-ink',
          )}
        >
          {({isActive}) => (
            <>
              <span className={cn('absolute -left-3 h-5 w-[3px] rounded-r-[2px] transition-colors', isActive ? 'bg-yellow' : 'bg-transparent')} aria-hidden />
              <Icon className="size-[17px]" strokeWidth={1.8} />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

function LensPicker() {
  const {lens, setLens} = useLens()
  const contracts = useAsync(() => api.contracts(), 'contracts-all')
  const parties = useMemo(() => {
    const seen = new Map<string, Party>()
    for (const c of contracts.data ?? []) for (const p of [c.buyer, c.seller]) seen.set(p.id, p)
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [contracts.data])
  const items = [{value: 'all', label: 'All parties'}, ...parties.map((p) => ({value: p.id, label: p.displayName}))]
  return (
    <div>
      <p className="eyebrow mb-2 px-1">Viewing as</p>
      <Select items={items} value={lens} onValueChange={(v) => setLens(String(v ?? 'all'))}>
        <SelectTrigger className="h-10 w-full rounded-[9px] bg-white text-[13.5px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className="mt-2 px-1 text-[11.5px] leading-snug text-ink-3">A lens on the data, not a sign-in.</p>
    </div>
  )
}

function Environment() {
  return (
    <div className="surface-quiet rounded-[10px] p-3 text-[12px] leading-snug text-ink-3">
      <p className="flex items-center gap-2 font-medium text-ink-2"><span className="size-1.5 rounded-[1px] bg-blue" aria-hidden />Cardano preprod</p>
      <p className="mt-1">{APP_EDITION ? 'Preprod test funds only. Deals use test USDM. KYC is mocked.' : 'Paper contracts on test USDM. Scores and fees use placeholder policies. KYC is mocked.'}</p>
    </div>
  )
}

export function Shell({children}: {children: ReactNode}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-white/60 bg-white/35 px-5 py-6 backdrop-blur-xl lg:flex">
        <Link to="/" aria-label="Tally home"><Brand /></Link>
        <Nav />
        {APP_EDITION ? <SignedIn /> : <LensPicker />}
        <div className="mt-auto"><Environment /></div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-black/[0.06] bg-white/70 px-4 backdrop-blur-xl lg:hidden">
        <Link to="/" aria-label="Tally home"><Brand /></Link>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<button type="button" aria-label="Menu" className="flex size-10 items-center justify-center rounded-[9px] hover:bg-black/[0.05]" />}>
            <Menu className="size-5" />
          </SheetTrigger>
          <SheetContent side="left" className="w-[280px] gap-8 bg-gradient-to-b from-white to-[#e4e5e7] p-5">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Brand />
            <Nav onNavigate={() => setOpen(false)} />
            {APP_EDITION ? <SignedIn /> : <LensPicker />}
            <div className="mt-auto"><Environment /></div>
          </SheetContent>
        </Sheet>
      </header>

      <main className="relative min-w-0 px-4 pb-24 pt-8 sm:px-8 lg:px-12 lg:pt-12">
        {/* Line waves across the top of every page; they bend toward the cursor. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[440px] overflow-hidden [mask-image:linear-gradient(180deg,black_35%,transparent_100%)]">
          <Waves lineColor="rgba(11, 14, 15, 0.12)" backgroundColor="transparent" waveSpeedX={0.012} waveSpeedY={0.006} waveAmpX={36} waveAmpY={18} xGap={14} yGap={38} />
        </div>
        <div className="relative mx-auto max-w-[1180px]">{children}</div>
      </main>
    </div>
  )
}

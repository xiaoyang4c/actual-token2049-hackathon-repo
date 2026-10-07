import {useCallback, useEffect, useState, type ReactNode} from 'react'
import {Check, Circle, Copy, ExternalLink, KeyRound, Loader2, LogOut, Plug, Plus, ShieldCheck, Wallet} from 'lucide-react'
import {toast} from 'sonner'
import {APP_EDITION} from '@/lib/edition'
import {useAppSession} from '@/lib/app-session'
import {deals} from '@/lib/deals'
import {DealSigning} from '@/components/DealSigning'
import {Reveal} from '@/components/motion'
import {ErrorNote, Hash, PageHeader, Section, Tag} from '@/components/kit'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import {
  connect, deposit, fromAtomic, readAccount, savedSession, signInWithExtension, signInWithPhrase, signOut, submitKyc, toAtomic,
  AccountApiError, type AccountView, type Profile, type Session,
} from '@/lib/account'
import {isRecoveryPhrase, newRecoveryPhrase, normalizePhrase, walletFromPhrase} from '@/lib/cardano-keys'
import {addressToBech32, installedWallets, sharesStakeKey, type InstalledWallet} from '@/lib/cip30'
import {deviceWallet, forgetDeviceWallet, receiveAddressFor, saveDeviceWallet, unlockDeviceWallet} from '@/lib/device-wallet'
import {cn} from '@/lib/utils'

const USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'
const ASSETS = [{unit: USDM, label: 'test USDM'}, {unit: 'lovelace', label: 'test ADA'}]
const BUTTON = 'inline-flex h-10 items-center justify-center gap-2 rounded-[9px] px-4 text-[13.5px] font-semibold transition-colors disabled:opacity-40'
const PRIMARY = `${BUTTON} bg-ink text-white hover:bg-ink-2`
const SECONDARY = `${BUTTON} border border-border bg-white text-ink-2 hover:text-ink`

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function Field({label, children, hint}: {label: string; children: ReactNode; hint?: ReactNode}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] font-medium text-ink-2">{label}</Label>
      {children}
      {hint ? <p className="text-[11.5px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

function Choice<T extends string>({value, options, onChange}: {value: T; options: Array<{value: T; label: string}>; onChange: (value: T) => void}) {
  return (
    <div className="inline-flex rounded-[9px] border border-border bg-white p-0.5" role="radiogroup">
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
          className={cn('h-8 rounded-[7px] px-3 text-[12.5px] font-medium', value === option.value ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink')}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A whole address with a copy button. It is never shortened, so a selected or copied address is always valid. */
function ReceiveAddress({address}: {address: string}) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-start gap-1.5 rounded-[8px] bg-black/[0.035] px-2.5 py-1.5">
      <span className="mono min-w-0 select-all break-all text-[12px] text-ink">{address}</span>
      <button type="button" aria-label="Copy receive address" className="shrink-0 rounded-[4px] p-0.5 text-ink-3 transition-colors hover:bg-black/[0.05] hover:text-ink"
        onClick={() => { void navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
        {copied ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
}

/**
 * The receive address (addr_test1…) of the signed-in wallet. Sign-in uses the
 * stake address, which cannot receive funds. A browser wallet reads the address
 * from this device. A wallet extension gives its change address on request.
 */
function ReceiveFunds({session, account}: {session: Session; account: AccountView}) {
  const [fromExtension, setFromExtension] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const extension = session.via.startsWith('cip30:') ? session.via.slice('cip30:'.length) : null
  const stakeAddresses = account.wallets.filter((wallet) => wallet.credentialKind === 'stake').map((wallet) => wallet.address)
  const onThisDevice = stakeAddresses.map((stake) => receiveAddressFor(stake)).find((address) => address !== null) ?? null
  // A wallet without a stake address signs in with a payment address, which can receive funds.
  const provenPayment = account.wallets.find((wallet) => wallet.credentialKind === 'payment')?.address ?? null
  const address = fromExtension ?? onThisDevice ?? provenPayment

  const ask = async () => {
    if (!extension) return
    setBusy(true); setError(null)
    try {
      const change = addressToBech32(await (await connect(extension)).getChangeAddress())
      if (!stakeAddresses.some((stake) => sharesStakeKey(change, stake)) && !account.wallets.some((wallet) => wallet.address === change)) {
        throw new Error('The wallet extension shows another wallet. Switch it to the wallet that you signed in with, then try again.')
      }
      setFromExtension(change)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 text-[13px] text-ink-2">
      {address ? (
        <>
          <p>Send test ADA or test USDM to this address from a wallet set to Preprod. The funds go to your own wallet. Tally does not hold them.</p>
          <ReceiveAddress address={address} />
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
            <a className="underline" href={`https://preprod.cardanoscan.io/address/${address}`} target="_blank" rel="noreferrer">See the balance on Cardanoscan <ExternalLink className="inline size-3" /></a>
            <a className="underline" href="https://dispenser.masumi.network" target="_blank" rel="noreferrer">Get test funds from the Masumi dispenser <ExternalLink className="inline size-3" /></a>
          </p>
        </>
      ) : extension ? (
        <>
          <p>Your wallet extension holds the receive address. Tally asks the wallet for it. This moves no funds.</p>
          <button type="button" className={SECONDARY} disabled={busy} onClick={ask}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}Show my receive address
          </button>
        </>
      ) : (
        <p>This browser has no copy of your wallet. Sign out, then select Restore from a recovery phrase to show the receive address here. You can also open the Receive screen of a wallet app with the same phrase, set to Preprod.</p>
      )}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  )
}

function Step({done, title, children}: {done: boolean; title: string; children?: ReactNode}) {
  return (
    <li className="flex gap-3">
      {done ? <Check className="mt-0.5 size-[18px] shrink-0 rounded-full bg-up p-0.5 text-white" /> : <Circle className="mt-0.5 size-[18px] shrink-0 text-ink-3" />}
      <div>
        <p className={cn('text-[14px] font-medium', done ? 'text-ink' : 'text-ink-2')}>{title}</p>
        {children ? <p className="mt-0.5 text-[12.5px] text-ink-3">{children}</p> : null}
      </div>
    </li>
  )
}

/** Wallet extensions, a new browser wallet, or this device's wallet. Also adds a wallet to a signed-in account. */
function WalletChoices({session, onSignedIn, profile}: {session: Session | null; onSignedIn: (session: Session, account: AccountView) => void; profile: Profile}) {
  const [wallets] = useState<InstalledWallet[]>(() => installedWallets())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'none' | 'create' | 'restore' | 'unlock'>('none')
  const [phrase, setPhrase] = useState('')
  const [saved, setSaved] = useState(false)
  const [password, setPassword] = useState('')
  const device = deviceWallet()

  const run = async (label: string, work: () => Promise<{session: Session; account: AccountView}>) => {
    setBusy(label); setError(null)
    try {
      const result = await work()
      onSignedIn(result.session, result.account)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  const usePhrase = () => run('phrase', async () => {
    const clean = normalizePhrase(phrase)
    if (!isRecoveryPhrase(clean)) throw new Error('That is not a valid 24-word recovery phrase.')
    if (password.length < 8) throw new Error('Use a password of at least 8 characters to protect the wallet on this device.')
    const wallet = walletFromPhrase(clean)
    await saveDeviceWallet(clean, password, {address: wallet.address, rewardAddress: wallet.rewardAddress})
    return signInWithPhrase(clean, profile, session)
  })

  const unlock = () => run('unlock', async () => {
    const stored = await unlockDeviceWallet(password)
    if (!stored) throw new Error('Wrong password for the wallet on this device.')
    return signInWithPhrase(stored, profile, session)
  })

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2.5 text-[13px] font-semibold">Use a wallet you have</p>
        {wallets.length ? (
          <div className="flex flex-wrap gap-2">
            {wallets.map((wallet) => (
              <button key={wallet.id} type="button" disabled={busy !== null} className={SECONDARY}
                onClick={() => run(wallet.id, () => signInWithExtension(wallet.id, profile, session))}>
                {busy === wallet.id ? <Loader2 className="size-4 animate-spin" /> : wallet.icon ? <img src={wallet.icon} alt="" className="size-4" /> : <Plug className="size-4" />}
                {wallet.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-3">No Cardano wallet extension found in this browser. Install <a className="underline" href="https://www.lace.io" target="_blank" rel="noreferrer">Lace</a> or <a className="underline" href="https://eternl.io" target="_blank" rel="noreferrer">Eternl</a> and set it to Preprod, or create a wallet below.</p>
        )}
        <p className="mt-2 text-[11.5px] text-ink-3">Your wallet signs a one-time message. Signing moves no funds.</p>
      </div>

      <div className="border-t border-border pt-5">
        <p className="mb-2.5 text-[13px] font-semibold">No wallet yet?</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={SECONDARY} onClick={() => { setMode('create'); setPhrase(newRecoveryPhrase()); setSaved(false); setPassword('') }}>
            <Plus className="size-4" />Create a wallet in this browser
          </button>
          <button type="button" className={SECONDARY} onClick={() => { setMode('restore'); setPhrase(''); setPassword('') }}>
            <KeyRound className="size-4" />Restore from a recovery phrase
          </button>
          {device ? (
            <button type="button" className={SECONDARY} onClick={() => { setMode('unlock'); setPassword('') }}>
              <Wallet className="size-4" />Use this device's wallet
            </button>
          ) : null}
        </div>
      </div>

      {mode === 'create' ? (
        <div className="space-y-4 rounded-[12px] border border-border bg-white p-4">
          <p className="text-[13px] text-ink-2"><span className="font-semibold text-ink">Write these 24 words down, in order.</span> They are the only way to recover this wallet. Tally never sees them and cannot recover them. Any Cardano wallet (Lace, Eternl) can restore them.</p>
          <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-[10px] bg-black/[0.035] p-4 sm:grid-cols-4">
            {phrase.split(' ').map((word, index) => (
              <li key={index} className="mono flex gap-2 text-[12.5px]"><span className="w-5 text-right text-ink-3">{index + 1}</span>{word}</li>
            ))}
          </ol>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I wrote down my recovery phrase.</label>
          <Field label="Password for this device" hint="Encrypts the phrase in this browser so you can sign deposits. It is not sent to Tally.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="h-10 bg-white" />
          </Field>
          <button type="button" className={PRIMARY} disabled={!saved || password.length < 8 || busy !== null} onClick={usePhrase}>
            {busy === 'phrase' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{session ? 'Add this wallet' : 'Create my account'}
          </button>
        </div>
      ) : null}

      {mode === 'restore' ? (
        <div className="space-y-4 rounded-[12px] border border-border bg-white p-4">
          <Field label="Recovery phrase (24 words)">
            <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)} rows={3} autoComplete="off" spellCheck={false}
              className="mono w-full rounded-lg border border-input bg-white px-2.5 py-2 text-[13px] outline-none focus-visible:border-ring" />
          </Field>
          <Field label="Password for this device" hint="At least 8 characters. It is not sent to Tally.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="h-10 bg-white" />
          </Field>
          <button type="button" className={PRIMARY} disabled={!phrase.trim() || busy !== null} onClick={usePhrase}>
            {busy === 'phrase' ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}Restore and sign in
          </button>
        </div>
      ) : null}

      {mode === 'unlock' && device ? (
        <div className="space-y-4 rounded-[12px] border border-border bg-white p-4">
          <p className="text-[13px] text-ink-2">Wallet on this device: <Hash value={device.address} n={10} /></p>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="h-10 bg-white" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} disabled={!password || busy !== null} onClick={unlock}>
              {busy === 'unlock' ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}Unlock and sign in
            </button>
            <button type="button" className={SECONDARY} onClick={() => { forgetDeviceWallet(); setMode('none') }}>Remove from this device</button>
          </div>
        </div>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  )
}

function KycForm({session, account, onChange}: {session: Session; account: AccountView; onChange: (account: AccountView) => void}) {
  const [kind, setKind] = useState<'person' | 'business'>(account.entity.kind ?? 'person')
  const [documentId, setDocumentId] = useState('')
  const [addressChecked, setAddressChecked] = useState(false)
  const [registrationNumber, setRegistrationNumber] = useState('')
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fixedKind = account.entity.kind !== null

  const send = async () => {
    setBusy(true); setError(null)
    try {
      onChange(await submitKyc(session, kind === 'person' ?
        {kind, documentId, addressChecked} :
        {kind, registrationNumber, ...(owner ? {beneficialOwnerDocumentId: owner} : {})}))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={account.kyc.countsAsVerified ? 'up' : account.kyc.badge === 'rejected' ? 'down' : 'warn'}>{account.kyc.badge}</Tag>
        <span className="text-[13px] text-ink-2">Tier {account.kyc.tier}</span>
        <Tag tone="quiet">mock check</Tag>
      </div>
      {!fixedKind ? <Choice value={kind} onChange={setKind} options={[{value: 'person', label: 'Person'}, {value: 'business', label: 'Business'}]} /> : null}
      {kind === 'person' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Identity document number" hint="Mock check. An id that starts with DOC-REJECT is rejected.">
            <Input value={documentId} onChange={(e) => setDocumentId(e.target.value)} className="h-10 bg-white" />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><input type="checkbox" checked={addressChecked} onChange={(e) => setAddressChecked(e.target.checked)} />Proof of address checked (tier enhanced)</label>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company registration number" hint="Mock check. REG-REJECT is rejected.">
            <Input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} className="h-10 bg-white" />
          </Field>
          <Field label="Beneficial owner document (optional)" hint="Adds tier enhanced.">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} className="h-10 bg-white" />
          </Field>
        </div>
      )}
      <button type="button" className={PRIMARY} disabled={busy || (kind === 'person' ? !documentId.trim() : !registrationNumber.trim())} onClick={send}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{account.kyc.countsAsVerified ? 'Check again' : 'Verify'}
      </button>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  )
}

const STATUS: Record<string, {label: string; tone: 'up' | 'warn' | 'down' | 'quiet'}> = {
  confirmed: {label: 'Credited', tone: 'up'},
  pending: {label: 'Confirming', tone: 'warn'},
  unattributed: {label: 'Needs review', tone: 'down'},
  rolled_back: {label: 'Rolled back', tone: 'quiet'},
}

function Deposits({session, account, refresh}: {session: Session; account: AccountView; refresh: () => void}) {
  const view = account.deposits
  const [unit, setUnit] = useState(USDM)
  const [amount, setAmount] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = session.via === 'browser'
  const label = (u: string) => ASSETS.find((asset) => asset.unit === u)?.label ?? u

  const send = async () => {
    setBusy(true); setError(null)
    try {
      const quantity = toAtomic(amount, 6)
      if (!quantity) throw new Error('Write a positive amount with at most 6 decimals.')
      let signer: Parameters<typeof deposit>[2]
      if (browser) {
        const phrase = await unlockDeviceWallet(password)
        if (!phrase) throw new Error('Wrong password for the wallet on this device.')
        signer = {kind: 'browser', wallet: walletFromPhrase(phrase)}
      } else {
        signer = {kind: 'cip30', api: await connect(session.via.replace(/^cip30:/, ''))}
      }
      const sent = await deposit(session, [{unit, quantity}], signer)
      toast.success('Deposit sent', {description: `Transaction ${sent.txHash.slice(0, 12)}…. It is credited after ${view.confirmations} confirmations.`})
      setAmount(''); setPassword('')
      refresh()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  if (!view.enabled || !view.depositAddress) {
    return <p className="text-[13.5px] text-ink-3">Live deposits are not set up on this server yet. An operator sets the deposit address and the Blockfrost key.</p>
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <Tag tone="blue">live</Tag>Real Cardano preprod transactions with test assets. Credited after {view.confirmations} confirmations.
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(view.balances.length ? view.balances : ASSETS.map((asset) => ({unit: asset.unit, label: asset.label, decimals: 6, quantity: '0'}))).map((balance) => (
          <div key={balance.unit} className="rounded-[12px] border border-border bg-white px-4 py-3">
            <p className="eyebrow">{balance.label}</p>
            <p className="display mt-1.5 text-[24px]">{fromAtomic(balance.quantity, balance.decimals)}</p>
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-[12px] border border-border bg-white p-4">
        <p className="text-[13px] font-semibold">Send from your wallet</p>
        <div className="flex flex-wrap items-end gap-3">
          <Choice value={unit} onChange={setUnit} options={ASSETS.map((asset) => ({value: asset.unit, label: asset.label}))} />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount" className="h-10 w-36 bg-white" aria-label="Amount" />
          {browser ? <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Device password" className="h-10 w-44 bg-white" aria-label="Device password" /> : null}
          <button type="button" className={PRIMARY} disabled={busy || !amount || (browser && !password)} onClick={send}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}Deposit
          </button>
        </div>
        <p className="text-[11.5px] text-ink-3">Tally builds the transaction. Your wallet signs it in this browser. Tally never holds your keys.</p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
      <div className="text-[12.5px] text-ink-3">
        <p>Or send test USDM or test ADA from any wallet app to the Tally deposit address. Send from a wallet that you signed in with, so Tally can credit it to you.</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-2"><span className="text-ink-2">Deposit address</span><Hash value={view.depositAddress} n={14} /></p>
        <p className="mt-1.5">Need test funds? Use the <a className="underline" href="https://dispenser.masumi.network" target="_blank" rel="noreferrer">Masumi dispenser <ExternalLink className="inline size-3" /></a> with your receive address (<span className="mono">addr_test1…</span>), not the <span className="mono">stake_test1</span> address.</p>
      </div>
      {view.deposits.length || view.submissions.length ? (
        <ul className="divide-y divide-border rounded-[12px] border border-border bg-white">
          {view.deposits.map((row) => (
            <li key={`${row.txHash}:${row.outputIndex}:${row.unit}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <Tag tone={STATUS[row.status]?.tone ?? 'quiet'}>{STATUS[row.status]?.label ?? row.status}</Tag>
              <span className="font-medium">{fromAtomic(row.quantity, 6)} {label(row.unit)}</span>
              <a className="mono ml-auto inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink" href={`https://preprod.cardanoscan.io/transaction/${row.txHash}`} target="_blank" rel="noreferrer">
                {row.txHash.slice(0, 10)}…<ExternalLink className="size-3" />
              </a>
            </li>
          ))}
          {view.submissions.filter((sent) => !view.deposits.some((row) => row.txHash === sent.txHash)).map((sent) => (
            <li key={sent.txHash} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <Tag tone="quiet">Sent</Tag>
              <span className="font-medium">{sent.amounts.map((a) => `${fromAtomic(a.quantity, 6)} ${label(a.unit)}`).join(' + ')}</span>
              <span className="mono ml-auto text-[12px] text-ink-3">{sent.txHash.slice(0, 10)}… waiting for the chain</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function AccountPage() {
  const appAccount = useAppSession()
  const [session, setSession] = useState<Session | null>(() => savedSession())
  const [account, setAccount] = useState<AccountView | null>(null)
  const [loading, setLoading] = useState(Boolean(session))
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile>({displayName: '', kind: 'business'})
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!APP_EDITION) return
    const changed = (event: Event) => {
      const next = event.type === 'storage' ? savedSession() : (event as CustomEvent<Session | null>).detail
      setSession(next)
      if (!next) setAccount(null)
    }
    window.addEventListener('tally-session-changed', changed)
    window.addEventListener('storage', changed)
    return () => { window.removeEventListener('tally-session-changed', changed); window.removeEventListener('storage', changed) }
  }, [])

  const refresh = useCallback(async () => {
    if (!session) return
    try {
      setAccount(await readAccount(session))
      setError(null)
    } catch (e) {
      if (e instanceof AccountApiError && e.status === 401) {
        await signOut(null)
        setSession(null); setAccount(null)
      } else {
        setError(message(e))
      }
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (!session) return
    let live = true
    readAccount(session).then(
      (view) => { if (live) { setAccount(view); setError(null); setLoading(false) } },
      () => { if (live) void refresh() },
    )
    return () => { live = false }
  }, [session, refresh])
  // Pending deposits confirm on the chain: read the account again until they settle.
  const waiting = account?.deposits.deposits.some((row) => row.status === 'pending') ||
    account?.deposits.submissions.some((sent) => !account.deposits.deposits.some((row) => row.txHash === sent.txHash))
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => { void refresh() }, 15_000)
    return () => clearInterval(timer)
  }, [waiting, refresh])

  const signedIn = (next: Session, view: AccountView) => {
    setSession(next); setAccount(view); setAdding(false)
    toast.success(view.wallets.length > 1 ? 'Wallet added' : 'Signed in', {description: view.entity.displayName})
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Account"
        title={account ? account.entity.displayName : 'Your Tally account'}
        description="Sign in with a Cardano wallet, verify your identity, and deposit test funds for live deals. Tally never holds your wallet keys. Every deal checks your wallet and KYC again."
        actions={session ? (
          <button type="button" className={SECONDARY} onClick={async () => { await signOut(session); setSession(null); setAccount(null) }}>
            <LogOut className="size-4" />Sign out
          </button>
        ) : null}
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {!session ? (
        <Reveal>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Section title="Sign in or create an account" aside="Cardano preprod">
              <div className="mb-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Field label="Name (new accounts)" hint="A company or your own name. It shows on deals.">
                  <Input value={profile.displayName ?? ''} onChange={(e) => setProfile({...profile, displayName: e.target.value})} className="h-10 bg-white" />
                </Field>
                <Field label="Account type">
                  <Choice value={profile.kind ?? 'business'} onChange={(kind) => setProfile({...profile, kind})} options={[{value: 'business', label: 'Business'}, {value: 'person', label: 'Person'}]} />
                </Field>
              </div>
              <WalletChoices session={null} onSignedIn={signedIn} profile={profile} />
            </Section>
            <Section title="What you need to trade">
              <ol className="space-y-4">
                <Step done={false} title="A wallet">Connect Lace or Eternl, or create one in this browser. The wallet signs in. It is your account.</Step>
                <Step done={false} title="Identity checks (KYC)">Every sale and contract checks KYC again. This build uses a mock vendor.</Step>
                {APP_EDITION ? <Step done={false} title="Deal signing">Your wallet derives a separate key for signed deal actions.</Step> : null}
                <Step done={false} title="A deposit for live deals">Send test USDM from your wallet. Paper deals need no deposit.</Step>
              </ol>
            </Section>
          </div>
        </Reveal>
      ) : loading || !account ? (
        <p className="flex items-center gap-2 text-[14px] text-ink-3"><Loader2 className="size-4 animate-spin" />Loading your account…</p>
      ) : (
        <div className="space-y-6">
          <Reveal>
            <Section title="Ready to trade" aside={(APP_EDITION ? appAccount.me?.readiness.canTrade : account.readiness.canTrade) ? <Tag tone="up">ready</Tag> : <Tag tone="warn">not yet</Tag>}>
              <ol className={APP_EDITION ? "grid gap-4 md:grid-cols-2 xl:grid-cols-4" : "grid gap-4 md:grid-cols-3"}>
                <Step done={account.readiness.wallet} title="Wallet proven">{account.wallets.length} wallet{account.wallets.length === 1 ? '' : 's'}</Step>
                <Step done={account.readiness.kyc} title="KYC passed">{account.readiness.kyc ? `Tier ${account.kyc.tier}` : account.readiness.kycMessage}</Step>
                {APP_EDITION ? <Step done={Boolean(appAccount.me?.readiness.dealKey)} title="Deal key registered">Your wallet signs each deal action</Step> : null}
                {!APP_EDITION || appAccount.me?.mode === 'live' ? <Step done={account.readiness.deposit} title="Deposit credited">{APP_EDITION ? 'Preprod test funds for live deals' : 'Needed for live deals only'}</Step> : null}
              </ol>
            </Section>
          </Reveal>

          <div className="grid gap-6 lg:grid-cols-2">
            <Reveal>
              <Section title="Identity (KYC)">
                <KycForm session={session} account={account} onChange={(view) => { setAccount(view); if (APP_EDITION) void appAccount.refresh() }} />
              </Section>
            </Reveal>
            <Reveal delay={0.05}>
              <Section title="Wallets" aside={<button type="button" className="text-[12.5px] font-medium text-ink-2 hover:text-ink" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a wallet'}</button>}>
                <ul className="space-y-2.5">
                  {account.wallets.map((wallet) => (
                    <li key={wallet.address} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <Hash value={wallet.address} n={12} />
                      <Tag tone="quiet">{wallet.credentialKind === 'stake' ? 'whole wallet' : 'one address'}</Tag>
                      <span className="text-ink-3">{wallet.source === 'browser' ? 'browser wallet' : wallet.walletName ?? 'extension'}</span>
                    </li>
                  ))}
                </ul>
                {account.wallets.some((wallet) => wallet.credentialKind === 'stake') ? (
                  <p className="mt-3 text-[11.5px] text-ink-3">
                    A <span className="mono">stake_test1</span> address signs in for the whole wallet. It cannot receive funds.
                    Use the receive address under Receive test funds.
                  </p>
                ) : null}
                {adding ? <div className="mt-5 border-t border-border pt-5"><WalletChoices session={session} onSignedIn={signedIn} profile={{}} /></div> : null}
                <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-ink-3"><Copy className="size-3" />Account id <span className="mono">{account.entity.id}</span></p>
              </Section>
            </Reveal>
          </div>

          <Reveal>
            <Section title="Receive test funds" aside="Cardano preprod">
              <ReceiveFunds session={session} account={account} />
            </Section>
          </Reveal>

          {APP_EDITION && appAccount.me ? <Reveal>
            <Section title="Set up deal signing" aside={appAccount.me.party ? <Tag tone="up">registered</Tag> : <Tag tone="warn">needed</Tag>}>
              <p className="mb-4 max-w-[65ch] text-[13.5px] text-ink-2">Your wallet signs a site-specific message to derive your deal key. The deal key stays in memory. Use the same wallet for every deal action. Anyone who gets this exact message signed can derive the key.</p>
              {appAccount.me.party ? <p className="text-[13px] text-ink-2">Deal public key <Hash value={appAccount.me.party.publicKeyHex} n={10} /></p> : <DealSigning
                session={session} me={appAccount.me} label="Set up deal signing" disabled={!account.readiness.kyc}
                work={async (key) => { await deals.register(session, {publicKeyHex: key.publicKeyHex, cardanoAddress: key.cardanoAddress}); await appAccount.refresh(); toast.success('Deal signing is ready') }}
              />}
              {!account.readiness.kyc ? <p className="mt-3 text-[12.5px] text-ink-3">Pass mock KYC first.</p> : null}
            </Section>
          </Reveal> : null}

          <Reveal>
            <Section title="Deposits" aside="Masumi escrow is funded from these deposits">
              <Deposits session={session} account={account} refresh={refresh} />
            </Section>
          </Reveal>
        </div>
      )}
    </div>
  )
}

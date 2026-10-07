import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react'
import {Link} from 'react-router-dom'
import {ErrorNote, PageHeader, Section} from '@/components/kit'
import {savedSession, signOut, type Session} from './account'
import {deals, type AppMe} from './deals'
import {APP_EDITION} from './edition'

interface AppSession {
  session: Session | null
  me: AppMe | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}
const Context = createContext<AppSession>({session: null, me: null, loading: false, error: null, refresh: async () => {}, signOut: async () => {}})
// eslint-disable-next-line react-refresh/only-export-components
export const useAppSession = () => useContext(Context)

export function AppSessionProvider({children}: {children: ReactNode}) {
  const [session, setSession] = useState<Session | null>(() => APP_EDITION ? savedSession() : null)
  const currentToken = useRef(session?.token)
  const [me, setMe] = useState<AppMe | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(session))
  const refresh = useCallback(async () => {
    if (!session) return
    try {
      const next = await deals.me(session)
      if (currentToken.current === session.token) { setMe(next); setError(null) }
    } catch (error) {
      if (currentToken.current === session.token) setError(error instanceof Error ? error.message : String(error))
    }
  }, [session])

  useEffect(() => {
    if (!APP_EDITION) return
    const changed = (event: Event) => {
      const next = event.type === 'storage' ? savedSession() : (event as CustomEvent<Session | null>).detail
      currentToken.current = next?.token
      setSession(next); setMe(null); setError(null); setLoading(Boolean(next))
    }
    window.addEventListener('tally-session-changed', changed)
    window.addEventListener('storage', changed)
    return () => {
      window.removeEventListener('tally-session-changed', changed)
      window.removeEventListener('storage', changed)
    }
  }, [])

  useEffect(() => {
    currentToken.current = session?.token
    if (!session) return
    let live = true
    deals.me(session).then(
      (me) => { if (live && currentToken.current === session.token) { setMe(me); setError(null) } },
      (error: unknown) => { if (live && currentToken.current === session.token) setError(error instanceof Error ? error.message : String(error)) },
    ).finally(() => { if (live && currentToken.current === session.token) setLoading(false) })
    const expiry = setTimeout(() => { void signOut(null) }, Math.max(0, Date.parse(session.expiresAt) - Date.now()))
    return () => { live = false; clearTimeout(expiry) }
  }, [session])

  return <Context.Provider value={{session, me, loading, error, refresh, signOut: () => signOut(session)}}>{children}</Context.Provider>
}

/** Gate private screens before any deal loader runs. */
export function AppGate({children}: {children: ReactNode}) {
  const {session, me, loading, error, refresh} = useAppSession()
  if (!session) return (
    <div className="space-y-8">
      <PageHeader title="Your deals start here" description="Sign in with your Cardano wallet to see your deals or create one. All funds are preprod test funds. KYC uses a mock vendor." />
      <Section title="Sign in to Tally">
        <p className="mb-5 text-[14px] text-ink-2">Your wallet proves your account. Each deal action needs your separate deal signature.</p>
        <Link to="/account" className="inline-flex h-10 items-center rounded-[9px] bg-ink px-4 text-[14px] font-semibold text-white hover:bg-ink-2">Go to Account</Link>
      </Section>
    </div>
  )
  if (error) return <div className="space-y-4"><ErrorNote>{error}</ErrorNote><button type="button" onClick={() => void refresh()} className="text-[14px] underline">Try again</button></div>
  if (loading || !me) return <p role="status" className="text-[14px] text-ink-3">Loading your account…</p>
  return children
}

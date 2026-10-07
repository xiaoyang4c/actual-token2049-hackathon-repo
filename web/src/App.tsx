import {AppGate, AppSessionProvider} from '@/lib/app-session'
import {APP_EDITION} from '@/lib/edition'
import {AppContractPage} from '@/pages/AppContract'
import {NewDealPage} from '@/pages/NewDeal'
import {useEffect} from 'react'
import {BrowserRouter, Navigate, Route, Routes, useLocation} from 'react-router-dom'
import {AnimatePresence} from 'motion/react'
import {PageIn, ScrollProgress} from '@/components/motion'
import {Backdrop} from '@/components/Backdrop'
import {LensProvider} from '@/components/kit'
import {Shell} from '@/components/Shell'
import {Toaster} from '@/components/ui/sonner'
import {TooltipProvider} from '@/components/ui/tooltip'
import {AccountPage} from '@/pages/Account'
import {AskPage} from '@/pages/Ask'
import {CompaniesPage} from '@/pages/Companies'
import {ContractPage} from '@/pages/Contract'
import {CoworkersPage} from '@/pages/Coworkers'
import {DealDeskPage} from '@/pages/DealDesk'
import {DealsPage} from '@/pages/Deals'
import {MediationPage} from '@/pages/Mediation'
import {OperatorPage} from '@/pages/Operator'

function ScrollReset() {
  const {pathname} = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <AnimatePresence mode="wait">
      <PageIn key={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={APP_EDITION ? <AppGate><DealsPage /></AppGate> : <DealsPage />} />
          {APP_EDITION ? <Route path="/deals/new" element={<AppGate><NewDealPage /></AppGate>} /> : null}
          {APP_EDITION ? <Route path="/deals/:id" element={<AppGate><AppContractPage /></AppGate>} /> : null}
          {!APP_EDITION ? <Route path="/contracts/:id" element={<ContractPage />} /> : null}
          {!APP_EDITION ? <Route path="/mediation" element={<MediationPage />} /> : null}
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/deal-desk" element={<DealDeskPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/coworkers" element={<CoworkersPage />} />
          {!APP_EDITION ? <Route path="/operator" element={<OperatorPage />} /> : null}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </PageIn>
    </AnimatePresence>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delay={150}>
        <AppSessionProvider><LensProvider>
          <ScrollReset />
          <Backdrop />
          <ScrollProgress />
          <Shell>
            <AnimatedRoutes />
          </Shell>
          <Toaster />
        </LensProvider></AppSessionProvider>
      </TooltipProvider>
    </BrowserRouter>
  )
}

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
          <Route path="/" element={<DealsPage />} />
          <Route path="/contracts/:id" element={<ContractPage />} />
          <Route path="/mediation" element={<MediationPage />} />
          <Route path="/companies" element={<CompaniesPage />} />
          <Route path="/deal-desk" element={<DealDeskPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/coworkers" element={<CoworkersPage />} />
          <Route path="/operator" element={<OperatorPage />} />
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
        <LensProvider>
          <ScrollReset />
          <Backdrop />
          <ScrollProgress />
          <Shell>
            <AnimatedRoutes />
          </Shell>
          <Toaster />
        </LensProvider>
      </TooltipProvider>
    </BrowserRouter>
  )
}

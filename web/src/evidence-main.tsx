/** The same checker, hosted beside the existing EC2 operator UI. */
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {ArrowLeft} from 'lucide-react'
import {Brand} from '@/components/kit'
import {EvidencePage} from '@/pages/Evidence'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div className="min-h-dvh bg-[#e9eaed]">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-black/10 bg-white/75 px-5 sm:px-8">
        <a href="/" aria-label="Tally home"><Brand /></a>
        <a href="/" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-[13px] font-medium text-ink-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"><ArrowLeft className="size-4" />Back to marketplace</a>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12"><EvidencePage /></main>
    </div>
  </StrictMode>,
)

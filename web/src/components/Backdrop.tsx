import {useEffect} from 'react'
import {motion, useMotionValue, useScroll, useSpring, useTransform} from 'motion/react'

/*
 * The page gradient as a live wallpaper, in the spirit of a phone home screen:
 * large white and gray lights morph and drift across the white-to-gray field,
 * the whole field leans a little against the pointer (no visible cursor
 * element), and the gray deepens as the page scrolls.
 */
export function Backdrop() {
  const {scrollYProgress} = useScroll()
  const p = useSpring(scrollYProgress, {stiffness: 60, damping: 20})
  const background = useTransform(p, (v) => {
    const white = 16 - v * 12
    const mid = 44 - v * 16
    const low = 78 - v * 14
    const d = v * 14
    return `linear-gradient(180deg, #ffffff 0%, #f1f2f4 ${white}%, #d9dce0 ${mid}%, #b5bac1 ${low}%, rgb(${144 - d} ${150 - d} ${158 - d}) 100%)`
  })

  // Parallax: the lights lean against the pointer, like a wallpaper reacting to tilt.
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const sx = useSpring(mx, {stiffness: 40, damping: 18})
  const sy = useSpring(my, {stiffness: 40, damping: 18})
  const nearX = useTransform(sx, (v) => v * -46)
  const nearY = useTransform(sy, (v) => v * -34)
  const farX = useTransform(sx, (v) => v * 24)
  const farY = useTransform(sy, (v) => v * 18)

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mx.set(e.clientX / window.innerWidth - 0.5)
      my.set(e.clientY / window.innerHeight - 0.5)
    }
    window.addEventListener('pointermove', onMove, {passive: true})
    return () => window.removeEventListener('pointermove', onMove)
  }, [mx, my])

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <motion.div className="absolute inset-0" style={{background}} />
      {/* Far layer: cool gray lights. */}
      <motion.div className="absolute inset-0" style={{x: farX, y: farY}}>
        <div className="blob blob-c absolute right-[-18%] top-[18%] h-[78vh] w-[62vw] bg-[radial-gradient(closest-side,rgb(128_139_158/0.85),rgb(128_139_158/0))]" />
        <div className="blob blob-d absolute bottom-[-30%] left-[10%] h-[80vh] w-[70vw] bg-[radial-gradient(closest-side,rgb(98_106_120/0.7),rgb(98_106_120/0))]" />
      </motion.div>
      {/* Near layer: white lights. */}
      <motion.div className="absolute inset-0" style={{x: nearX, y: nearY}}>
        <div className="blob blob-a absolute -left-[18%] -top-[28%] h-[90vh] w-[78vw] bg-[radial-gradient(closest-side,rgb(255_255_255/1),rgb(255_255_255/0))]" />
        <div className="blob blob-b absolute left-[35%] top-[30%] h-[70vh] w-[55vw] bg-[radial-gradient(closest-side,rgb(255_255_255/1),rgb(255_255_255/0))]" />
      </motion.div>
      {/* Ledger grid, fading toward the edges. */}
      <div className="absolute inset-0 bg-[linear-gradient(rgb(11_14_15/0.05)_1px,transparent_1px),linear-gradient(90deg,rgb(11_14_15/0.05)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_90%_70%_at_50%_30%,black_20%,transparent_85%)]" />
    </div>
  )
}

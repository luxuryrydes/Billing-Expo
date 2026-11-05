/**
 * Motion for the whole app, built on Framer Motion: page transitions, a sliding sidebar highlight, spring dialogs, sliding toasts, and
 * "analytics" motion on the dashboard (numbers that count up, bars and progress that grow, cards that rise in turn).
 * Everything respects the system "reduce motion" setting (see MotionConfig in main.tsx).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { animate, motion } from 'framer-motion';

export const spring = { type: 'spring', stiffness: 420, damping: 34 } as const;
const easeOut = [0.22, 1, 0.36, 1] as const;

/** A screen: fades and rises into place when the route changes. */
export function Page({ children }: { children: ReactNode }) {
  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: easeOut }}>{children}</motion.div>;
}

/** A group whose children (use <Rise>) appear one after another. */
export function Stagger({ children, className, gap = 0.06 }: { children: ReactNode; className?: string; gap?: number }) {
  return <motion.div className={className} initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: 0.05 } } }}>{children}</motion.div>;
}
export function Rise({ children, className }: { children: ReactNode; className?: string }) {
  return <motion.div className={className} variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: easeOut } } }}>{children}</motion.div>;
}

/** A number that counts up from zero (or from its previous value) when it appears or changes. */
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 0.9 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const from = shown;
    const c = animate(from, value, { duration, ease: easeOut, onUpdate: (v) => setShown(v) });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{format(shown)}</>;
}

/** A horizontal bar that grows to its width. */
export function GrowBar({ pct, className, style, delay = 0 }: { pct: number; className?: string; style?: React.CSSProperties; delay?: number }) {
  return <motion.div className={className} style={style} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: easeOut, delay }} />;
}

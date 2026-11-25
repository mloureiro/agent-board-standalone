import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Clock = () => number;

const ClockContext = createContext<Clock>(Date.now);

export function ClockProvider(props: {
  readonly clock: Clock;
  readonly children: ReactNode;
}): ReactNode {
  return <ClockContext.Provider value={props.clock}>{props.children}</ClockContext.Provider>;
}

export const useClock = (): Clock => useContext(ClockContext);

export function useNow(intervalMs = 30_000): number {
  const clock = useClock();
  const [now, setNow] = useState(clock);
  useEffect(() => {
    setNow(clock());
    const timer = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(timer);
  }, [clock, intervalMs]);
  return now;
}

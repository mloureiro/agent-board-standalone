export interface HoldGate {
  isHeld(): boolean;
  inFlight(): number;
  enter(): void;
  leave(): void;
  hold(): Promise<void>;
  release(): void;
}

export const createHoldGate = (): HoldGate => {
  let held = false;
  let inFlight = 0;
  let waiting: (() => void)[] = [];
  const settle = (): void => {
    if (inFlight > 0) return;
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve();
  };
  return {
    isHeld: () => held,
    inFlight: () => inFlight,
    enter: () => {
      inFlight += 1;
    },
    leave: () => {
      inFlight -= 1;
      settle();
    },
    hold: () => {
      held = true;
      return new Promise<void>((resolve) => {
        waiting.push(resolve);
        settle();
      });
    },
    release: () => {
      held = false;
    },
  };
};

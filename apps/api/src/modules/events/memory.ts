import type { EventBus, EventMessage } from './bus.js';

type Listener = (message: EventMessage) => void;

export const createMemoryEvents = (): EventBus => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    publish: async (owner, message) => {
      for (const listener of [...(listeners.get(owner) ?? [])]) listener(message);
    },
    subscribe: async (owner, listener) => {
      const set = listeners.get(owner) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(owner, set);
      return async () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(owner) === set) listeners.delete(owner);
      };
    },
    close: async () => {
      listeners.clear();
    },
  };
};

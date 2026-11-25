export interface OpenStreams {
  add(end: () => void): () => void;
  endAll(): void;
}

export const createOpenStreams = (): OpenStreams => {
  const open = new Set<() => void>();
  return {
    add: (end) => {
      open.add(end);
      return () => {
        open.delete(end);
      };
    },
    endAll: () => {
      for (const end of [...open]) end();
      open.clear();
    },
  };
};

import { MutationCache, QueryClient } from '@tanstack/react-query';

export interface WriteFeedback {
  onError(error: unknown): void;
}

export const createQueryClient = (feedback?: WriteFeedback): QueryClient => {
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error) => feedback?.onError(error),
      onSuccess: () => void client.invalidateQueries(),
    }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return client;
};

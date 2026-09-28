"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement, type ReactNode } from "react";

/**
 * TanStack Query provider.
 *
 * RAGdoll's only server-state query is the session snapshot, so the defaults are
 * tuned for that: one retry, no refetch on focus (a refocus must not silently
 * rebuild an index), and a short stale window so navigation feels instant.
 */
export function QueryProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 5_000,
            gcTime: 5 * 60_000,
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

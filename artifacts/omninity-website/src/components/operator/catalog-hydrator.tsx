/**
 * Hydrates the static `error-catalog` mirror from the live API on boot.
 *
 * The static fallbacks in `lib/error-catalog.ts` cover the common codes we
 * know at build time. This hook fetches the full catalog from
 * `/api/diagnostics/catalog` once and merges it in, so the UI copy tracks
 * backend additions without a redeploy. Render-only — no DOM output.
 */
import { useEffect } from "react";
import { useGetDiagnosticCatalog } from "@workspace/api-client-react";
import { setLiveCatalog } from "@/lib/error-catalog";

export function CatalogHydrator() {
  const query = useGetDiagnosticCatalog({
    query: {
      retry: false,
      staleTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    } as never,
  });

  useEffect(() => {
    if (query.data?.data.items) {
      setLiveCatalog(query.data.data.items);
    }
  }, [query.data]);

  return null;
}

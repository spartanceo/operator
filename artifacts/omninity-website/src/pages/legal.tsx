/**
 * Public legal page (Task #25).
 *
 * Renders the canonical body of one legal document fetched from the API.
 * Driven by a single component with the document type passed as a prop —
 * this keeps every legal page on the marketing site visually consistent
 * and removes any chance of one document drifting out of sync with the
 * machine-readable catalogue.
 */
import { useMemo } from "react";
import { useGetLegalDocument } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";

import { SEO } from "@/components/seo";

type LegalDocType =
  | "eula"
  | "privacy"
  | "terms"
  | "eu_ai_act"
  | "open_source_attribution";

interface LegalPageProps {
  documentType: LegalDocType;
}

const TITLES: Record<LegalDocType, string> = {
  eula: "End User Licence Agreement",
  privacy: "Privacy Policy",
  terms: "Terms of Service",
  eu_ai_act: "EU AI Act Compliance",
  open_source_attribution: "Open Source Attribution",
};

export default function LegalPage({ documentType }: LegalPageProps) {
  const query = useGetLegalDocument(documentType);
  const doc = query.data?.data.document ?? null;
  const paragraphs = useMemo(() => {
    if (!doc) return [];
    return doc.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  }, [doc]);

  return (
    <>
      <SEO
        title={`${TITLES[documentType]} — Omninity`}
        description={`Omninity's ${TITLES[documentType].toLowerCase()}.`}
      />
      <main className="mx-auto max-w-3xl px-5 py-16 md:px-8">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Legal
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
          {TITLES[documentType]}
        </h1>
        {doc ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Version {doc.version}</span>
            <span>
              Effective {new Date(doc.effectiveDate).toLocaleDateString()}
            </span>
            <span className="font-mono">{doc.hash.slice(0, 12)}…</span>
          </div>
        ) : null}

        {query.isLoading ? (
          <div
            className="mt-12 flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="legal-page-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : null}

        {query.isError ? (
          <p className="mt-12 text-sm text-destructive">
            Failed to load this document. Please try again.
          </p>
        ) : null}

        {doc ? (
          <article
            className="prose prose-neutral mt-10 max-w-none dark:prose-invert"
            data-testid={`legal-page-${documentType}`}
          >
            {paragraphs.map((p, i) => (
              <p key={i} className="whitespace-pre-wrap text-sm leading-7">
                {p}
              </p>
            ))}
          </article>
        ) : null}
      </main>
    </>
  );
}

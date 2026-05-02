import { useMemo } from "react";
import { Link } from "wouter";
import { ArrowLeft, Code2, Download, ExternalLink } from "lucide-react";
import openApiSource from "../../../../lib/api-spec/openapi.yaml?raw";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";

interface OperationEntry {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  tag: string;
}

const METHOD_TONE: Record<string, string> = {
  get: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  post: "border-primary/50 bg-primary/10 text-primary",
  put: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  patch: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  delete: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

function parseOpenApi(source: string): OperationEntry[] {
  const lines = source.split("\n");
  const ops: OperationEntry[] = [];
  let inPaths = false;
  let pathsBaseIndent = -1;
  let currentPath: string | null = null;
  let currentPathIndent = -1;
  let currentMethod: string | null = null;
  let currentMethodIndent = -1;
  let currentOp: Partial<OperationEntry> = {};

  const flush = () => {
    if (currentPath && currentMethod && currentOp.operationId) {
      ops.push({
        path: currentPath,
        method: currentMethod,
        operationId: currentOp.operationId,
        summary: currentOp.summary ?? "",
        tag: currentOp.tag ?? "default",
      });
    }
    currentOp = {};
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim()) continue;
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      pathsBaseIndent = line.length - line.trimStart().length;
      continue;
    }
    if (!inPaths) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= pathsBaseIndent && !/^\s/.test(line)) {
      flush();
      inPaths = false;
      continue;
    }
    const pathMatch = line.match(/^(\s+)(\/[^:]*):\s*$/);
    if (pathMatch && (currentPathIndent === -1 || pathMatch[1].length === currentPathIndent)) {
      flush();
      currentPath = pathMatch[2];
      currentPathIndent = pathMatch[1].length;
      currentMethod = null;
      continue;
    }
    if (currentPath) {
      const methodMatch = line.match(/^(\s+)(get|post|put|patch|delete|options|head):\s*$/);
      if (methodMatch && methodMatch[1].length > currentPathIndent) {
        flush();
        currentMethod = methodMatch[2];
        currentMethodIndent = methodMatch[1].length;
        continue;
      }
    }
    if (currentMethod) {
      const opIdMatch = line.match(/^\s+operationId:\s*(\S+)/);
      if (opIdMatch && line.length - line.trimStart().length > currentMethodIndent) {
        currentOp.operationId = opIdMatch[1];
        continue;
      }
      const summaryMatch = line.match(/^\s+summary:\s*(.+)$/);
      if (summaryMatch && line.length - line.trimStart().length > currentMethodIndent) {
        currentOp.summary = summaryMatch[1].trim().replace(/^['"]|['"]$/g, "");
        continue;
      }
      const tagsMatch = line.match(/^\s+tags:\s*\[([^\]]+)\]/);
      if (tagsMatch && line.length - line.trimStart().length > currentMethodIndent) {
        currentOp.tag = tagsMatch[1].split(",")[0]!.trim();
        continue;
      }
    }
  }
  flush();
  return ops;
}

function getApiMeta(source: string): { title: string; version: string } {
  const titleMatch = source.match(/^\s*title:\s*(.+)$/m);
  const versionMatch = source.match(/^\s*version:\s*(.+)$/m);
  return {
    title: (titleMatch?.[1] ?? "Omninity API").replace(/^['"]|['"]$/g, "").trim(),
    version: (versionMatch?.[1] ?? "0.1.0").replace(/^['"]|['"]$/g, "").trim(),
  };
}

export default function ApiReferencePage() {
  const ops = useMemo(() => parseOpenApi(openApiSource), []);
  const meta = useMemo(() => getApiMeta(openApiSource), []);
  const grouped = useMemo(() => {
    const map = new Map<string, OperationEntry[]>();
    for (const op of ops) {
      const arr = map.get(op.tag) ?? [];
      arr.push(op);
      map.set(op.tag, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [ops]);

  const specBlobUrl = useMemo(
    () => URL.createObjectURL(new Blob([openApiSource], { type: "application/yaml" })),
    [],
  );

  return (
    <>
      <SEO
        title="API reference"
        description="Auto-generated reference for the Omninity Operator HTTP API. Sourced directly from the canonical OpenAPI 3.1 spec."
      />
      <section className="border-b border-border/40 py-16 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          <Link
            href="/docs"
            className="hover-elevate inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to docs
          </Link>
          <div className="mt-7 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <Badge
                variant="outline"
                className="rounded-full border-border bg-card/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                Generated from OpenAPI {meta.version}
              </Badge>
              <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight md:text-5xl">
                API reference.
              </h1>
              <p className="mt-4 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground">
                Every endpoint below is sourced from{" "}
                <code className="rounded bg-card px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                  lib/api-spec/openapi.yaml
                </code>
                . The same file generates the typed client used by OP itself, so what you read
                here is what the agent calls.
              </p>
            </div>
            <div className="flex shrink-0 gap-3">
              <Button asChild variant="outline" className="gap-2">
                <a href={specBlobUrl} download="omninity-openapi.yaml">
                  <Download className="h-4 w-4" />
                  Download spec
                </a>
              </Button>
              <Button asChild className="gap-2">
                <a
                  href="https://editor.swagger.io/"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open in Swagger
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
      <section className="py-14 md:py-20">
        <div className="mx-auto max-w-6xl px-5 md:px-8">
          {grouped.length === 0 ? (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              No operations found in the OpenAPI spec yet.
            </Card>
          ) : (
            <div className="space-y-12">
              {grouped.map(([tag, tagOps]) => (
                <div key={tag}>
                  <div className="flex items-baseline gap-3">
                    <Code2 className="h-4 w-4 text-primary" />
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {tag}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {tagOps.length} {tagOps.length === 1 ? "endpoint" : "endpoints"}
                    </span>
                  </div>
                  <Card className="mt-4 divide-y divide-border/60 p-0">
                    {tagOps.map((op) => (
                      <div
                        key={`${op.method}-${op.path}`}
                        className="grid grid-cols-1 gap-4 p-6 md:grid-cols-12 md:items-start"
                      >
                        <div className="md:col-span-2">
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider ${
                              METHOD_TONE[op.method] ?? "border-border text-muted-foreground"
                            }`}
                          >
                            {op.method}
                          </span>
                        </div>
                        <div className="md:col-span-5">
                          <div className="font-mono text-sm text-foreground">
                            <span className="text-muted-foreground">/api</span>
                            {op.path}
                          </div>
                          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                            {op.operationId}
                          </div>
                        </div>
                        <div className="text-sm leading-relaxed text-muted-foreground md:col-span-5">
                          {op.summary || "No summary provided."}
                        </div>
                      </div>
                    ))}
                  </Card>
                </div>
              ))}
            </div>
          )}
          <Card className="mt-12 border-border/60 bg-card/40 p-7">
            <h3 className="text-base font-medium tracking-tight text-foreground">
              The full source-of-truth spec
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              For request and response shapes, schemas, error envelopes, and tenant scoping
              rules, read{" "}
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                openapi.yaml
              </code>{" "}
              directly. It is the single source of truth used by codegen, the SDK, and {meta.title}.
            </p>
            <pre className="mt-5 max-h-96 overflow-auto rounded-xl border border-border bg-background p-5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              <code>{openApiSource}</code>
            </pre>
          </Card>
        </div>
      </section>
    </>
  );
}

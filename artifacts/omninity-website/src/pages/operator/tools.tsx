import { useMemo, useState } from "react";
import { Wrench, Play } from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  useListTools,
  useInvokeTool,
  type ToolEntry,
  type ToolInvokeResult,
} from "@workspace/api-client-react";
import { RiskBadge } from "@/components/operator/risk-badge";
import { JsonView } from "@/components/operator/json-view";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { cn } from "@/lib/utils";

export default function ToolsPage() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ToolEntry | null>(null);
  const [inputJson, setInputJson] = useState<string>("{}");
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [result, setResult] = useState<ToolInvokeResult | null>(null);

  const toolsQuery = useListTools({ limit: 100 });
  const tools = toolsQuery.data?.data.items ?? [];

  const invoke = useInvokeTool({
    mutation: {
      onSuccess: (resp) => {
        setResult(resp.data);
      },
      onError: () => {
        setResult(null);
      },
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }, [tools, search]);

  const onSelect = (tool: ToolEntry) => {
    setSelected(tool);
    setInputJson("{}");
    setResult(null);
    setInvokeError(null);
  };

  const onInvoke = () => {
    if (!selected) return;
    let parsed: Record<string, unknown>;
    try {
      const value = inputJson.trim().length === 0 ? "{}" : inputJson;
      parsed = JSON.parse(value) as Record<string, unknown>;
    } catch (err) {
      setInvokeError(
        err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON",
      );
      return;
    }
    setInvokeError(null);
    setResult(null);
    invoke.mutate({ name: selected.name, data: { input: parsed } });
  };

  return (
    <OperatorLayout
      title="Tools"
      description="The full set of capabilities the executor can call. Try any of them with custom input."
    >
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_2fr]">
        <section className="space-y-3">
          <Input
            placeholder="Search tools…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-tool-search"
          />
          <ErrorBanner error={toolsQuery.error} />

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Wrench className="h-6 w-6" />}
              title={tools.length === 0 ? "No tools registered" : "No matches"}
              description={
                tools.length === 0
                  ? "The server's tool registry is empty."
                  : "Try a different search."
              }
            />
          ) : (
            <ul className="space-y-2">
              {filtered.map((tool: any) => (
                <li key={tool.name}>
                  <button
                    type="button"
                    onClick={() => onSelect(tool)}
                    className={cn(
                      "w-full rounded-md border border-border bg-card p-3 text-left hover-elevate active-elevate-2",
                      selected?.name === tool.name &&
                        "border-primary/50 bg-muted/40",
                    )}
                    data-testid={`tool-row-${tool.name}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-foreground">
                        {tool.name}
                      </span>
                      <RiskBadge risk={tool.riskLevel} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {tool.description}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          {!selected ? (
            <EmptyState
              icon={<Wrench className="h-6 w-6" />}
              title="Pick a tool"
              description="Select a tool on the left to invoke it directly with JSON input."
            />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <CardTitle className="font-mono text-base">
                      {selected.name}
                    </CardTitle>
                    <CardDescription className="mt-1 text-xs">
                      {selected.description}
                    </CardDescription>
                  </div>
                  <RiskBadge risk={selected.riskLevel} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label
                    htmlFor="tool-input"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Input (JSON)
                  </label>
                  <Textarea
                    id="tool-input"
                    data-testid="input-tool-json"
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    spellCheck={false}
                    className="mt-1 min-h-[160px] font-mono text-xs"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    onClick={onInvoke}
                    disabled={invoke.isPending}
                    data-testid="button-invoke-tool"
                  >
                    <Play className="mr-1 h-3 w-3" />
                    {invoke.isPending ? "Running…" : "Invoke"}
                  </Button>
                  {result ? (
                    <Badge variant="outline">{result.durationMs}ms</Badge>
                  ) : null}
                </div>

                {invokeError ? (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                    data-testid="tool-input-error"
                  >
                    {invokeError}
                  </div>
                ) : null}

                <ErrorBanner error={invoke.error} title="Tool invocation failed" />

                {result ? (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Output
                    </p>
                    <JsonView value={result.output} className="mt-1" />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </OperatorLayout>
  );
}

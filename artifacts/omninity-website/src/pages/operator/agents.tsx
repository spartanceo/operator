import { useState } from "react";
import {
  Bot,
  Compass,
  ListTree,
  Cog,
  ShieldCheck,
  Search as SearchIcon,
  Brain,
} from "lucide-react";
import { OperatorLayout } from "@/components/operator/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useListAgentRuns,
  useGetAgentRun,
  useListAgentRunToolCalls,
  useListAgentRunApprovals,
  useListAgentRunMessages,
} from "@workspace/api-client-react";
import { ErrorBanner } from "@/components/operator/error-banner";
import { EmptyState } from "@/components/operator/empty-state";
import { PlanCard } from "@/components/operator/plan-card";
import { ExecutionTimeline } from "@/components/operator/timeline";
import { JsonView } from "@/components/operator/json-view";
import { cn } from "@/lib/utils";

const AGENT_ROSTER = [
  {
    name: "Router",
    description: "Routes user input to chat or to the planner.",
    icon: Compass,
  },
  {
    name: "Planner",
    description: "Breaks goals into ordered steps with risk classification.",
    icon: ListTree,
  },
  {
    name: "Executor",
    description: "Calls registered tools and gates high-risk steps for approval.",
    icon: Cog,
  },
  {
    name: "Verifier",
    description: "Checks step output against the plan and produces the summary.",
    icon: ShieldCheck,
  },
  {
    name: "Research",
    description: "Browser & extraction sub-agent for information gathering.",
    icon: SearchIcon,
  },
  {
    name: "Memory",
    description: "Reads and writes durable memories across runs.",
    icon: Brain,
  },
] as const;

const RUN_STATUS_STYLES: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-amber-500",
  succeeded: "text-emerald-500",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

export default function AgentsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runsQuery = useListAgentRuns({ limit: 20 });
  const runs = runsQuery.data?.data.items ?? [];

  return (
    <OperatorLayout
      title="Agents"
      description="Six specialized agents collaborate to plan, execute, and verify your goals."
    >
      <div className="space-y-6 p-6">
        <ErrorBanner error={runsQuery.error} />

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Roster
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {AGENT_ROSTER.map((agent) => {
              const Icon = agent.icon;
              return (
                <Card
                  key={agent.name}
                  data-testid={`agent-card-${agent.name.toLowerCase()}`}
                >
                  <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-2">
                    <div className="rounded-md bg-primary/10 p-2 text-primary">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <CardDescription className="mt-1 text-xs">
                        {agent.description}
                      </CardDescription>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recent runs
            </h2>
            <Badge variant="outline">{runs.length} loaded</Badge>
          </div>

          {runs.length === 0 && !runsQuery.isLoading ? (
            <EmptyState
              icon={<Bot className="h-6 w-6" />}
              title="No agent runs yet"
              description="Open Chat, switch on Agent mode, and submit a goal."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_2fr]">
              <Card className="overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Runs</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border">
                    {runs.map((run) => (
                      <li key={run.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full items-start gap-2 px-4 py-3 text-left hover-elevate active-elevate-2",
                            selectedRunId === run.id && "bg-muted/40",
                          )}
                          onClick={() => setSelectedRunId(run.id)}
                          data-testid={`run-row-${run.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-foreground">
                              {run.goal}
                            </p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {new Date(run.createdAt).toLocaleString()}
                            </p>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "uppercase",
                              RUN_STATUS_STYLES[run.status] ?? "",
                            )}
                          >
                            {run.status}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <div>
                {selectedRunId ? (
                  <RunDetail runId={selectedRunId} />
                ) : (
                  <EmptyState
                    icon={<Bot className="h-6 w-6" />}
                    title="Select a run"
                    description="Pick a run on the left to see its plan, timeline, and approvals."
                  />
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </OperatorLayout>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const runQuery = useGetAgentRun(runId);
  const callsQuery = useListAgentRunToolCalls(runId, { limit: 100 });
  const apprQuery = useListAgentRunApprovals(runId, { limit: 50 });
  const msgQuery = useListAgentRunMessages(runId, { limit: 100 });

  if (runQuery.isLoading) {
    return (
      <p className="p-6 text-sm text-muted-foreground">Loading run…</p>
    );
  }

  if (runQuery.error) {
    return <ErrorBanner error={runQuery.error} />;
  }

  const run = runQuery.data?.data;
  if (!run) return null;

  return (
    <div className="space-y-4">
      <PlanCard run={run} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Execution timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ExecutionTimeline calls={callsQuery.data?.data.items ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Approvals</CardTitle>
        </CardHeader>
        <CardContent>
          {(apprQuery.data?.data.items ?? []).length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              No approvals raised.
            </p>
          ) : (
            <ul className="space-y-2">
              {(apprQuery.data?.data.items ?? []).map((a) => (
                <li
                  key={a.id}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="uppercase">
                      {a.decision}
                    </Badge>
                    <span className="text-foreground">{a.summary}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {a.reason}
                  </p>
                  {a.note ? (
                    <p className="mt-1 text-xs italic text-foreground/80">
                      Note: {a.note}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <JsonView
            value={msgQuery.data?.data.items ?? []}
            emptyLabel="No messages recorded."
          />
        </CardContent>
      </Card>
    </div>
  );
}

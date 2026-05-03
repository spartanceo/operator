/**
 * `op` — flat-subcommand CLI for the Omninity Operator.
 *
 * Commands:
 *   op run "<goal>"                     — start an agent run
 *   op status <runId>                   — show run status / summary
 *   op skill create <slug> <name>       — scaffold a .skill.json file
 *   op skill publish <file>             — POST manifest to /api/skills/import
 *   op skill test <slug>                — invoke installed skill against a goal
 *   op plugin list|register|invoke      — manage plugin tools
 *   op events tail [--type X]           — long-poll the event stream
 *
 * We deliberately avoid pulling a CLI framework — argv parsing here is
 * tiny and predictable. Errors print one line to stderr and exit > 0.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { OmninityClient } from "@omninity/sdk";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function makeClient(flags: Record<string, string | boolean>): OmninityClient {
  const tenantId =
    (flags.tenant as string | undefined) ??
    process.env.OMNINITY_TENANT_ID ??
    "ws_default";
  const baseUrl =
    (flags.baseUrl as string | undefined) ??
    process.env.OMNINITY_BASE_URL ??
    "http://localhost:3001";
  return new OmninityClient({ tenantId, baseUrl });
}

function printJson(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function usage(): string {
  return [
    "op — Omninity Operator CLI",
    "",
    "Common flags: --tenant <id>  --baseUrl <url>",
    "",
    "Commands:",
    "  op run \"<goal>\"                start an agent run",
    "  op status <runId>              show run status",
    "  op skill create <slug> <name>  scaffold a .skill.json file",
    "  op skill publish <file>        publish a skill manifest",
    "  op skill test <slug> <goal>    run an installed skill against a goal",
    "  op plugin list                 list registered plugin tools",
    "  op plugin register <file>      register a plugin tool from JSON",
    "  op plugin invoke <id> <json>   invoke a plugin tool",
    "  op events tail [--type X]      long-poll recent events",
  ].join("\n");
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const goal = args.positional.slice(1).join(" ").trim();
  if (!goal) {
    process.stderr.write("op run: goal is required\n");
    return 2;
  }
  const op = makeClient(args.flags);
  const run = await op.runs.create({ goal });
  printJson(run);
  return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    process.stderr.write("op status: runId required\n");
    return 2;
  }
  const op = makeClient(args.flags);
  const run = await op.runs.get(id);
  printJson(run);
  return 0;
}

function scaffoldSkill(slug: string, name: string): Record<string, unknown> {
  return {
    manifestVersion: 1,
    slug,
    name,
    description: `Skill: ${name}`,
    category: "general",
    triggers: [{ type: "keyword", value: slug }],
    steps: [
      {
        toolName: "echo",
        rationale: "Demonstrate the skill is wired correctly.",
        input: { message: `Hello from ${name}` },
      },
    ],
  };
}

async function cmdSkill(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  if (sub === "create") {
    const slug = args.positional[2];
    const name = args.positional.slice(3).join(" ").trim();
    if (!slug || !name) {
      process.stderr.write("op skill create: slug and name required\n");
      return 2;
    }
    const file = resolve(process.cwd(), `${slug}.skill.json`);
    if (existsSync(file) && !args.flags.force) {
      process.stderr.write(`Refusing to overwrite ${file} (use --force)\n`);
      return 3;
    }
    writeFileSync(file, JSON.stringify(scaffoldSkill(slug, name), null, 2));
    // eslint-disable-next-line no-console
    process.stdout.write(`Wrote ${file}\n`);
    return 0;
  }
  if (sub === "publish") {
    const file = args.positional[2];
    if (!file) {
      process.stderr.write("op skill publish: file required\n");
      return 2;
    }
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
    const op = makeClient(args.flags);
    // Re-use the existing import endpoint via raw client.
    const res = await fetch(`${op.baseUrl}/api/skills/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id":
          (args.flags.tenant as string | undefined) ??
          process.env.OMNINITY_TENANT_ID ??
          "ws_default",
      },
      body: JSON.stringify({ manifest }),
    });
    const body = await res.json();
    printJson(body);
    return res.ok ? 0 : 4;
  }
  if (sub === "test") {
    const slug = args.positional[2];
    const goal = args.positional.slice(3).join(" ").trim();
    if (!slug || !goal) {
      process.stderr.write("op skill test: slug and goal required\n");
      return 2;
    }
    const op = makeClient(args.flags);
    const run = await op.runs.create({ goal });
    printJson(run);
    return 0;
  }
  process.stderr.write("op skill: unknown sub-command\n");
  return 2;
}

async function cmdPlugin(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const op = makeClient(args.flags);
  if (sub === "list") {
    printJson(await op.plugins.list());
    return 0;
  }
  if (sub === "register") {
    const file = args.positional[2];
    if (!file) {
      process.stderr.write("op plugin register: file required\n");
      return 2;
    }
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
    printJson(await op.plugins.register(manifest));
    return 0;
  }
  if (sub === "invoke") {
    const id = args.positional[2];
    const json = args.positional[3] ?? "{}";
    if (!id) {
      process.stderr.write("op plugin invoke: id required\n");
      return 2;
    }
    const input = JSON.parse(json) as Record<string, unknown>;
    printJson(await op.plugins.invoke(id, { input }));
    return 0;
  }
  process.stderr.write("op plugin: unknown sub-command\n");
  return 2;
}

async function cmdEvents(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const op = makeClient(args.flags);
  if (sub === "tail") {
    const ctrl = new AbortController();
    process.once("SIGINT", () => ctrl.abort());
    const type = args.flags.type as string | undefined;
    for await (const ev of op.events.stream({
      signal: ctrl.signal,
      pollIntervalMs: 1_000,
      ...(type ? { type: type as never } : {}),
    })) {
      printJson(ev);
    }
    return 0;
  }
  printJson(await op.events.recent());
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.positional[0];
  if (!cmd || cmd === "help" || args.flags.help) {
    // eslint-disable-next-line no-console
    process.stdout.write(`${usage()}\n`);
    return cmd ? 0 : 0;
  }
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(args);
      case "status":
        return await cmdStatus(args);
      case "skill":
        return await cmdSkill(args);
      case "plugin":
        return await cmdPlugin(args);
      case "events":
        return await cmdEvents(args);
      default:
        process.stderr.write(`Unknown command: ${cmd}\n${usage()}\n`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`op ${cmd}: ${(e as Error).message}\n`);
    return 1;
  }
}

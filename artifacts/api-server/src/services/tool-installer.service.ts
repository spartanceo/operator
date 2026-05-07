/**
 * Tool installer service — manages background installs for local tools
 * (SearXNG via Docker, ComfyUI via portable git+pip release).
 *
 * State is scoped per tenant so one operator's install job cannot
 * interfere with another's (critical for multi-tenant deployments).
 *
 * Each job runs in the background; callers poll the status endpoint.
 * State is in-memory and resets on process restart — acceptable for
 * single-session installs that complete before the server cycles.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

export type ToolId = "searxng" | "comfyui";

export type InstallPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "running"
  | "ready"
  | "failed";

export interface ToolInstallState {
  toolId: ToolId;
  phase: InstallPhase;
  message: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
}

interface SearXNGConfig {
  kind: "docker";
  name: string;
  image: string;
  port: number;
}

interface ComfyUIConfig {
  kind: "portable";
  name: string;
  port: number;
  installDir: string;
  repoUrl: string;
}

type ToolConfig = SearXNGConfig | ComfyUIConfig;

const COMFYUI_DIR = join(homedir(), ".omninity", "comfyui");

const TOOL_CONFIGS: Record<ToolId, ToolConfig> = {
  searxng: {
    kind: "docker",
    name: "SearXNG",
    image: "searxng/searxng",
    port: 8080,
  },
  comfyui: {
    kind: "portable",
    name: "ComfyUI",
    port: 8188,
    installDir: COMFYUI_DIR,
    repoUrl: "https://github.com/comfyanonymous/ComfyUI.git",
  },
};

// tier-review: bounded — keyed by `${tenantId}:${toolId}`; max 2 entries per tenant (toolId is a 2-value enum). Evicted on server restart.
const STATE = new Map<string, ToolInstallState>();

/**
 * Resolved Docker binary path — persisted across calls so all subsequent
 * Docker commands use the same known-good path directly instead of PATH lookup.
 * null means not yet resolved; empty string means not found.
 */
let resolvedDockerBin: string | null = null;

/**
 * Known locations where Docker Desktop installs its binary on macOS and Linux.
 * Checked in order; first successful exec wins.
 */
const DOCKER_SEARCH_PATHS = [
  "docker", // inherited PATH — works on most Linux setups and CI
  "/usr/local/bin/docker", // Homebrew / Docker Desktop on Intel Mac
  "/opt/homebrew/bin/docker", // Homebrew on Apple Silicon Mac
  "/usr/bin/docker", // common Linux package install path
  "/Applications/Docker.app/Contents/Resources/bin/docker", // Docker Desktop app bundle (macOS)
];

/** Secondary signal: if the Docker socket exists the daemon is running. */
const DOCKER_SOCKET = "/var/run/docker.sock";

function stateKey(tenantId: string, toolId: ToolId): string {
  return `${tenantId}:${toolId}`;
}

function makeState(
  toolId: ToolId,
  phase: InstallPhase,
  message: string,
  extras?: Partial<ToolInstallState>,
): ToolInstallState {
  return {
    toolId,
    phase,
    message,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    ...extras,
  };
}

export function getInstallState(tenantId: string, toolId: ToolId): ToolInstallState {
  return STATE.get(stateKey(tenantId, toolId)) ?? makeState(toolId, "idle", "Not started");
}

export interface DockerStatus {
  available: boolean;
  version: string | null;
}

/**
 * Probe each known Docker binary location in order.
 * Returns the resolved path + version on first success.
 * Falls back to checking the Docker socket as a secondary signal.
 * Persists the resolved path in `resolvedDockerBin` so subsequent
 * Docker commands use it directly.
 */
export async function checkDockerAvailable(): Promise<DockerStatus> {
  // Return cached result if already resolved
  if (resolvedDockerBin !== null) {
    if (resolvedDockerBin === "") {
      return { available: false, version: null };
    }
    try {
      const { stdout } = await execAsync(`"${resolvedDockerBin}" --version`, { timeout: 5000 });
      return { available: true, version: stdout.trim() };
    } catch {
      // cached path is no longer valid — re-probe
      resolvedDockerBin = null;
    }
  }

  for (const candidate of DOCKER_SEARCH_PATHS) {
    try {
      const cmd = candidate.includes(" ") ? `"${candidate}" --version` : `${candidate} --version`;
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      resolvedDockerBin = candidate;
      return { available: true, version: stdout.trim() };
    } catch {
      // this path didn't work — try next
    }
  }

  // Secondary signal: Docker socket implies daemon is running even if binary
  // is not on any of the probed paths (e.g. rootless Docker on Linux).
  if (existsSync(DOCKER_SOCKET)) {
    // We know Docker is running but couldn't resolve the binary path.
    // Mark as available; commands will attempt to use PATH-resolved "docker".
    resolvedDockerBin = "docker";
    return { available: true, version: null };
  }

  // Nothing found
  resolvedDockerBin = "";
  return { available: false, version: null };
}

/**
 * Build exec options that include the resolved Docker binary directory in
 * PATH so all child processes spawned for Docker commands find the binary.
 */
function dockerExecOptions(timeoutMs: number): Parameters<typeof execAsync>[1] {
  const bin = resolvedDockerBin && resolvedDockerBin !== "" ? resolvedDockerBin : "docker";
  const binDir = bin.includes("/") ? bin.substring(0, bin.lastIndexOf("/")) : "";
  const extraPath = binDir ? `${binDir}:` : "";
  return {
    timeout: timeoutMs,
    env: {
      ...process.env,
      PATH: `${extraPath}${process.env.PATH ?? ""}`,
    },
  };
}

/** Resolve the docker binary to use for commands (full path if known). */
function dockerBin(): string {
  if (resolvedDockerBin && resolvedDockerBin !== "") {
    return resolvedDockerBin.includes(" ") ? `"${resolvedDockerBin}"` : resolvedDockerBin;
  }
  return "docker";
}

/** Check if the tool is already listening on its expected port. */
export async function isToolRunning(toolId: ToolId): Promise<boolean> {
  const cfg = TOOL_CONFIGS[toolId];
  // For Docker-based tools, first check the container status
  if (cfg.kind === "docker") {
    try {
      const containerName = `omninity-${toolId}`;
      const { stdout } = await execAsync(
        `${dockerBin()} ps --filter "name=${containerName}" --filter "status=running" --format "{{.Names}}"`,
        dockerExecOptions(5000),
      );
      if (stdout.includes(containerName)) return true;
    } catch {
      // docker not available — fall through to port probe
    }
  }
  // Port probe: works for both Docker and portable installs
  try {
    const { createConnection } = await import("node:net");
    return await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port: cfg.port, host: "127.0.0.1" });
      sock.setTimeout(1500);
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

/**
 * Start an install job for the given tool scoped to the given tenant.
 * Returns the current state immediately; the install runs in the background.
 */
export function startInstallJob(tenantId: string, toolId: ToolId): ToolInstallState {
  const key = stateKey(tenantId, toolId);
  const existing = STATE.get(key);
  if (existing && (existing.phase === "downloading" || existing.phase === "running")) {
    return existing;
  }
  if (existing && existing.phase === "ready") {
    return existing;
  }

  const cfg = TOOL_CONFIGS[toolId];
  const initial = makeState(
    toolId,
    "checking",
    cfg.kind === "docker" ? "Checking for Docker…" : "Checking for Python…",
    { startedAt: new Date().toISOString() },
  );
  STATE.set(key, initial);

  void runInstallBackground(tenantId, toolId, cfg);
  return initial;
}

function setState(
  tenantId: string,
  toolId: ToolId,
  phase: InstallPhase,
  message: string,
  extras?: Partial<ToolInstallState>,
): void {
  const key = stateKey(tenantId, toolId);
  const prev = STATE.get(key) ?? makeState(toolId, phase, message);
  STATE.set(key, { ...prev, phase, message, ...extras });
}

async function runInstallBackground(
  tenantId: string,
  toolId: ToolId,
  cfg: ToolConfig,
): Promise<void> {
  const set = (phase: InstallPhase, message: string, extras?: Partial<ToolInstallState>) =>
    setState(tenantId, toolId, phase, message, extras);

  try {
    if (cfg.kind === "docker") {
      await installViaDocker(tenantId, toolId, cfg, set);
    } else {
      await installViaPortable(tenantId, toolId, cfg, set);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    set("failed", `Install failed: ${msg}`, {
      errorCode: "INSTALL_ERROR",
      completedAt: new Date().toISOString(),
    });
  }
}

async function installViaDocker(
  _tenantId: string,
  toolId: ToolId,
  cfg: SearXNGConfig,
  set: (phase: InstallPhase, message: string, extras?: Partial<ToolInstallState>) => void,
): Promise<void> {
  // 1. Check Docker
  const docker = await checkDockerAvailable();
  if (!docker.available) {
    set("failed", "Docker is not installed on this machine.", {
      errorCode: "DOCKER_REQUIRED",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // 2. Check if already running
  set("checking", `Checking if ${cfg.name} is already running…`);
  if (await isToolRunning(toolId)) {
    set("ready", `${cfg.name} is already running — connected.`, {
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // 3. Remove stopped container with same name (idempotent)
  set("downloading", `Pulling ${cfg.name} image (${cfg.image})…`);
  try {
    await execAsync(`${dockerBin()} rm -f omninity-${toolId}`, dockerExecOptions(10_000));
  } catch {
    // container didn't exist — that's fine
  }

  // 4. Pull image
  await execAsync(`${dockerBin()} pull ${cfg.image}`, dockerExecOptions(5 * 60_000));

  // 5. Start container with JSON format enabled so the /search?format=json
  //    endpoint is accepted by SearXNG (required for the health probe and
  //    the web_search tool).  The env var is the idiomatic SearXNG way to
  //    override settings.yml without building a custom image.
  set("running", `Starting ${cfg.name}…`);
  await execAsync(
    `${dockerBin()} run -d --name omninity-${toolId} -p ${cfg.port}:${cfg.port} --restart unless-stopped -e "SEARXNG_SETTINGS_SEARCH__FORMATS=[html,json]" ${cfg.image}`,
    dockerExecOptions(30_000),
  );

  // 6. Wait for port (up to 30 s)
  await waitForPort(toolId, cfg.port, cfg.name, set);
}

/**
 * Patch a requirements.txt to comment out known-bad packages that are not on
 * PyPI, then write the result to a temp file. Returns the temp file path.
 *
 * The only currently known bad package is `comfy-kitchen` which is a private
 * ComfyUI meta-package that blocks pip and is safe to skip. We comment it out
 * rather than delete it so the patch is clearly visible in the temp file.
 *
 * This replaces the old `filterResolvablePipLines` approach which ran
 * `pip3 download --no-deps` for every line sequentially (5–15 min total).
 * The patched approach takes 2–4 min for a single `pip3 install -r`.
 */
async function patchComfyRequirements(reqFile: string): Promise<string> {
  const raw = await readFile(reqFile, "utf8");
  const patched = raw
    .split("\n")
    .map((line) =>
      /^\s*comfy[-_]kitchen/i.test(line) && !line.trim().startsWith("#")
        ? `# [omninity-skipped] ${line}`
        : line,
    )
    .join("\n");
  const tmpPath = join(tmpdir(), `omninity-comfyui-req-${Date.now()}.txt`);
  await writeFile(tmpPath, patched, "utf8");
  return tmpPath;
}

async function installViaPortable(
  _tenantId: string,
  toolId: ToolId,
  cfg: ComfyUIConfig,
  set: (phase: InstallPhase, message: string, extras?: Partial<ToolInstallState>) => void,
): Promise<void> {
  // 1. Check if already running (someone started it manually)
  set("checking", `Checking if ${cfg.name} is already running on port ${cfg.port}…`);
  if (await isToolRunning(toolId)) {
    set("ready", `${cfg.name} is already running — connected.`, {
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // 2. Check Python 3
  set("checking", "Checking for Python 3…");
  try {
    await execAsync("python3 --version", { timeout: 5000 });
  } catch {
    set("failed", "Python 3 is required to install ComfyUI. Install Python 3.10+ and try again.", {
      errorCode: "PYTHON_REQUIRED",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // 3. Clone repo if not already present
  set("downloading", `Downloading ${cfg.name} from GitHub…`);
  const mainPy = join(cfg.installDir, "main.py");
  if (!existsSync(mainPy)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cfg.installDir, ".."), { recursive: true });
    await execAsync(
      `git clone --depth 1 "${cfg.repoUrl}" "${cfg.installDir}"`,
      { timeout: 3 * 60_000 },
    );
  }

  // 4. Patch requirements.txt (comment out comfy-kitchen) then pip install.
  // A single pip install -r is 2–4 min vs the old per-package probe (5–15 min).
  set("downloading", `Installing ${cfg.name} dependencies (pip)…`);
  const reqFile = join(cfg.installDir, "requirements.txt");
  const patchedReqFile = await patchComfyRequirements(reqFile);
  try {
    await execAsync(
      `pip3 install -q -r "${patchedReqFile}" --ignore-requires-python`,
      { timeout: 5 * 60_000, cwd: cfg.installDir },
    );
  } finally {
    await rm(patchedReqFile, { force: true }).catch(() => undefined);
  }

  // 5. Launch ComfyUI in the background
  set("running", `Starting ${cfg.name} on port ${cfg.port}…`);
  // Use nohup so the process survives if the parent exits
  exec(
    `nohup python3 "${mainPy}" --listen 127.0.0.1 --port ${cfg.port} > /tmp/comfyui.log 2>&1 &`,
    { cwd: cfg.installDir },
  );

  // 6. Wait for port
  await waitForPort(toolId, cfg.port, cfg.name, set);
}

async function waitForPort(
  toolId: ToolId,
  port: number,
  name: string,
  set: (phase: InstallPhase, message: string, extras?: Partial<ToolInstallState>) => void,
): Promise<void> {
  set("running", `Waiting for ${name} to become reachable on port ${port}…`);
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await isToolRunning(toolId);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (ready) {
    set("ready", `${name} is running — connected.`, {
      completedAt: new Date().toISOString(),
    });
  } else {
    // Surface the last 25 lines of the ComfyUI log so the user can see why
    // the process failed (bad PyTorch version, missing dependency, import error).
    let logTail = "";
    try {
      const logContent = await readFile("/tmp/comfyui.log", "utf8");
      const lines = logContent.trimEnd().split("\n");
      const tail = lines.slice(-25);
      logTail = `\n\nLast log lines:\n${tail.join("\n")}`;
    } catch {
      /* log file may not exist if the process never started */
    }
    set(
      "failed",
      `${name} started but did not become reachable on port ${port} within 180 s.${logTail}`,
      { errorCode: "TIMEOUT", completedAt: new Date().toISOString() },
    );
  }
}

/** Reset a failed/idle job so the user can retry. */
export function resetInstallJob(tenantId: string, toolId: ToolId): ToolInstallState {
  const state = makeState(toolId, "idle", "Not started");
  STATE.set(stateKey(tenantId, toolId), state);
  return state;
}

/**
 * Repair a running container by force-removing it and re-installing with
 * the correct settings (e.g. JSON format enabled for SearXNG).
 *
 * Use this when the tool is "ready" (reachable on port) but health probes
 * reveal misconfiguration — e.g. SearXNG installed without JSON enabled.
 * Returns immediately; the repair runs in the background.
 */
export function repairContainer(tenantId: string, toolId: ToolId): ToolInstallState {
  const cfg = TOOL_CONFIGS[toolId];
  const key = stateKey(tenantId, toolId);
  const initial = makeState(
    toolId,
    "checking",
    cfg.kind === "docker" ? `Stopping ${cfg.name} for repair…` : "Checking for Python…",
    { startedAt: new Date().toISOString() },
  );
  STATE.set(key, initial);

  const set = (phase: InstallPhase, message: string, extras?: Partial<ToolInstallState>) =>
    setState(tenantId, toolId, phase, message, extras);

  void (async () => {
    try {
      if (cfg.kind === "docker") {
        // Force-remove the existing container so isToolRunning() returns false
        // and the subsequent installViaDocker call uses the corrected docker
        // run command (with JSON format env var).
        try {
          await execAsync(
            `${dockerBin()} rm -f omninity-${toolId}`,
            dockerExecOptions(15_000),
          );
        } catch {
          // container didn't exist — fine
        }
      }
      await runInstallBackground(tenantId, toolId, cfg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set("failed", `Repair failed: ${msg}`, {
        errorCode: "REPAIR_ERROR",
        completedAt: new Date().toISOString(),
      });
    }
  })();

  return initial;
}

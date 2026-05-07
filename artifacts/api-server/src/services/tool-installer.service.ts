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

export async function checkDockerAvailable(): Promise<DockerStatus> {
  try {
    const { stdout } = await execAsync("docker --version", { timeout: 5000 });
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false, version: null };
  }
}

/** Check if the tool is already listening on its expected port. */
export async function isToolRunning(toolId: ToolId): Promise<boolean> {
  const cfg = TOOL_CONFIGS[toolId];
  // For Docker-based tools, first check the container status
  if (cfg.kind === "docker") {
    try {
      const containerName = `omninity-${toolId}`;
      const { stdout } = await execAsync(
        `docker ps --filter "name=${containerName}" --filter "status=running" --format "{{.Names}}"`,
        { timeout: 5000 },
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
    await execAsync(`docker rm -f omninity-${toolId}`, { timeout: 10_000 });
  } catch {
    // container didn't exist — that's fine
  }

  // 4. Pull image
  await execAsync(`docker pull ${cfg.image}`, { timeout: 5 * 60_000 });

  // 5. Start container
  set("running", `Starting ${cfg.name}…`);
  await execAsync(
    `docker run -d --name omninity-${toolId} -p ${cfg.port}:${cfg.port} --restart unless-stopped ${cfg.image}`,
    { timeout: 30_000 },
  );

  // 6. Wait for port (up to 30 s)
  await waitForPort(toolId, cfg.port, cfg.name, set);
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
  const { existsSync } = await import("node:fs");
  const mainPy = join(cfg.installDir, "main.py");
  if (!existsSync(mainPy)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cfg.installDir, ".."), { recursive: true });
    await execAsync(
      `git clone --depth 1 "${cfg.repoUrl}" "${cfg.installDir}"`,
      { timeout: 3 * 60_000 },
    );
  }

  // 4. Install Python requirements
  set("downloading", `Installing ${cfg.name} dependencies (pip)…`);
  const reqFile = join(cfg.installDir, "requirements.txt");
  await execAsync(
    `pip3 install -q -r "${reqFile}"`,
    { timeout: 5 * 60_000, cwd: cfg.installDir },
  );

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
  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await isToolRunning(toolId);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (ready) {
    set("ready", `${name} is running — connected.`, {
      completedAt: new Date().toISOString(),
    });
  } else {
    set(
      "failed",
      `${name} started but did not become reachable on port ${port} within 45 s. Check the logs for details.`,
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

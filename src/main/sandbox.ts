/**
 * gVisor sandbox wrapper for agent spawns (Phase 1 of the sandboxing plan).
 *
 * Every agent CLI normally runs as a direct host child with its permission
 * checks bypassed (autoMode) and the full shell environment inherited — which
 * makes the host exactly one prompt-injection away from the agent. This module
 * rewrites an assembled spawn into `docker run --runtime runsc` on the
 * `sandbox-net` internal network (no route out; a Squid allowlist proxy is the
 * only egress), with PARITY bind mounts — the same absolute path on both sides
 * of the boundary — because the hive contract injects host-absolute paths into
 * every agent prompt, and an ENV ALLOWLIST built from zero, so a credential in
 * the operator's shell can never leak into an agent again.
 *
 * Deliberately import-free of the rest of main (config/pty/hive): the caller
 * passes everything in, `buildSandboxArgs` stays pure, and the unit test can
 * transpile this one file in isolation.
 *
 * Phase-1 scope: worker agents only. The hooks-socket passthrough, per-agent
 * home volumes, loopback (OTel/broker/proxy-sidecar) rebinding and the god
 * profile are Phase 2 — sandboxed agents run WITHOUT the Stop-hook autonomy
 * loop and telemetry until then (detect-and-degrade, the house style).
 */
import { spawnSync } from 'node:child_process';

/** Everything buildSandboxArgs needs, resolved by the caller. */
export interface SandboxSpawnInput {
  id: string;
  /** The real engine command + args the container should run. */
  command: string;
  args: string[];
  cwd: string;
  /** The per-agent env assembled by spawnAgentCore (hive identity, scoped
   *  credential, provider config). ONLY allowlisted keys cross the boundary. */
  env: Record<string, string>;
  /** Container image (HarnessConfig.sandboxImage; default 'eval-sandbox'). */
  image: string;
  /** name → IP pins for sandbox-net peers. Under runsc, Docker's embedded DNS
   *  (127.0.0.11) is unreachable from gVisor's netstack, so container names
   *  never resolve — every peer must ride --add-host (same as run-sandbox.sh). */
  addHosts: Record<string, string>;
  /** Phase 2 — persistent per-agent container home, bind-mounted at /home/agent.
   *  Seeded (for claude) with login + onboarding + trust so an interactive worker
   *  skips the first-run screens; also carries transcripts / --resume across
   *  respawns. Omit for an ephemeral home (image default). */
  home?: string;
  /** Egress proxy URL as seen from inside sandbox-net. */
  proxyUrl?: string;
  network?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Phase 2 — hooks.sock passthrough: bind-mount the hive's UDS at its parity
   *  path and let HIVE_SOCK cross, restoring the Stop-hook autonomy loop.
   *  gVisor only opens host sockets under --host-uds=open, so pass
   *  runtime: 'runsc-uds' alongside (agent-sandbox setup/05). */
  hiveSock?: string;
  /** Docker runtime name (default 'runsc'). */
  runtime?: string;
  /** God profile: the orchestrator's cwd IS the harness home (which contains the
   *  hive), and it is the hive scribe — so it needs the hive WRITABLE, not the
   *  worker's read-only single-writer boundary. When set, the ro hive / agent-dir
   *  / spawn-requests mounts are skipped; the cwd rw mount already covers them. */
  hiveWritable?: boolean;
}

const DEFAULT_PROXY = 'http://squid:3128';
const DEFAULT_NETWORK = 'sandbox-net';

/** Env keys copied verbatim from the assembled per-agent env when present.
 *  Everything else — including the entire inherited process.env that unsandboxed
 *  spawns still receive via buildPtyEnv — is deliberately dropped. */
const ENV_PASSTHROUGH = [
  // Hive identity (paths are parity-mounted, so the values stay correct inside).
  'AGENT_ID', 'AGENT_NAME', 'HIVE_ROOT', 'AGENT_DIR', 'HIVE_NODE',
  'MD_BROKER_SOCKET', 'MD_BROKER_TOKEN_FILE',
  // Terminal/locale hints the TUIs read.
  'TERM', 'LANG', 'LC_CTYPE', 'COLORTERM', 'FORCE_COLOR', 'COLORFGBG',
  // The ONE scoped credential spawnAgentCore computed for this engine.
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  // Per-engine config-dir isolation + non-interactive posture (values under
  // AGENT_DIR are parity-mounted rw; content vars carry no paths).
  'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG_DIR',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'CRUSH_GLOBAL_CONFIG', 'CRUSH_GLOBAL_DATA',
  'OPENCODE_CONFIG_CONTENT', 'CODEX_NON_INTERACTIVE', 'HIVE_AUTO_APPROVE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
] as const;

/** Deterministic container name for a pty id, so kill/health/respawn paths can
 *  always re-derive it. Docker names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*; the
 *  'md-' prefix supplies the leading alnum and the id is sanitized + capped. */
export function containerNameFor(id: string): string {
  const seg = id.replace(/[^A-Za-z0-9_.-]/g, '-');
  return `md-${seg}`.slice(0, 63);
}

/** PURE: rewrite an assembled agent spawn into its `docker run` equivalent. */
export function buildSandboxArgs(input: SandboxSpawnInput): { command: string; args: string[]; containerName: string } {
  const containerName = containerNameFor(input.id);
  const proxy = input.proxyUrl ?? DEFAULT_PROXY;
  const args: string[] = [
    'run', '--rm',
    // node-pty gives the docker CLIENT a real TTY; -it hands it through so the
    // engine TUI renders and the byte-flow idle heuristics keep working. --init
    // gives the container a real PID 1 so signals/zombies behave (bash-as-PID-1
    // ignores SIGTERM — the classic outlive-the-client bug).
    '-i', '-t', '--init',
    '--name', containerName,
    '--runtime', input.runtime ?? 'runsc',
    '--network', input.network ?? DEFAULT_NETWORK,
    // Same ceilings as run-sandbox.sh.
    '--memory', input.memory ?? '8g',
    '--cpus', input.cpus ?? '2',
    '--pids-limit', String(input.pidsLimit ?? 4096)
  ];
  for (const [host, ip] of Object.entries(input.addHosts)) {
    args.push('--add-host', `${host}:${ip}`);
  }
  // ── Parity bind mounts — container path === host path, or every host-absolute
  // path in the injected prompt/hook config is a lie inside the container. Docker
  // applies binds ordered by destination depth, so the rw mounts nest over the ro
  // hive root. Mounting ONLY the agent's own dir rw turns the hive's
  // single-writer-per-file convention into a boundary the agent cannot violate.
  // Persistent per-agent home (login/onboarding/transcripts). Distinct subtree
  // from cwd and the hive, so mount order is irrelevant.
  if (input.home) args.push('-v', `${input.home}:/home/agent`);
  args.push('-v', `${input.cwd}:${input.cwd}`);
  // Start the engine IN the parity-mounted cwd — the image's default WORKDIR
  // (/work) is not the agent's project dir.
  args.push('-w', input.cwd);
  const hiveRoot = input.env.HIVE_ROOT;
  const agentDir = input.env.AGENT_DIR;
  // hiveWritable (god): cwd == harnessHome already covers the hive rw, so skip the
  // ro nesting. A worker's cwd is a project dir NOT containing the hive, so it
  // needs these — including the ro root that makes single-writer-per-file a hard
  // boundary the worker cannot cross.
  if (hiveRoot && !input.hiveWritable) {
    args.push('-v', `${hiveRoot}:${hiveRoot}:ro`);
    args.push('-v', `${hiveRoot}/spawn-requests:${hiveRoot}/spawn-requests`);
    if (agentDir) args.push('-v', `${agentDir}:${agentDir}`);
  }
  // Phase 2 — the Stop-hook loop. Deliberately NO mount of the socket file:
  // bind-mounting a host UNIX SOCKET makes runsc fail to start the sandbox
  // ("cannot read client sync file: EOF", verified live). The socket already
  // rides the hive-root ro parity mount above, and under --host-uds=open
  // (the runsc-uds runtime) connect() works through a read-only gofer mount —
  // while plain runsc refuses it, which is why the default runtime stays
  // locked down. Only pass the env var when the socket actually lives under
  // the mounted hive root; anywhere else it would dangle unreachable.
  if (input.hiveSock && hiveRoot && input.hiveSock.startsWith(`${hiveRoot}/`)) {
    args.push('-e', `HIVE_SOCK=${input.hiveSock}`);
  }
  // ── Per-agent broker socket (phase-2 gaps plan): mount the socket's PARENT
  // DIRECTORY read-only at its parity path — never the socket file itself (a
  // file mount pins the inode; a broker rebind would strand the container on a
  // dead socket). The dir holds broker.sock + the 0600 .token file and is
  // created per-run with a nonce, so this mount is the ONLY way any container
  // can reach — or even name — this worker's endpoint. Requires runsc-uds.
  const brokerSock = input.env.MD_BROKER_SOCKET;
  if (brokerSock && brokerSock.startsWith('/') && brokerSock.includes('/')) {
    const sockDir = brokerSock.slice(0, brokerSock.lastIndexOf('/'));
    args.push('-v', `${sockDir}:${sockDir}:ro`);
  }
  // ── Env from ZERO: the allowlist + the proxy posture. Nothing inherited.
  for (const key of ENV_PASSTHROUGH) {
    const v = input.env[key];
    if (typeof v === 'string' && v !== '') args.push('-e', `${key}=${v}`);
  }
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    args.push('-e', `${k}=${proxy}`);
  }
  args.push('-e', `NO_PROXY=localhost,127.0.0.1,${Object.keys(input.addHosts).join(',') || 'squid'}`);
  // Unambiguous "you are inside the agent sandbox" marker. The hive-node shim
  // keys on it (fall back to PATH node even if a host Electron path happens to
  // be visible through a mount), and future in-container tooling can too.
  args.push('-e', 'MD_SANDBOX=1');
  args.push(input.image, input.command, ...input.args);
  return { command: 'docker', args, containerName };
}

// ── Host-side probes (cached: each is a synchronous docker exec ~50-150ms) ────

let availabilityCache: { ok: boolean; reason?: string } | null = null;
const imageCache = new Map<string, boolean>();

/** For tests / a user who just finished setup without restarting the app. */
export function resetSandboxCaches(): void {
  availabilityCache = null;
  imageCache.clear();
  udsRuntimeCache = undefined;
}

function dockerOk(dockerArgs: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync('docker', dockerArgs, { encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return { status: null, stdout: '', stderr: '' };
  }
}

/** Is the agent-sandbox infra usable from this host? Linux-only (gVisor), needs
 *  the docker CLI, the runsc runtime registered, and the sandbox-net internal
 *  network built (agent-sandbox setup/01 + setup/03). Cached for the process —
 *  the answer only changes when an operator runs setup, and resetSandboxCaches
 *  covers that. Never throws; a missing piece degrades to {ok:false, reason}. */
export function sandboxAvailable(): { ok: boolean; reason?: string } {
  if (availabilityCache) return availabilityCache;
  const fail = (reason: string): { ok: boolean; reason: string } => (availabilityCache = { ok: false, reason });
  if (process.platform !== 'linux') return fail(`gVisor sandboxing is Linux/WSL-only (platform: ${process.platform})`);
  const version = dockerOk(['--version']);
  if (version.status !== 0) return fail('docker CLI not found on PATH');
  const runtimes = dockerOk(['info', '--format', '{{json .Runtimes}}']);
  if (runtimes.status !== 0 || !runtimes.stdout.includes('runsc')) {
    return fail('runsc runtime not registered with docker (agent-sandbox setup/01)');
  }
  const net = dockerOk(['network', 'inspect', DEFAULT_NETWORK, '--format', '{{.Internal}}']);
  if (net.status !== 0) return fail(`docker network "${DEFAULT_NETWORK}" not found (agent-sandbox setup/03)`);
  availabilityCache = { ok: true };
  return availabilityCache;
}

/** Does the sandbox image exist locally? Cached per name (a spawn-time probe;
 *  an image the operator just rebuilt keeps its name, so staleness is benign). */
export function sandboxImageAvailable(image: string): boolean {
  const cached = imageCache.get(image);
  if (cached !== undefined) return cached;
  const ok = dockerOk(['image', 'inspect', image]).status === 0;
  // Cache only positives: a user mid-setup shouldn't need an app restart for
  // the image to be seen once built.
  if (ok) imageCache.set(image, ok);
  return ok;
}

const UDS_RUNTIME = 'runsc-uds';
let udsRuntimeCache: boolean | undefined;

/** Is the socket-passthrough runtime (runsc --host-uds=open) registered?
 *  Positive-only cache — an operator who runs setup/05 mid-session shouldn't
 *  need an app restart for the Stop-hook loop to start riding along. */
export function sandboxUdsRuntimeAvailable(): boolean {
  if (udsRuntimeCache) return true;
  const r = dockerOk(['info', '--format', '{{json .Runtimes}}']);
  const ok = r.status === 0 && r.stdout.includes(UDS_RUNTIME);
  if (ok) udsRuntimeCache = true;
  return ok;
}

/** Pin sandbox-net peer IPs for --add-host (squid + optional relay services),
 *  mirroring run-sandbox.sh: peers that aren't running are skipped silently.
 *  `lemonade` is the local-LLM relay (agent-sandbox setup/06); pinning it lets a
 *  sandboxed opencode worker reach http://lemonade:13305 for `local/*` models, and
 *  it lands in NO_PROXY (below) so that internal call skips squid. */
export async function resolveSandboxHosts(): Promise<Record<string, string>> {
  const hosts: Record<string, string> = {};
  for (const name of ['squid', 'lemonade', 'service-a', 'service-b']) {
    const r = dockerOk(['inspect', '-f', `{{(index .NetworkSettings.Networks "${DEFAULT_NETWORK}").IPAddress}}`, name]);
    const ip = r.stdout.trim();
    if (r.status === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) hosts[name] = ip;
  }
  return hosts;
}

/** Force-remove a sandbox container. Fire-and-forget: the kill paths call this
 *  because SIGHUP/SIGKILL to the docker CLIENT does not stop the container —
 *  without it a "killed" agent keeps running with its rw mounts. Errors are
 *  swallowed (container already gone is the common, healthy case). */
export function dockerKillContainer(name: string): void {
  try {
    spawnSync('docker', ['rm', '-f', name], { timeout: 15_000, stdio: 'ignore' });
  } catch { /* already gone / docker unavailable — nothing to leak */ }
}

/** Liveness for a sandboxed session. `process.kill(pid, 0)` on the docker CLIENT
 *  says nothing about the agent, so the health check asks docker instead.
 *  Returns null when docker itself can't answer — callers must treat that as
 *  "unknown", never as dead (a false 'wedged' verdict triggers auto-revive). */
export function dockerContainerRunning(name: string): boolean | null {
  const r = dockerOk(['inspect', '-f', '{{.State.Running}}', name]);
  if (r.status !== 0) {
    // A --rm'd container that already died is genuinely GONE (not unknown) —
    // that's the wedged-client case the health check exists to catch. Anything
    // else (daemon down, timeout) is unknown.
    return /no such (object|container)/i.test(r.stderr) ? false : null;
  }
  const out = r.stdout.trim();
  return out === 'true' ? true : out === 'false' ? false : null;
}

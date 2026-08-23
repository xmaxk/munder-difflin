'use strict';
/**
 * sandbox.ts tests — prove the gVisor spawn wrapper (Phase 1) builds a
 * confining `docker run` argv: parity mounts, env-from-zero allowlist (a
 * poisoned host env var must never cross), deterministic container naming, and
 * resource ceilings. Self-contained, no framework — run with
 * `node test/sandbox-args.test.cjs` (mirrors test/proc-kill.test.cjs: the TS
 * source is transpiled directly, sandbox.ts has no local imports by design).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'sandbox.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-args-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'sandbox.js'), js, 'utf8');
const { buildSandboxArgs, containerNameFor, sandboxAvailable, dockerContainerRunning } =
  require(path.join(out, 'sandbox.js'));

// ── container naming: docker-safe, deterministic, injection-proof ────────────
{
  assert.strictEqual(containerNameFor('jim'), 'md-jim');
  // Path separators, spaces and shell metachars all flatten to '-'.
  assert.strictEqual(containerNameFor('a b/c$d'), 'md-a-b-c-d');
  // Long ids cap at docker's practical name length.
  assert.ok(containerNameFor('x'.repeat(200)).length <= 63);
  console.log('  ok  containerNameFor sanitizes + caps');
}

const input = {
  id: 'jim',
  command: 'claude',
  args: ['--model', 'claude-fable-5', '--permission-mode', 'bypassPermissions'],
  cwd: '/home/user/proj',
  env: {
    AGENT_ID: 'jim',
    AGENT_NAME: 'Jim',
    HIVE_ROOT: '/home/user/hive-home/hive',
    AGENT_DIR: '/home/user/hive-home/hive/agents/jim',
    ANTHROPIC_API_KEY: 'sk-ant-scoped',
    // Poison: things that live in a real opts.env / process.env but must NEVER
    // cross the boundary (the whole point of env-from-zero).
    AWS_SECRET_ACCESS_KEY: 'poison-aws',
    SSH_AUTH_SOCK: '/tmp/ssh-poison',
    MEMPALACE_PALACE_PATH: '/home/user/palace' // host path not mounted in Phase 1
  },
  image: 'eval-sandbox',
  addHosts: { squid: '172.19.0.2' }
};
const wrapped = buildSandboxArgs(input);

// ── shape: docker client + confinement flags ─────────────────────────────────
{
  assert.strictEqual(wrapped.command, 'docker');
  assert.strictEqual(wrapped.containerName, 'md-jim');
  const a = wrapped.args;
  assert.strictEqual(a[0], 'run');
  for (const flag of ['--rm', '-i', '-t', '--init']) assert.ok(a.includes(flag), `missing ${flag}`);
  const pairOf = (flag) => a[a.indexOf(flag) + 1];
  assert.strictEqual(pairOf('--runtime'), 'runsc');
  assert.strictEqual(pairOf('--network'), 'sandbox-net');
  assert.strictEqual(pairOf('--name'), 'md-jim');
  assert.strictEqual(pairOf('--memory'), '8g');
  assert.strictEqual(pairOf('--cpus'), '2');
  assert.strictEqual(pairOf('--pids-limit'), '4096');
  assert.ok(a.includes('--add-host') && a.includes('squid:172.19.0.2'));
  console.log('  ok  runsc + sandbox-net + ceilings + --add-host pins');
}

// ── parity mounts: same path both sides; hive ro with agent dir rw nested ────
{
  const mounts = wrapped.args.flatMap((v, i) => (v === '-v' ? [wrapped.args[i + 1]] : []));
  assert.ok(mounts.includes('/home/user/proj:/home/user/proj'), 'cwd parity mount');
  assert.ok(mounts.includes('/home/user/hive-home/hive:/home/user/hive-home/hive:ro'), 'hive root ro');
  assert.ok(mounts.includes('/home/user/hive-home/hive/agents/jim:/home/user/hive-home/hive/agents/jim'), 'agent dir rw');
  assert.ok(mounts.includes('/home/user/hive-home/hive/spawn-requests:/home/user/hive-home/hive/spawn-requests'), 'spawn-requests rw');
  console.log('  ok  parity mounts (cwd rw, hive ro, own agent dir rw)');
}

// ── env-from-zero: allowlist in, poison out ──────────────────────────────────
{
  const envs = wrapped.args.flatMap((v, i) => (v === '-e' ? [wrapped.args[i + 1]] : []));
  assert.ok(envs.includes('AGENT_ID=jim'));
  assert.ok(envs.includes('ANTHROPIC_API_KEY=sk-ant-scoped'), 'scoped credential crosses');
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    assert.ok(envs.includes(`${k}=http://squid:3128`), `proxy var ${k}`);
  }
  assert.ok(envs.some((e) => e.startsWith('NO_PROXY=') && e.includes('squid')));
  const all = wrapped.args.join('\n');
  assert.ok(!all.includes('poison-aws'), 'AWS secret must not cross the boundary');
  assert.ok(!all.includes('ssh-poison'), 'SSH agent socket must not cross');
  assert.ok(!envs.some((e) => e.startsWith('MEMPALACE_')), 'unmounted host paths must not cross');
  console.log('  ok  env allowlist enforced — poisoned vars never cross');
}

// ── the real spawn rides LAST: image, command, then untouched argv ───────────
{
  const tail = wrapped.args.slice(-6);
  assert.deepStrictEqual(tail, [
    'eval-sandbox', 'claude', '--model', 'claude-fable-5', '--permission-mode', 'bypassPermissions'
  ]);
  console.log('  ok  image + engine argv appended last, order preserved');
}

// ── hive-less spawn (no HIVE_ROOT): only the cwd is mounted ──────────────────
{
  const bare = buildSandboxArgs({ ...input, env: { TERM: 'xterm-256color' } });
  const mounts = bare.args.flatMap((v, i) => (v === '-v' ? [bare.args[i + 1]] : []));
  assert.deepStrictEqual(mounts, ['/home/user/proj:/home/user/proj']);
  console.log('  ok  hive-less spawn mounts only the cwd');
}

// ── probes degrade, never throw (shape only — environment-dependent) ─────────
{
  const avail = sandboxAvailable();
  assert.ok(typeof avail.ok === 'boolean');
  if (!avail.ok) assert.ok(typeof avail.reason === 'string' && avail.reason.length > 0);
  const running = dockerContainerRunning('md-definitely-not-a-container');
  assert.ok(running === false || running === null, 'missing container is false (or null sans docker)');
  console.log(`  ok  probes degrade cleanly (sandboxAvailable → ${avail.ok ? 'ok' : `unavailable: ${avail.reason}`})`);
}

// ── Phase 2: hooks.sock passthrough rides only with the uds runtime ──────────
{
  const sock = '/home/user/hive-home/hive/hooks.sock';
  const withSock = buildSandboxArgs({ ...input, hiveSock: sock, runtime: 'runsc-uds' });
  const a = withSock.args;
  assert.strictEqual(a[a.indexOf('--runtime') + 1], 'runsc-uds');
  const mounts = a.flatMap((v, i) => (v === '-v' ? [a[i + 1]] : []));
  // The socket must NOT get its own mount — bind-mounting a host unix socket
  // makes runsc fail to start; it rides the hive-root ro mount instead.
  assert.ok(!mounts.some((m) => m.includes('hooks.sock')), 'no socket file mount ever');
  const envs = a.flatMap((v, i) => (v === '-e' ? [a[i + 1]] : []));
  assert.ok(envs.includes(`HIVE_SOCK=${sock}`), 'HIVE_SOCK crosses via env');
  // A socket OUTSIDE the mounted hive root would dangle → env var withheld.
  const stray = buildSandboxArgs({ ...input, hiveSock: '/elsewhere/hooks.sock', runtime: 'runsc-uds' });
  assert.ok(!stray.args.some((x) => x.includes('/elsewhere/hooks.sock')), 'unreachable socket path withheld');
  console.log('  ok  hooks.sock: env + runsc-uds, no socket mount, stray paths withheld');
}

// ── without hiveSock: env HIVE_SOCK alone must not leak, mount, or re-runtime ─
{
  const sock = '/home/user/hive-home/hive/hooks.sock';
  const bare = buildSandboxArgs({ ...input, env: { ...input.env, HIVE_SOCK: sock } });
  const a = bare.args;
  assert.strictEqual(a[a.indexOf('--runtime') + 1], 'runsc', 'default runtime stays locked down');
  assert.ok(!a.some((x) => x.includes('hooks.sock')), 'HIVE_SOCK via env alone crosses nothing');
  console.log('  ok  no hiveSock input → locked-down default (env HIVE_SOCK ignored)');
}

console.log('sandbox-args: all assertions passed');

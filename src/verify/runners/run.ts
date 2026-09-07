import { execa } from 'execa';
import type { RunnerSpec } from '../types.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  retries?: number;
  onAttempt?: (attempt: number) => void;
  // Extra env vars merged over the redacted base. Used by mutation to force
  // fresh bytecode (PYTHONDONTWRITEBYTECODE), so a mutant is not masked by a
  // stale .pyc of the original from an earlier run.
  envAdd?: Record<string, string>;
}

/** Credentials that must not reach the verified suite.
 *
 *  The tests gate spawns the repository's OWN test suite - code supplied by the
 *  diff under verification - and it used to inherit the full parent
 *  environment. In the deployment this product is sold for, a CI gate verifying
 *  an untrusted pull request, that environment holds the credentials of the
 *  repository it is protecting. Reproduced before this existed: a test in the
 *  verified suite read REFACTRON_TOKEN, GITHUB_TOKEN, NPM_TOKEN and
 *  AWS_SECRET_ACCESS_KEY in plaintext.
 *
 *  A DENYLIST, not an allowlist. Real suites need HOME, PATH, LANG, VIRTUAL_ENV
 *  and a long tail of toolchain variables; an allowlist would break them and
 *  would be a support burden forever. This closes the credentials a verification
 *  run has no business forwarding, and is explicitly not a sandbox: running the
 *  suite is running the repository's code, which SECURITY.md states plainly. */
const DENIED_ENV_EXACT = new Set([
  'REFACTRON_TOKEN',
  'REFACTRON_API_BASE_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'PYPI_API_TOKEN',
  'TWINE_PASSWORD',
  'DOCKER_PASSWORD',
  'SLACK_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);

/** Legacy trailing-segment suffixes, kept as a cheap backstop under the broader
 *  segment rule below. */
const DENIED_ENV_SUFFIXES = ['_TOKEN', '_SECRET', '_API_KEY', '_PASSWORD', '_CREDENTIALS'];

/** A NAME segment (the name split on `_`) that marks the whole variable as a
 *  credential. SEGMENT match, not substring: it preserves `TOKENIZER` and
 *  `SECRETARY` as non-secret while catching the advisory-B vectors the old suffix
 *  list missed — `STRIPE_KEY` (`KEY`), `SESSION_COOKIE` (`SESSION`/`COOKIE`),
 *  `MY_COMPANY_SECRET_VALUE` (`SECRET`, the `_VALUE` that ended the suffix). */
const DENIED_NAME_SEGMENTS = new Set([
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'PW',
  'PWD',
  'PASSPHRASE',
  'TOKEN',
  'KEY',
  'APIKEY',
  'PRIVATEKEY',
  'SECRETKEY',
  'ACCESSKEY',
  'SIGNINGKEY',
  'CREDENTIAL',
  'CREDENTIALS',
  'COOKIE',
  'SESSION',
  'AUTH',
  'CERT',
  'PEM',
]);

/** Unambiguous provider credential prefixes (matched at the value start). */
const SECRET_VALUE_PREFIXES = [
  'sk_',
  'pk_live_',
  'rk_',
  'sk_live_',
  'sk_test_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxr-',
  'xoxs-',
  'dop_v1_',
  'doo_v1_',
  'dor_v1_',
  'npm_',
  'pypi-AgEI',
  'shpat_',
  'shpss_',
  'SG.',
  'hf_',
  'ya29.',
  'AIza',
  'eyJ', // JWT/JWE header ({"alg…} base64) — a bearer/session credential
  '$2a$', // bcrypt
  '$2b$',
  '$2y$',
  '$argon2', // argon2
];
const AWS_KEY_RE = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
// A credential carried in a URL query string (?password=…, &token=…). The
// conn-string rule only covers a user:pass@ authority; this covers the query form.
const QUERY_CRED_RE = /[?&](password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)=[^&\s]/i;
// scheme://…user:pass@… — a connection string carrying credentials. Fires ONLY on
// an embedded user:pass authority, so a plain https URL with no creds is kept.
const CONN_STRING_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i;

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True if the VALUE looks like a credential regardless of its name — the axis an
 *  attacker cannot rename around (the repo's real Stripe key looks like one
 *  however it is named). */
function valueLooksLikeSecret(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (SECRET_VALUE_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (AWS_KEY_RE.test(s)) return true;
  if (CONN_STRING_RE.test(s)) return true;
  if (QUERY_CRED_RE.test(s)) return true;
  if (s.includes('-----BEGIN')) return true;
  // High-entropy opaque blob: one wordless token, base64url/hex charset, length
  // >=32 and Shannon entropy >= 4.0 bits/char. The no-`[\s/:]` guard excludes PATH,
  // LS_COLORS, URLs and prose; the conn-string rule already owns `:`-bearing values.
  if (s.length >= 32 && !/[\s/:]/.test(s) && /^[A-Za-z0-9+/=_-]+$/.test(s) && shannonBits(s) >= 4.0)
    return true;
  // Standard base64 (RFC-4648, with `/`) that the guard above excludes — a
  // base64-encoded key/blob. A higher entropy floor (4.5) keeps `/`-bearing PATHs
  // and dictionary paths (entropy < ~4.1) out while catching real base64 secrets
  // (entropy ~5-6).
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(s) && shannonBits(s) >= 4.5) return true;
  return false;
}

function nameLooksLikeSecret(key: string): boolean {
  if (DENIED_ENV_EXACT.has(key)) return true;
  if (DENIED_ENV_SUFFIXES.some((suffix) => key.endsWith(suffix))) return true;
  for (const seg of key.toUpperCase().split('_')) if (DENIED_NAME_SEGMENTS.has(seg)) return true;
  return false;
}

/** Strip credentials from `env` before it reaches the verified suite. Matched
 *  three ways: the exact denylist, per-segment credential words in the NAME, and
 *  credential SHAPES in the VALUE (ADR-20). Fail-safe: a false positive only
 *  WITHHOLDS a variable, which can move a verdict toward UNPROVEN/UNSAFE but never
 *  toward a false SAFE, so imperfect matching is acceptable here in a way an
 *  undecidable verdict boundary would not be. `REFACTRON_FORWARD_ENV` (comma-
 *  separated names in the parent env) is the operator's opt-in un-redact hatch for
 *  a var they know is a non-secret; it is trusted on the same basis as the secrets
 *  themselves (it lives in the CI env, not the diff) and is never forwarded itself.
 *  Best-effort, NOT a sandbox (SECURITY.md): a value that is BOTH benignly named
 *  and benign-valued is undetectable — do not scope this env to hold secrets a
 *  verification run does not need. */
export function redactEnvForRunner(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const forward = new Set(
    (env.REFACTRON_FORWARD_ENV ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
  );
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'REFACTRON_FORWARD_ENV') continue;
    if (forward.has(key)) {
      out[key] = value;
      continue;
    }
    if (nameLooksLikeSecret(key)) continue;
    if (typeof value === 'string' && valueLooksLikeSecret(value)) continue;
    out[key] = value;
  }
  return out;
}

export async function runRunner(spec: RunnerSpec, opts: RunOptions = {}): Promise<RunResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let last: RunResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    opts.onAttempt?.(attempt);
    const t0 = Date.now();
    try {
      const r = await execa(spec.cmd, spec.args, {
        cwd: spec.cwd,
        timeout: spec.timeoutMs,
        reject: false,
        // extendEnv:false is load-bearing. execa MERGES `env` over process.env by
        // default, so passing a redacted copy changes nothing - execa puts every
        // secret straight back. The unit test on redactEnvForRunner passed while
        // the end-to-end probe still read every credential; only turning the
        // merge off actually removes them. The redacted copy already carries
        // PATH, HOME and the rest, so the child loses nothing it needs.
        extendEnv: false,
        env: { ...redactEnvForRunner(process.env), ...opts.envAdd, CI: '1' },
      });
      const elapsedMs = Date.now() - t0;
      // execa's r.timedOut field is unreliable across Node versions when
      // reject:false is set (notably Node 18 leaves it undefined even after
      // a real timeout fire). Derive timedOut from observable wall-clock:
      // if the process was killed by a signal AND the elapsed time has
      // reached the configured timeout, the timeout fired.
      const timedOut =
        r.timedOut === true || (typeof r.signal === 'string' && elapsedMs >= spec.timeoutMs);
      last = {
        exitCode: r.exitCode ?? 1,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut,
        durationMs: elapsedMs,
      };
      if (last.exitCode === 0 && !last.timedOut) return last;
    } catch (err) {
      const e = err as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
        message: string;
      };
      last = {
        exitCode: e.exitCode ?? 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message,
        timedOut: e.timedOut === true,
        durationMs: Date.now() - t0,
      };
    }
  }
  return last!;
}

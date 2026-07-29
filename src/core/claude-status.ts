/**
 * What each Claude Code environment on this machine has spent, and which account spent it.
 *
 * **The data has no supported pull interface. It is pushed, once, into a live session.**
 * Claude Code hands its status line command a JSON document carrying
 * `rate_limits.five_hour.{used_percentage,resets_at}` and `rate_limits.seven_day`
 * (https://code.claude.com/docs/en/statusline) — the source of the `5h:`/`7d:` segments an
 * operator already reads at the bottom of a session. Nothing requests it: `/status` and
 * `/usage` are interactive slash commands, the OpenTelemetry export carries no quota metric,
 * and `claude --help` has no usage subcommand.
 *
 * So the status line writes them down and the board reads them. That script belongs to the
 * operator already and is the one place the data lands; a few lines dump the windows, the
 * account and a timestamp. Documented data, and **no credential is handled** — the OAuth
 * token in `.credentials.json` is authentication material this repository has never touched
 * and does not start touching here.
 *
 * **A directory, not each home's own file.** `EXCALIDRAW_CLAUDE_STATUS` names one directory
 * on the host holding one file per environment — `native.json`, `wsl-<distro>.json`. The
 * alternative was to read `<that home>/.claude/…`, which for a distro means either guessing
 * at its `$HOME` through the UNC share or spawning a `wsl.exe` on every poll. A session
 * inside a distro can write to `/mnt/c/...` itself, so the crossing happens once, in the
 * operator's own script, in the environment that knows where it is.
 *
 * **The honest cost is freshness.** A file is only as fresh as the last session that wrote
 * it, and a percentage without its age reads as current when it is not — so every reading
 * carries how old it is, and one older than {@link STALE_AFTER_SECONDS} says so.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { WorkspaceEnvironment } from './workspace-paths.js';

/**
 * How old a reading may be before it is called stale.
 *
 * Ten minutes. A status line command re-runs while a session is being used, so a reading
 * this old means nobody has been in a session rather than that the figure moved slowly.
 * Shorter would flag a reader who stepped away for coffee; longer would let a morning's
 * figures pass for this afternoon's.
 */
export const STALE_AFTER_SECONDS = 600;

/** One rate-limit window, as the status line reports it. */
export interface RateWindow {
  /** 0 to 100. */
  usedPercent: number;
  /** Unix epoch seconds when the window resets, or null when the file did not say. */
  resetsAt: number | null;
}

/**
 * One environment's reading. Every field is independently nullable, and `null` is
 * "not said" rather than `0` — the distinction `agent-usage.ts` already draws.
 *
 * A window "appears only for Claude.ai subscribers (Pro/Max) after the first API response in
 * the session", each of the two independently, so an absent one is the normal case and not a
 * failure. Reporting it as `0%` would be a claim that nothing has been spent.
 */
export interface ClaudeEnvironmentStatus {
  /** What a reader calls this machine: `Windows`, `Host`, or the distro's own name. */
  label: string;
  environment: WorkspaceEnvironment;
  account: string | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  /** Unix epoch seconds the reading was taken, or null when there is no reading. */
  observedAt: number | null;
  /** How long ago that was, or null when there is no reading. Never negative. */
  ageSeconds: number | null;
  /** True only when there is a reading and it is older than {@link STALE_AFTER_SECONDS}. */
  stale: boolean;
}

/** `native.json`, or `wsl-Ubuntu-22.04.json`. */
export function statusFileFor(environment: WorkspaceEnvironment): string {
  return environment.kind === 'wsl' ? `wsl-${environment.distro}.json` : 'native.json';
}

/**
 * The environment a file in that directory stands for, or null when it stands for none.
 *
 * A distro is *declared*, never detected, and the registry is the only place a board
 * declares one — so a machine the operator runs sessions on but has no project in could not
 * be enumerated from the registry at all. Writing the file is a declaration too, and a
 * clearer statement of intent than a project they happen to have registered, so both are
 * read. The issue left this open; this is the call, and it costs one `readdir`.
 */
export function environmentFromFileName(name: string): WorkspaceEnvironment | null {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.json')) return null;
  if (lower === 'native.json') return { kind: 'native' };
  if (!lower.startsWith('wsl-')) return null;
  const distro = name.slice('wsl-'.length, name.length - '.json'.length).trim();
  return distro ? { kind: 'wsl', distro } : null;
}

/**
 * `Windows` for the host on Windows, `Host` anywhere else, and a distro's own name for a
 * distro. The observation asked for "windows and for WSL", and a row labelled `native` would
 * be this repository's word for it rather than the reader's.
 */
export function labelFor(environment: WorkspaceEnvironment): string {
  if (environment.kind === 'wsl') return environment.distro;
  return process.platform === 'win32' ? 'Windows' : 'Host';
}

function keyOf(environment: WorkspaceEnvironment): string {
  return environment.kind === 'wsl' ? `wsl:${environment.distro.toLowerCase()}` : 'native';
}

function record(source: unknown): Record<string, unknown> | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  return source as Record<string, unknown>;
}

/** A finite number, or null. `0` is a number; `"0"`, `NaN` and absent are not. */
function numberAt(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function textAt(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * A moment, however the file spelled it.
 *
 * Claude Code's own `resets_at` is Unix epoch **seconds**, so that is the canonical form.
 * An ISO 8601 string is accepted beside it because `date -u +%FT%TZ` is what a shell script
 * reaches for, and refusing it would make the difference between two spellings of the same
 * instant into a silently missing field.
 */
function momentAt(source: Record<string, unknown>, ...keys: string[]): number | null {
  const asNumber = numberAt(source, ...keys);
  if (asNumber !== null) return Math.round(asNumber);
  const asText = textAt(source, ...keys);
  if (asText === null) return null;
  const parsed = Date.parse(asText);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

/**
 * One window, in either spelling.
 *
 * `usedPercent`/`resetsAt` is this file's own; `used_percentage`/`resets_at` is Claude Code's,
 * accepted so that the shortest status line command that can write this file is a `jq` which
 * passes the object it was handed straight through.
 *
 * A window with no percentage is no window: the percentage is the thing being asked for, and
 * a reset time alone would draw a row that says nothing and looks like it does.
 */
function windowFrom(source: unknown): RateWindow | null {
  const fields = record(source);
  if (!fields) return null;
  const usedPercent = numberAt(fields, 'usedPercent', 'used_percentage');
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: momentAt(fields, 'resetsAt', 'resets_at') };
}

/** Nothing said, for an environment nobody has run a session in. */
function unknown(environment: WorkspaceEnvironment): ClaudeEnvironmentStatus {
  return {
    label: labelFor(environment),
    environment,
    account: null,
    fiveHour: null,
    sevenDay: null,
    observedAt: null,
    ageSeconds: null,
    stale: false,
  };
}

/**
 * One environment's file, read and projected.
 *
 * **Projected, never echoed.** Only the fields named here leave this function, so an operator
 * whose script dumps a wider object into that directory — the whole status line document, say
 * — cannot publish anything else through an unauthenticated local route. Anything unreadable,
 * unparseable or of the wrong shape costs that one environment its reading and nothing else:
 * a file half-written by a status line command that was killed mid-write is an ordinary
 * event, not a reason for the route to fail.
 */
async function readOne(
  directory: string,
  environment: WorkspaceEnvironment,
  nowSeconds: number
): Promise<ClaudeEnvironmentStatus> {
  const file = path.join(directory, statusFileFor(environment));

  let raw: string;
  let modifiedAt: number | null = null;
  try {
    raw = await fs.readFile(file, 'utf-8');
    const stat = await fs.stat(file);
    modifiedAt = Math.round(stat.mtimeMs / 1000);
  } catch {
    return unknown(environment);
  }

  const fields = record((() => { try { return JSON.parse(raw); } catch { return null; } })());
  if (!fields) return unknown(environment);

  const limits = record(fields.rate_limits) ?? record(fields.rateLimits) ?? {};

  // The file's own timestamp when it did not carry one. A reading with no age would read as
  // current forever, which is the one way this feature can lie rather than say nothing.
  const observedAt = momentAt(fields, 'observedAt', 'observed_at') ?? modifiedAt;
  const ageSeconds = observedAt === null ? null : Math.max(0, nowSeconds - observedAt);

  return {
    label: labelFor(environment),
    environment,
    account: textAt(fields, 'account', 'email'),
    fiveHour: windowFrom(fields.fiveHour) ?? windowFrom(limits.five_hour),
    sevenDay: windowFrom(fields.sevenDay) ?? windowFrom(limits.seven_day),
    observedAt,
    ageSeconds,
    stale: ageSeconds !== null && ageSeconds > STALE_AFTER_SECONDS,
  };
}

/**
 * Every environment this board knows about, with whatever each has said.
 *
 * The host is always one of them — this process is running on it. The rest are the distinct
 * distros the registry declares, plus any a file in the directory declares. An environment
 * that answers nothing is listed as unknown rather than dropped: a machine missing from the
 * HUD is indistinguishable from one that is idle, and only one of those wants attention.
 *
 * The host comes first and the distros follow in name order, so the rows do not move about
 * between polls.
 */
export async function readClaudeStatus(
  directory: string,
  registryDistros: readonly string[],
  now: () => number = Date.now
): Promise<ClaudeEnvironmentStatus[]> {
  let fromFiles: WorkspaceEnvironment[] = [];
  try {
    const entries = await fs.readdir(directory);
    fromFiles = entries
      .map(environmentFromFileName)
      .filter((environment): environment is WorkspaceEnvironment => environment !== null);
  } catch {
    // No directory is not an error: it is a board whose sessions have not written yet.
  }

  // The registry's spelling of a distro wins over a file name's, because that is the one the
  // project tabs already show — `Ubuntu-22.04` and `ubuntu-22.04` are one machine.
  const byKey = new Map<string, WorkspaceEnvironment>();
  byKey.set('native', { kind: 'native' });
  for (const environment of fromFiles) byKey.set(keyOf(environment), environment);
  for (const distro of registryDistros) {
    const trimmed = distro.trim();
    if (trimmed) byKey.set(keyOf({ kind: 'wsl', distro: trimmed }), { kind: 'wsl', distro: trimmed });
  }

  const ordered = [...byKey.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'native' ? -1 : 1;
    if (left.kind === 'wsl' && right.kind === 'wsl') return left.distro.localeCompare(right.distro);
    return 0;
  });

  const nowSeconds = Math.floor(now() / 1000);
  return Promise.all(ordered.map((environment) => readOne(directory, environment, nowSeconds)));
}

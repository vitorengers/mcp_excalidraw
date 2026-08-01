#!/usr/bin/env node
/**
 * Checks that the files a public repository is judged on are there, and that the one only
 * this repository can write says what this tool actually does.
 *
 * `git ls-files` had three workflow files under `.github/` and nothing else: no code of
 * conduct, no security policy, no issue template, no pull request template. The strongest
 * statement of what this tool is — the terminal "spawns a process that runs whatever arrives
 * over an API with no authentication" — was five levels down, in `docs/terminal.md`, and the
 * README's one security sentence was a blockquote in the middle of an install section. A tool
 * that spawns coding agents and real shells on localhost needs that stated where a reader
 * looks for it, with somewhere to report to.
 *
 * Existence is the easy half and is checked first. The half worth a check is the content,
 * because a governance file copied from a template is a file that describes somebody else's
 * project:
 *
 *  1. **the five files exist and are tracked.** Untracked, they are on one machine, which is
 *     the state this whole issue is about.
 *  2. **the security policy is where GitHub looks for it** — the root, `docs/` or `.github/`,
 *     the three folders GitHub reads — and there is exactly one of it. Two copies is the
 *     failure mode this repository has already paid for once with its two records of what
 *     shipped: both had stopped being true.
 *  3. **it names a way to report, the loopback default, and what `HOST=0.0.0.0` exposes.**
 *     A security policy that does not say where to send a report is a page, not a policy.
 *  4. **it names every `EXCALIDRAW_*` switch that grants code execution** — and each name is
 *     checked against the settings registry in `src/core/settings.ts`, so a variable renamed
 *     in the code fails here rather than leaving the policy describing a switch that no
 *     longer exists.
 *  5. **the bug report form requires the operating system, the Node version and the agent**,
 *     and asks whether the board is WSL-backed. Those four are what every reproduction of a
 *     failure in this tool has needed, and a form that asks for them optionally is a form
 *     that gets them half the time.
 *  6. **the pull request template asks for the two things CLAUDE.md requires of every
 *     change**: a `scripts/check-*.mjs`, and the development-log entry.
 *
 * The issue forms are parsed rather than pattern-matched: GitHub answers a malformed form by
 * silently falling back to a blank issue body, so "the file contains the word Node" is not
 * evidence that anything asks for it.
 *
 * Offline and self-contained apart from `git ls-files`. No server, no browser, no build.
 *
 * Usage: node scripts/check-community-files.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from './lib/parse-yaml.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((file) => file.split('\\').join(posix.sep))
);

const read = (path) => {
  try {
    return readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    return null;
  }
};

/**
 * The three folders GitHub reads a community health file out of.
 *
 * A policy in a fourth place is a policy GitHub's Security tab does not link, which is the
 * one route most readers take to it.
 * https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository
 */
const HEALTH_FOLDERS = ['', 'docs/', '.github/'];

/** Where a health file of this name is tracked, in any of the folders GitHub reads. */
const copiesOf = (name) => HEALTH_FOLDERS.map((folder) => `${folder}${name}`).filter((path) => tracked.has(path));

// ─── 1. The five files exist and are tracked ──────────────────

console.log('1. the governance files are in the repository');

const TEMPLATES = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
];

for (const name of ['CODE_OF_CONDUCT.md', 'SECURITY.md']) {
  const copies = copiesOf(name);
  check(`${name} is tracked, in one of the folders GitHub reads`, copies.length >= 1,
        `none of ${HEALTH_FOLDERS.map((folder) => `${folder}${name}`).join(', ')} is in git ls-files`);
  check(`there is exactly one ${name}`, copies.length <= 1, copies.join(', '));
}

for (const path of TEMPLATES) {
  check(`${path} is tracked`, tracked.has(path));
}

const securityPath = copiesOf('SECURITY.md')[0];
const security = securityPath ? read(securityPath) : null;

// ─── 2. The policy says where to report and what the bind is ──

console.log('\n2. the security policy names a contact and the bind it defaults to');

if (!security) {
  check('the security policy can be read', false, 'no SECURITY.md to read');
} else {
  // Either an address or GitHub's private advisory form. The form is a real channel that
  // needs no personal address published, and an address is a real channel where the form is
  // turned off; a policy with neither leaves a reporter with only a public issue.
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(security);
  const advisory = /security\/advisories\/new/.test(security);
  check('it names somewhere to send a report', email || advisory,
        'neither an email address nor a security/advisories/new link');

  check('it states the loopback default', /127\.0\.0\.1/.test(security));
  check('it says what HOST=0.0.0.0 exposes', /HOST=0\.0\.0\.0/.test(security));
  check('it names the origin gate that stands in front of a browser',
        /EXCALIDRAW_ALLOWED_HOSTS/.test(security) || /\borigin\b/i.test(security));
}

// ─── 3. Every switch that grants execution is named, and real ─

console.log('\n3. every switch that grants code execution is named, and is a real setting');

/**
 * The switches that turn a drawing canvas into something that runs code.
 *
 * Not derived from the registry: most of the settings there decide where a file is read from,
 * and only these five decide whether a process is spawned. Which ones those are is a judgement
 * about the code, so it is written here and each one is then held to existing.
 */
const EXECUTION_SWITCHES = [
  'EXCALIDRAW_ISSUE_AGENT',
  'EXCALIDRAW_ISSUE_AGENT_WSL',
  'EXCALIDRAW_IMPLEMENT_AGENT',
  'EXCALIDRAW_IMPLEMENT_AGENT_WSL',
  'EXCALIDRAW_TERMINAL',
];

const settings = read('src/core/settings.ts') ?? '';
const declared = new Set([...settings.matchAll(/^\s*name: '([A-Z0-9_]+)'/gm)].map(([, name]) => name));
check(`the settings registry was read (${declared.size} names)`, declared.size > 0,
      'src/core/settings.ts declared no settings — the cross-check below would pass vacuously');

for (const variable of EXECUTION_SWITCHES) {
  check(`${variable} is still a setting the code reads`,
        declared.has(variable.replace(/^EXCALIDRAW_/, '')),
        'renamed or removed in src/core/settings.ts — the policy would be describing a switch nobody has');
  if (security) {
    // Word-boundary, so `EXCALIDRAW_ISSUE_AGENT` in the document does not answer for
    // `EXCALIDRAW_ISSUE_AGENT_WSL`: the pair is a pair precisely because granting a distro
    // research must not thereby grant it repository writes.
    check(`the policy names ${variable}`, new RegExp(`${variable}\\b`).test(security));
  }
}

// ─── 4. The bug report form asks the four things ──────────────

console.log('\n4. the bug report form requires what a reproduction needs');

const bugSource = read('.github/ISSUE_TEMPLATE/bug_report.yml');
if (!bugSource) {
  check('the bug report form can be read', false, 'no .github/ISSUE_TEMPLATE/bug_report.yml');
} else {
  const form = parseYaml(bugSource);
  check('it is an issue form: name, description and body', Boolean(form?.name && form?.description)
        && Array.isArray(form?.body), JSON.stringify(Object.keys(form ?? {})));

  const fields = (form?.body ?? []).filter((item) => item && item.type && item.type !== 'markdown');
  check('it has fields', fields.length > 0);

  /** A field is required when GitHub would refuse the form without it. */
  const isRequired = (field) => field?.validations?.required === true;

  /** Everything a field puts in front of the reader, as one lowercase string. */
  const textOf = (field) => JSON.stringify(field?.attributes ?? {}).toLowerCase();

  const REQUIRED_OF_A_REPORT = [
    { what: 'the operating system', matches: /operating system|\bos\b|windows|macos/ },
    { what: 'the Node version', matches: /node/ },
    { what: 'which agent', matches: /agent/ },
  ];

  for (const { what, matches } of REQUIRED_OF_A_REPORT) {
    const asked = fields.filter((field) => matches.test(textOf(field)));
    check(`it asks for ${what}`, asked.length > 0);
    check(`and requires it`, asked.some(isRequired),
          'the field is optional, so half the reports will not carry it');
  }

  const wsl = fields.some((field) => /wsl/.test(textOf(field)));
  check('it asks whether the board is WSL-backed', wsl,
        'a WSL-backed project runs its agents and its gh inside the distro');
}

const featureSource = read('.github/ISSUE_TEMPLATE/feature_request.yml');
if (!featureSource) {
  check('the feature request form can be read', false, 'no .github/ISSUE_TEMPLATE/feature_request.yml');
} else {
  const form = parseYaml(featureSource);
  check('the feature request form is an issue form too',
        Boolean(form?.name && form?.description) && Array.isArray(form?.body),
        JSON.stringify(Object.keys(form ?? {})));
}

// ─── 5. The pull request template asks for both halves ────────

console.log('\n5. the pull request template asks for the check and the log entry');

const pull = read('.github/pull_request_template.md');
if (!pull) {
  check('the pull request template can be read', false, 'no .github/pull_request_template.md');
} else {
  check('it asks for the check script', /scripts\/check-\*?\.?m?js|scripts\/check-/.test(pull));
  check('it asks for the development-log entry', /development-log/.test(pull));
  check('it points at the board map check', /check-board-map/.test(pull));
}

// ─── 6. The README sends a reader to the policy ───────────────

console.log('\n6. the README points at the policy rather than being the whole of it');

const readme = read('README.md') ?? '';
check('README.md links to the security policy',
      securityPath ? readme.includes(securityPath) : false,
      `nothing in README.md names ${securityPath ?? 'SECURITY.md'}`);

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('All checks passed');

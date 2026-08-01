#!/usr/bin/env node
/**
 * Does a *real* Alt+Left keypress reach a web page, or does the browser take it first?
 *
 * `docs/board-sections.md` refuses to answer this class of question from a compile, and the
 * refusal is the reason this file exists rather than an assertion inside
 * `check-board-subsections-browser.mjs`. A CDP `Input.dispatchKeyEvent` is delivered straight
 * to the renderer: the browser's own accelerator table never sees it, so a check built on one
 * passes whether or not a real keypress would have been stolen. That is how `Alt+D` was
 * rejected — by reasoning, because nothing available could measure it.
 *
 * On Windows and Linux `Alt+Left` and `Alt+Right` are Back and Forward. Whether a page may
 * keep them is not a matter of taste: Chromium splits its accelerators into *reserved* ones,
 * which are handled before the renderer is consulted, and the rest, which are offered to the
 * page first and suppressed by `preventDefault()`. Which side Back and Forward fall on decides
 * whether this board can have `Alt+Left`/`Alt+Right` at all.
 *
 * So this drives a **visible** Chrome and sends the chord through the operating system —
 * `SendInput`, via PowerShell — so that it arrives the way a reader's own keypress arrives,
 * through the window's message queue and past the browser's accelerator table.
 *
 * Two cases, and the first is the one that makes the second worth believing:
 *
 * 1. **the control** — a page that does not listen at all must go Back. If it does not, the
 *    synthetic keypress never reached Chrome and nothing else here means anything;
 * 2. **the claim** — the same page with a `keydown` listener that calls `preventDefault()`
 *    must stay put, and must have seen the event.
 *
 * It needs a desktop session it can put a window in the foreground of. Headless CI has none,
 * so with no foreground it SKIPS rather than failing — a check that cannot run is not a
 * feature that does not work. It is deliberately not part of the automated set for the same
 * reason; it is run by hand, on Windows, when the chord is in question.
 *
 * ### Why this went red, and why the flag below is not optional (#425)
 *
 * The control failed on the maintainer's machine with `sessionStorage` empty and the page still
 * at `/second`: the chord had reached nothing. It read like a keypress lost on the way to
 * Chrome, and it was not. **Chrome was dropping every key before the page saw it, and it was
 * dropping the ones dispatched over CDP too** — an `Input.dispatchKeyEvent` never touches the
 * operating system, so it cannot be explained by anything about `SendInput`, the foreground
 * window or the accelerator table. A listener installed over CDP saw nothing either, while a
 * `KeyboardEvent` dispatched *inside* the page was recorded normally. The recorder worked; the
 * input path did not.
 *
 * What both halves had in common was `document.visibilityState`, which stayed `hidden` —
 * through `Page.bringToFront`, and through `SetForegroundWindow` with the window confirmed in
 * front by handle and by process id. That is Chromium's Windows native window occlusion
 * detection: when it decides a window is completely covered it treats the foreground tab as a
 * background tab, stops rendering it and throttles it, and the renderer then answers no input.
 * The maintainer's browser sat over this check's 900x700 window at 40,40, and that was the
 * whole of it. `--disable-features=CalculateNativeWinOcclusion` — what Chromium's own
 * documentation names, and what `chrome-launcher` lists for tools — makes both halves arrive:
 * with the flag the page is `visible` and records the CDP key *and* the real one; without it,
 * on a covered desktop, neither.
 *
 * It is also why this check was intermittent rather than simply broken, which is what made it
 * expensive to read. Occlusion is a fact about whatever else is on the operator's screen, so
 * the same code passes on a clear desktop and fails behind a maximised window — the shape of a
 * check people learn to re-run instead of believe.
 *
 * The flag alone would leave the next Chrome free to change its mind, so the control no longer
 * takes it on trust: it asks whether the renderer considers itself visible *before* it claims
 * anything, and SKIPS if it does not. A renderer that is dropping input cannot report on an
 * accelerator either way, and saying so is worth more than a red line whose real content is
 * that the window was covered.
 *
 * Usage: node scripts/check-alt-arrow-accelerator.mjs [--chrome <path>] [--keep]
 *
 * Tier: windows
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

import { freePort } from './lib/free-port.mjs';

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome({ what: 'nothing was measured.' });
if (process.platform !== 'win32') {
  console.log('SKIPPED — the accelerator being asked about is the Windows one.');
  process.exit(0);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A skip is neither a pass nor a failure, and it still has a Chrome to close.
 *
 * Thrown rather than exited on: `process.exit()` walks straight past `finally`, so the older
 * skip below left a visible browser window on the operator's desktop and a temporary profile
 * behind it. This unwinds through the same cleanup as everything else and prints its reason
 * last.
 */
const SKIP = Symbol('nothing could be measured');
let skipped = null;
const skip = (...lines) => { skipped = lines; throw SKIP; };

// ─── Pages, so that there are history entries to move between ───
//
// A path ending in `-listening` is one that calls `preventDefault()`; every other path is a
// control that lets the browser have the chord.

const page = (title, listens) => `<!doctype html><html><head><title>${title}</title></head>
<body style="font:48px sans-serif;padding:2rem">${title}
<script>
// Into sessionStorage, not just a variable. Every page records — separating "the browser took
// it" from "the keypress never arrived" is the whole job of the control — and on the control
// the browser *does* navigate, which throws away the document that saw the key. sessionStorage
// is per tab and survives the navigation, so the evidence outlives the page that gathered it.
window.addEventListener('keydown', (event) => {
  const seen = JSON.parse(sessionStorage.getItem('seen') || '[]');
  seen.push((event.altKey ? 'Alt+' : '') + event.code);
  sessionStorage.setItem('seen', JSON.stringify(seen));
  if (!event.altKey || (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight')) return;
  ${listens ? 'event.preventDefault();' : ''}
});
</script></body></html>`;

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const http = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const listens = path.endsWith('-listening');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page(path, listens));
});
await new Promise((resolve) => http.listen(PORT, '127.0.0.1', resolve));

const workDir = mkdtempSync(join(tmpdir(), 'check-alt-arrow-'));
const profileDir = join(workDir, 'chrome-profile');
mkdirSync(profileDir, { recursive: true });
const children = [];

// ─── Talking to Chrome ──────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function waitFor(fn, what, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** What this tab has seen pressed, gathered by whichever document was on screen at the time. */
const seenHere = () => evaluate(`sessionStorage.getItem('seen') || '[]'`);

/**
 * Does the renderer believe it is on screen? Asked of the page rather than of Windows, because
 * the page is where the answer has consequences: an occluded renderer is throttled and drops
 * every key, whether it arrived through the operating system or straight down the debugging
 * socket, and a check that pressed one anyway would be measuring the desktop's arrangement.
 */
async function rendererIsAwake(tries = 8) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if ((await evaluate('document.visibilityState')) === 'visible') return true;
    await sleep(250);
  }
  return false;
}

/** One more entry in this window's history, put there by the browser rather than by a script. */
async function goTo(path) {
  await send('Page.navigate', { url: `${BASE}${path}` });
  await waitFor(async () => (await evaluate('location.pathname')) === path, `the page at ${path}`);
  await sleep(500);
}

/**
 * The chord, through the operating system.
 *
 * `SendInput` rather than `SendKeys`: `SendKeys` synthesises Alt as a menu activation and
 * several shells refuse it outright, while `SendInput` puts the same scan codes on the queue
 * a keyboard puts them on. Input goes to whatever holds the foreground, so the window has to
 * be raised first, and that is the whole point of the exercise.
 *
 * Windows refuses `SetForegroundWindow` to a process that has not recently received input,
 * which is never this one. `AttachThreadInput` to the thread that owns the foreground plus a
 * synthesised tap is the documented way round it, and the window that had the foreground is
 * put back afterwards — this borrows the screen for a second, it does not take it.
 *
 * **Nothing is sent unless the check can see its own window in front**, by process id and by
 * title, and the page is asked separately whether it has the focus. The alternative to those
 * guards is an `Alt+Left` landing in whatever the operator was reading, which is a real
 * keypress in the wrong window.
 *
 * **Raising and pressing are one call, and `windowsHide` is not optional.** Injected input
 * goes to whatever holds the foreground *at that instant*, so a second PowerShell — whose
 * console window takes the foreground as it starts — receives the chord itself and the page
 * never sees a thing. That failure is indistinguishable from the browser eating the key,
 * which is exactly the claim being measured, so the two happen in one process that checks the
 * foreground on the line above the injection.
 */
function powershell(body) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RealKeys {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;
  }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  /**
   * Windows hands the foreground only to a process that recently received input, which is
   * never this one. Synthesising a tap is what makes it one — a bare Ctrl, because the tap
   * lands in whatever window is currently in front, which is the operator's, and an Alt
   * there would drop their browser into its menu bar.
   */
  public static bool Raise(IntPtr hWnd) {
    uint owner = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint mine = GetCurrentThreadId();
    AttachThreadInput(owner, mine, true);
    Key(17, false, false); Key(17, true, false);
    ShowWindow(hWnd, 9);
    bool ok = SetForegroundWindow(hWnd);
    AttachThreadInput(owner, mine, false);
    return ok;
  }
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  /**
   * A virtual key is not enough. Chrome reads KeyboardEvent.code off the *scan* code, so a
   * key injected with wScan left at zero arrives at the page as an empty code — and the
   * arrows are extended keys, which without KEYEVENTF_EXTENDEDKEY are the numeric keypad's.
   */
  public static void Key(ushort vk, bool up, bool extended) {
    INPUT[] input = new INPUT[1];
    input[0].type = 1;
    input[0].ki.wVk = vk;
    input[0].ki.wScan = (ushort)MapVirtualKey(vk, 0);
    input[0].ki.dwFlags = (up ? 2u : 0u) | (extended ? 1u : 0u);
    SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
${body}
`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const out = `${run.stdout ?? ''}`.trim();
  return out.split(/\r?\n/).pop() || `NO-OUTPUT ${(run.stderr ?? '').slice(0, 200)}`;
}

/**
 * Put this check's own Chrome window in front and press `Alt` and one key into it — or
 * refuse, and send nothing at all.
 */
const raiseAndPressAlt = (chromePid, windowTitleFragment, virtualKey) => powershell(`
# By process *and* by title. The operator has their own Chrome windows open, and a keypress
# meant for this check's throwaway profile landing in one of those is the mistake worth being
# paranoid about: matching on a title alone would find whichever tab happened to be named
# something similar.
$window = Get-Process -Id ${chromePid} -ErrorAction SilentlyContinue
if (-not $window) { Write-Output 'NO-PROCESS'; exit }
if ($window.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output 'NO-WINDOW'; exit }
if ($window.MainWindowTitle -notlike '*${windowTitleFragment}*') { Write-Output ('WRONG-WINDOW ' + $window.MainWindowTitle); exit }
$previous = [RealKeys]::GetForegroundWindow()
[RealKeys]::Raise($window.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900
if ([RealKeys]::GetForegroundWindow() -ne $window.MainWindowHandle) { Write-Output 'NO-FOREGROUND'; exit }

# Alt held down, one key, Alt released — the way a reader presses it.
[RealKeys]::Key(18, $false, $false)
Start-Sleep -Milliseconds 80
[RealKeys]::Key(${virtualKey}, $false, $true)
Start-Sleep -Milliseconds 80
[RealKeys]::Key(${virtualKey}, $true, $true)
Start-Sleep -Milliseconds 80
[RealKeys]::Key(18, $true, $false)
Start-Sleep -Milliseconds 500

# The operator gets their window back. Only after the chord has been delivered, and only
# because this took it in the first place.
if ($previous -ne [IntPtr]::Zero) { [RealKeys]::Raise($previous) | Out-Null }
Write-Output 'SENT'
`);

const VK_LEFT = 37;
const VK_RIGHT = 39;

try {
  const browser = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=900,700',
    '--window-position=40,40',
    // A window Chromium thinks is covered has its renderer throttled and answers no input at
    // all — see the note at the top. This check's window is small, in the corner, and on a
    // desktop somebody is using, so being covered is the ordinary case rather than the odd one.
    '--disable-features=CalculateNativeWinOcclusion',
    `${BASE}/start`,
  ], { stdio: 'ignore' });
  children.push(browser);

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(async () => (await evaluate('location.pathname')) === '/start', 'the first page');

  console.log('1. the control: a page that does not listen must go Back');
  // `Page.navigate`, not `location.href = …`. An entry pushed by a script in a document that
  // never saw a user gesture is marked skippable by Chrome's history-manipulation
  // intervention: `history.back()` still crosses it, the browser's own Back steps straight
  // over it, and the control then fails for a reason that has nothing to do with the chord.
  await goTo('/second');

  // Before the control, the control's own precondition. A renderer Chromium has decided is
  // covered answers no input at all, so a chord pressed into one proves nothing about the
  // accelerator — and the failure it leaves behind reads exactly like the browser eating the
  // key, which is the claim being measured. #425 was that, and only that.
  if (!(await rendererIsAwake())) {
    skip('SKIPPED — Chrome reports this window hidden, so its renderer is dropping every key',
         '        before the page can see it, and nothing about the accelerator is measurable',
         '        from here. Uncover the window, or check that Chrome still honours',
         '        --disable-features=CalculateNativeWinOcclusion.');
  }

  const historyBefore = await evaluate('history.length');
  let sent = raiseAndPressAlt(browser.pid, '/second', VK_LEFT);
  if (sent !== 'SENT') {
    skip(`SKIPPED — could not put this check's own Chrome in the foreground (${sent}).`,
         '        This needs a desktop session; it is not a CI check.');
  }
  await sleep(1500);
  const afterBack = await evaluate('location.pathname');
  check('the keypress reached the page at all', /Alt\+ArrowLeft/.test(await seenHere()),
        `sessionStorage said ${await seenHere()} — empty means the chord went somewhere else`);
  check('a real Alt+Left navigates Back when the page does not prevent it',
        afterBack === '/start', `still at ${afterBack}, history.length was ${historyBefore}`);
  if (afterBack !== '/start') {
    console.error('        The browser did not act on it, so the claim below would prove nothing.');
    throw new Error('the control did not hold');
  }

  // Back left a forward entry, so this costs one keypress and answers the other half.
  check('and a real Alt+Right navigates Forward',
        raiseAndPressAlt(browser.pid, '/start', VK_RIGHT) === 'SENT');
  await sleep(1500);
  const afterForward = await evaluate('location.pathname');
  check('   — it did', afterForward === '/second', `at ${afterForward}`);

  console.log('\n2. the claim: preventDefault() keeps both of them');
  // Two entries, then back one *through the browser* — so the page that prevents has a Back
  // entry behind it and a Forward entry in front of it at the same time.
  await goTo('/first-listening');
  await goTo('/second-listening');
  const history = await send('Page.getNavigationHistory');
  const at = history.entries.findIndex((entry) => entry.url.endsWith('/first-listening'));
  await send('Page.navigateToHistoryEntry', { entryId: history.entries[at].id });
  await waitFor(async () => (await evaluate('location.pathname')) === '/first-listening', 'the listening page');
  await evaluate(`sessionStorage.setItem('seen', '[]')`);
  await sleep(500);

  for (const [name, virtualKey, chord] of [['Back', VK_LEFT, 'Alt+ArrowLeft'], ['Forward', VK_RIGHT, 'Alt+ArrowRight']]) {
    sent = raiseAndPressAlt(browser.pid, '/first-listening', virtualKey);
    check(`the ${name} chord was sent`, sent === 'SENT', sent);
    await sleep(1500);
    const where = await evaluate('location.pathname');
    check(`the page saw ${chord}`, new RegExp(chord.replace('+', '\\+')).test(await seenHere()),
          await seenHere());
    check(`and preventDefault() kept the browser from going ${name}`,
          where === '/first-listening', `navigated to ${where}`);
  }
} catch (error) {
  if (error !== SKIP) {
    failures++;
    console.error(`\n  FAIL  ${error.message}`);
  }
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  http.close();
  await sleep(400);
  if (argOf('--keep') === null) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

// Failures are read before the skip: a check must not launder one into a pass on its way out.
if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
if (skipped) { for (const line of skipped) console.log(line); process.exit(0); }
console.log('\nall cases passed');

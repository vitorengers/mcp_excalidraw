// One-shot codemod for issue #271. Deleted after the migration; kept out of git history's way
// by living under scripts/ only for the length of the run.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname);
const files = fs.readdirSync(dir).filter((f) => /^check-.*\.mjs$/.test(f) && f !== 'check-port-allocation.mjs');

const PID = /^(\s*)const (\w+) = (\d+) \+ \(process\.pid % (\d+)\);\s*$/;
const DER = /^(\s*)const (\w+) = (\w+) \+ (\d+);\s*$/;

let changed = 0;
const report = [];

for (const f of files) {
  const p = path.join(dir, f);
  const src = fs.readFileSync(p, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);

  const portNames = new Set();
  let touched = false;

  // First pass: the pid expressions become a probe, and record the names they bound.
  for (let i = 0; i < lines.length; i++) {
    const m = PID.exec(lines[i]);
    if (!m) continue;
    lines[i] = `${m[1]}const ${m[2]} = await freePort();`;
    portNames.add(m[2]);
    touched = true;
  }

  // Second pass, repeated until it settles: anything derived from a port is a port too.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < lines.length; i++) {
      const m = DER.exec(lines[i]);
      if (!m || !portNames.has(m[3]) || portNames.has(m[2])) continue;
      lines[i] = `${m[1]}const ${m[2]} = await freePort();`;
      portNames.add(m[2]);
      touched = true;
    }
  }

  if (!touched) continue;

  // The import goes after the last one in the file's own leading import block. Anchoring to the
  // last `import` anywhere puts it inside the stub scripts these checks write as template
  // literals.
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#!') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    if (!line.startsWith('import ')) break;
    while (!lines[i].trim().endsWith(';') && i + 1 < lines.length) i++;
    last = i;
  }
  if (last < 0) { report.push(`${f}: no import statement to anchor to`); continue; }
  if (!/from '\.\/lib\/free-port\.mjs'/.test(src)) {
    lines.splice(last + 1, 0, '', "import { freePort } from './lib/free-port.mjs';");
  }

  fs.writeFileSync(p, lines.join(eol), 'utf8');
  changed++;
}

console.log(`rewrote ${changed} file(s)`);
for (const line of report) console.log('  !', line);

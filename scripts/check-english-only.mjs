#!/usr/bin/env node
/**
 * Checks that development artifacts are written in English.
 *
 * The convention is that everything a developer reads — code, comments, tests,
 * documentation — is English, while conversation with the maintainer happens in
 * Portuguese. Nothing enforced that boundary, so it leaked: Portuguese fixtures in the
 * check scripts, and an issue agent with no instruction about what language to write in,
 * which took it from the repository it had just read and produced a Portuguese issue.
 *
 * Two cases, both offline — no server, no network, so this can run in CI:
 *
 *  1. no tracked source, script, skill or Markdown file reads as Portuguese;
 *  2. the issue agent's prompt tells the agent which language to write the issue in.
 *
 * Usage: node scripts/check-english-only.mjs
 *
 * Tier: repo
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where a development artifact can live. Everything else is data or vendored.
 *
 * `docs/` was outside this list until #151, which left roughly 268 KB of tracked prose — the
 * largest body of writing in the repository — scanned by nothing. The boundary this file
 * exists to hold is about what a *developer reads*, and documentation is most of that.
 */
const SCANNED_DIRS = ['src/', 'frontend/src/', 'scripts/', 'skills/', 'docs/'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.css', '.html', '.json'];

/**
 * This file is the one place Portuguese is allowed to appear, because it is the list
 * itself. Scanning it would fail on its own contents.
 */
const SELF = 'scripts/check-english-only.mjs';

/**
 * Portuguese words that are not also English words, and are not plausible identifiers.
 *
 * Deliberately not a language classifier: any Portuguese sentence contains several of
 * these, and the file-level threshold below keeps a single borrowed word from failing a
 * file. Words that collide with English or with code — "do", "no", "as", "or", "com",
 * "todo", "ate", "remove" — are left out on purpose.
 */
const MARKERS = new Set([
  'nao', 'não', 'para', 'pela', 'pelo', 'pelas', 'pelos', 'uma', 'umas', 'dos', 'das',
  'nas', 'voce', 'você', 'voces', 'vocês', 'ele', 'ela', 'eles', 'elas', 'isso', 'isto',
  'esse', 'essa', 'esses', 'essas', 'esta', 'está', 'estao', 'estão', 'aqui', 'onde',
  'quando', 'porque', 'porem', 'porém', 'mas', 'tambem', 'também', 'ainda', 'apenas',
  'sempre', 'nunca', 'muito', 'muitos', 'muita', 'muitas', 'mais', 'menos', 'cada',
  'qualquer', 'mesmo', 'mesma', 'assim', 'entao', 'então', 'sobre', 'entre', 'sem',
  'depois', 'antes', 'agora', 'quem', 'qual', 'quais', 'que', 'ser', 'seja', 'sao',
  'são', 'foi', 'era', 'tem', 'têm', 'tinha', 'ter', 'fazer', 'faz', 'feito', 'pode',
  'podem', 'deve', 'devem', 'precisa', 'existe', 'existem', 'funciona', 'acontece',
  'aparece', 'abre', 'abrir', 'fecha', 'fechar', 'mostra', 'mostrar', 'roda', 'rodar',
  'cria', 'criar', 'criado', 'criada', 'muda', 'mudar', 'usa', 'usar', 'vive', 'mora',
  'escreve', 'chama', 'chamada', 'demora', 'demoram', 'trocar', 'sobrevive', 'menciona',
  'volta', 'fica', 'arquivo', 'arquivos', 'bloco', 'blocos', 'painel', 'aba', 'abas',
  'caixa', 'tela', 'borda', 'janela', 'forma', 'tamanho', 'largura', 'altura', 'grande',
  'grandes', 'pequeno', 'novo', 'nova', 'coisa', 'coisas', 'palavra', 'linha', 'erro',
  'erros', 'teste', 'servidor', 'usuario', 'usuário', 'documentacao', 'documentação',
  'desenvolvimento', 'comportamento', 'exemplo', 'exemplos', 'codigo', 'código',
  'versao', 'versão', 'mudanca', 'mudança', 'delecao', 'deleção', 'explicita',
  'explícita', 'ausencia', 'ausência', 'elemento', 'elementos',
]);

/** Below this a file passes: one borrowed word is not a sentence. */
const THRESHOLD = 3;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));
}

function isScanned(file) {
  if (file === SELF) return false;
  if (!SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension))) return false;
  return SCANNED_DIRS.some((dir) => file.startsWith(dir)) || !file.includes('/');
}

/**
 * Markers found in a file, as `line:word` pairs.
 *
 * URLs go first: `github.com/...` would otherwise split into tokens that read as words,
 * and a path segment is not prose.
 */
function findMarkers(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const prose = line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
    for (const word of prose.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []) {
      if (MARKERS.has(word)) hits.push(`${index + 1}:${word}`);
    }
  });
  return hits;
}

console.log('scanning tracked development artifacts\n');

console.log('1. no tracked artifact reads as Portuguese');
const offenders = [];
for (const file of trackedFiles().filter(isScanned)) {
  const hits = findMarkers(readFileSync(join(repoRoot, file), 'utf8'));
  if (hits.length >= THRESHOLD) offenders.push(`${file} (${hits.slice(0, 6).join(', ')})`);
}
check('every scanned file is English', offenders.length === 0, `\n        ${offenders.join('\n        ')}`);

console.log('\n2. the issue agent is told which language to write in');
// Since #191 the language is the project's to name, so the prompt is composed rather than
// held in one constant and there is no template literal here to read. What has not changed is
// what this file is about: the language is *stated* rather than inferred, and English is what
// is stated when a project has named nothing. Both are read off the two functions that decide
// it. `check-workspace-language.mjs` is the fuller version — it runs a real research and a
// real rewrite through the composition path and reads the prompt back over stdin — and it
// needs `dist`; this one deliberately stays a scan of tracked source.
const agentSource = readFileSync(join(repoRoot, 'src', 'core', 'issue-agent.ts'), 'utf8');
const fallback = agentSource.match(/function languageNamed\([\s\S]*?\n}/)?.[0] ?? '';
const paragraph = agentSource.match(/function issueLanguageParagraph\([\s\S]*?\n}/)?.[0] ?? '';

check('the language the issue is written in is decided in one place', fallback.length > 0,
      'no languageNamed() — the fallback that keeps a board that configures nothing where it was');
check('and it is English when a project names none', /['"`]English['"`]/.test(fallback),
      'an observation typed in Portuguese otherwise produces a Portuguese issue');

check('the prompt has a paragraph that names it', paragraph.length > 0,
      'no issueLanguageParagraph() — nothing tells the agent which language to write in');
check('and it says the language is fixed rather than taken from what was read',
      /not the language of the/.test(paragraph),
      'this is #20: the agent takes the language from the repository it just investigated');

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');

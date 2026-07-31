import fs from 'fs';
import { fileURLToPath } from 'url';

// Single source of truth for the package's identity — the version and the command names it
// installs (MCP server metadata, CLI --version, every command named in help and error text):
// read package.json so none of it can drift from npm again.

function packageJson(): any {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
}

export function packageVersion(): string {
  try {
    return packageJson().version;
  } catch {
    return 'unknown';
  }
}

export function packageDescription(): string {
  try {
    return packageJson().description ?? '';
  } catch {
    return '';
  }
}

// The name to fall back on when package.json cannot be read at all — an installed package
// always ships it beside dist/, so this is the shape of a broken checkout rather than a
// supported mode. check-bin-identity.mjs pins it to package.json's first bin, so the fallback
// cannot quietly become the odd one out.
const FALLBACK_BIN_NAME = 'vibemaxxing';

function readBinNames(): string[] {
  try {
    const bin = packageJson().bin;
    const names = typeof bin === 'string' ? [String(packageJson().name)] : Object.keys(bin ?? {});
    return names.length > 0 ? names : [FALLBACK_BIN_NAME];
  } catch {
    return [FALLBACK_BIN_NAME];
  }
}

// Every command this package installs, in the order package.json declares them: the product's
// own name first, its short aliases after. Help text is built out of these rather than spelling
// a command out, so a rename lands in package.json alone.
export const BIN_NAMES: readonly string[] = readBinNames();
export const BIN_NAME: string = BIN_NAMES[0]!;

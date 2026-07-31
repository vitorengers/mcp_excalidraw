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

/**
 * The product's name as a person writes it, for the one line a launch prints.
 *
 * Read out of the description's leading segment rather than written down, for the reason
 * `BIN_NAME` is read out of the `bin` map (#297): a literal that is right today is what the next
 * rename has to find by hand. The description leads with the product and then explains it —
 * "VibeMaxxing — an Excalidraw workbench for AI coding agents" — so the part before the dash is
 * the name, and a description that has no dash is a name on its own. `BIN_NAME` is the fallback,
 * which is the same string in lower case.
 */
export function productName(): string {
  const leading = packageDescription().split(/[—–:]|\s-\s/)[0]?.trim();
  return leading || BIN_NAME;
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

// The `.env`, before anything below reads a variable out of it. See core/env.ts for why the
// file is loaded from a module of its own rather than here.
import './env.js';
import { canvasUrlFor, DEFAULT_CANVAS_PORT } from './port.js';
import { env } from './settings.js';

/**
 * The accessor, re-exported so that a module reading configuration can have it from the module
 * named "config" without also pulling in the layering machinery it does not care about.
 *
 * It is declared in `core/settings.ts` rather than here because that is where the layers, the
 * declarations and the two prefixes already are, and because this module cannot be imported as
 * early as `settings.ts` has to be: the CLI entry point applies the layers before `core/port.ts`
 * resolves a canvas URL, and the line below captures one.
 */
export { env };

// Express server configuration.
//
// The default is resolved once, at import, and every module downstream reads this one string —
// which is exactly why the port scan happens in front of it, in `core/port.ts`, called from the
// entry point before this module is loaded. By the time anybody reads `EXPRESS_SERVER_URL` the
// answer has to already be final.
export const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || canvasUrlFor(DEFAULT_CANVAS_PORT);
export const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// Opt-out for auto-starting the canvas server from the CLI / MCP server
export const EXCALIDRAW_NO_AUTOSTART = env('NO_AUTOSTART') === '1';

// Opt-out for the refusal to drive a canvas built from another version (see core/spawn.ts).
// It exists for one real setup and not as a general escape hatch: a working copy's `dist/` driving
// a globally installed canvas — the maintainer's own arrangement, and the one case where the two
// versions differing is intended rather than stale.
export const EXCALIDRAW_ALLOW_VERSION_SKEW = env('ALLOW_VERSION_SKEW') === '1';

// Safe file path validation base directory (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIR = env('EXPORT_DIR') || process.cwd();

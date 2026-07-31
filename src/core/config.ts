// The `.env`, before anything below reads a variable out of it. See core/env.ts for why the
// file is loaded from a module of its own rather than here.
import './env.js';
import { canvasUrlFor, DEFAULT_CANVAS_PORT } from './port.js';

// Express server configuration.
//
// The default is resolved once, at import, and every module downstream reads this one string —
// which is exactly why the port scan happens in front of it, in `core/port.ts`, called from the
// entry point before this module is loaded. By the time anybody reads `EXPRESS_SERVER_URL` the
// answer has to already be final.
export const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || canvasUrlFor(DEFAULT_CANVAS_PORT);
export const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// Opt-out for auto-starting the canvas server from the CLI / MCP server
export const EXCALIDRAW_NO_AUTOSTART = process.env.EXCALIDRAW_NO_AUTOSTART === '1';

// Safe file path validation base directory (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();

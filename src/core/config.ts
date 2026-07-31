// Configuration for every entry point (MCP server, CLI, canvas server), layered in one place:
// `<state-dir>/config.json`, then `<cwd>/.env`, then the real environment. See
// `core/settings.ts` for why each of those is where it is, and for `EXCALIDRAW_NO_DOTENV=1`,
// which turns both file layers off. Importing the module applies them; the call is explicit
// here so that the constants below cannot be read out of a half-loaded environment.
import { loadSettings } from './settings.js';

loadSettings();

// Express server configuration
export const EXPRESS_SERVER_URL = process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3000';
export const ENABLE_CANVAS_SYNC = process.env.ENABLE_CANVAS_SYNC !== 'false'; // Default to true

// Opt-out for auto-starting the canvas server from the CLI / MCP server
export const EXCALIDRAW_NO_AUTOSTART = process.env.EXCALIDRAW_NO_AUTOSTART === '1';

// Safe file path validation base directory (see sanitizeFilePath)
export const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();

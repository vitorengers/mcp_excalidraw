import { parseArgs } from '../args.js';
import { printJson, note } from '../util.js';
import { getHealth, HealthStatus } from '../../core/canvas-client.js';
import { isCanvasHealth, foreignServiceError } from '../../core/spawn.js';
import { EXPRESS_SERVER_URL } from '../../core/config.js';
import { doctorLines, namedRoles } from '../../core/agent-preflight.js';

/**
 * Ask the board whether its agents can actually run.
 *
 * There was no way to ask. The agents are the quietest failure in the product — the blocks
 * draw, the buttons are there, and pressing one does nothing — and the only report on them was
 * two booleans in `/health` that meant a string was non-empty. So this is the question, made
 * askable: one command, per role and per environment, saying `found`, `not found` or
 * `unconfigured` and naming the variable to set when it is the second.
 *
 * **It reads `/health` and holds nothing else**, which is the design rather than a shortcut.
 * The board is where the commands are, the board is where the preflight ran, and a `doctor`
 * that read the environment itself would be reporting on the shell it was typed into instead
 * of on the server that will run the agent — the two differ exactly when it matters, because
 * an auto-started canvas inherits whatever its caller held. It also means there is no command
 * line here to leak: `/health` never sends one.
 *
 * `probing` is a real answer and it is waited on, briefly. The server does not block `listen`
 * on the probes, so a `doctor` typed in the first second of a board's life would otherwise
 * report a state that is about to stop being true.
 *
 * Exit 0 whenever the board answered, even when what it answered is that an agent is missing:
 * this is a report, and a script that wants the verdict has the JSON. Unreachable is the
 * ordinary exit 3, like `status`.
 */
export async function doctor(argv: string[]): Promise<void> {
  parseArgs(argv, {});

  let health;
  try {
    health = await settled();
  } catch {
    printJson({ running: false, url: EXPRESS_SERVER_URL });
    const error = new Error(`Canvas server is not running at ${EXPRESS_SERVER_URL}`);
    (error as any).code = 'CANVAS_UNREACHABLE';
    (error as any).quiet = true; // the JSON above already tells the story
    throw error;
  }

  if (!isCanvasHealth(health)) {
    printJson({
      running: false,
      url: EXPRESS_SERVER_URL,
      conflict: 'another service (or a pre-1.1 canvas build) is answering at this URL'
    });
    const error = foreignServiceError();
    (error as any).quiet = true;
    throw error;
  }

  const agents = health.agents;
  printJson({ url: EXPRESS_SERVER_URL, pid: health.pid, agents: agents ?? null });

  if (!agents) {
    note('This canvas does not report an agent preflight — it is an older build.');
    return;
  }
  for (const line of doctorLines(agents, namedRoles())) note(line);
}

/** Poll past `probing`, which is what a board says while its probes are still out. */
async function settled(attempts = 40): Promise<HealthStatus> {
  let health = await getHealth();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const states = Object.values(health.agents ?? {})
      .flatMap((role) => Object.values(role?.environments ?? {}))
      .map((environment) => environment?.resolved);
    if (!states.includes('probing')) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
    health = await getHealth();
  }
  return health;
}

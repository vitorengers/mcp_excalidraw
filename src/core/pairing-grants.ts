/**
 * What approving a device grants, in one sentence — and the routes that sentence is held to.
 *
 * The approval dialog (#504) has to say what the operator is about to hand over, because the
 * operator is the only one who can judge it and because "Pair this device?" tells a reader
 * nothing they did not already know. What it hands over is not a drawing surface: it is a shell
 * on this machine and the ability to start coding agents against this project, as this account.
 * That sentence is written here rather than in the component for one reason, and it is the reason
 * the whole file exists:
 *
 * **A sentence about capabilities drifts from the capabilities.** A route is added, a route is
 * moved behind a different guard, a feature is switched off — and the dialog goes on promising
 * whatever it promised the day it was written, which is the worst possible state for the one
 * screen a person reads before letting another machine in. So each clause of the sentence names
 * the route it is a claim about, `scripts/check-pairing-surfaces-browser.mjs` asks those routes
 * whether they are still there and still behind the credential the rest of the board is behind,
 * and a clause whose route has gone is a red check rather than a lie on a dialog.
 *
 * `clause` is a substring of `PAIRING_GRANT_SENTENCE`, and the check holds it to that too: a
 * clause that has drifted out of the sentence is holding nothing.
 *
 * Nothing here imports anything. The frontend's own `tsconfig` compiles what the page imports,
 * so a `node:` import in this file would be a type error in files nobody touched.
 */

/** One route a clause is a claim about, as the check asks for it. */
export interface PairingGrantRoute {
  method: 'GET' | 'POST';
  path: string;
}

/** One promise the dialog makes, and what makes it true. */
export interface PairingGrant {
  /** The words in `PAIRING_GRANT_SENTENCE` this is the claim of. */
  clause: string;
  /** What that clause is a claim about, and what a check asks after. */
  route: PairingGrantRoute;
}

/**
 * The two capabilities worth naming, and the routes they are.
 *
 * Not every route a paired device reaches — that is the whole of `/api`, and a dialog listing it
 * is a dialog nobody reads. These are the two that are not about a canvas: one runs commands on
 * this machine, and one starts a program that writes to this repository and pushes.
 */
export const PAIRING_GRANTS: PairingGrant[] = [
  {
    clause: 'a real shell on this machine',
    route: { method: 'POST', path: '/api/terminal' }
  },
  {
    clause: 'start coding agents against this project',
    route: { method: 'POST', path: '/api/implement' }
  }
];

/**
 * The sentence itself, unsoftened.
 *
 * "Trusted device" and "full access" are the two phrasings this deliberately is not. The first
 * describes a state and not a consequence; the second is a category a reader has to already know
 * the contents of. What a person can act on is the two concrete things they are handing over, who
 * they run as, and when it stops.
 */
export const PAIRING_GRANT_SENTENCE =
  'Approving this gives the device a real shell on this machine and the ability to '
  + 'start coding agents against this project, running as this account, until you revoke it.';

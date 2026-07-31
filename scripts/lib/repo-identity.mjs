/**
 * Which repository this is: one fact, recorded once, for the checks that hold the tree to its
 * own name.
 *
 * It used to be `board.config.json`'s `repo`, and that field is gone. A board configuration is
 * read by the running server and copied by everyone who clones the tree, so naming an account
 * in it pointed every clone of the release at the maintainer's GitHub (#315). What the checks
 * needed from it was never configuration at all — it is a claim *about* the tree, which is what
 * this file is.
 *
 * **Recorded here rather than read out of `package.json`, and that is the whole point.** Four
 * rules ask whether the package manifest describes *this* repository or the one it was forked
 * from — `check-fork-identity.mjs` rule 2, `check-install-paths.mjs`'s `publishesOwnPackage`,
 * `check-attribution.mjs`'s LICENSE rule, `check-readme.mjs`'s "which fork is this". Every one
 * of them needs a second, independent declaration to compare the manifest against: the state
 * they were written for is a tree carrying upstream's manifest verbatim, in which `name` and
 * `repository.url` agree with each other perfectly and are both upstream's. Anchoring on the
 * manifest would make all four pass by definition.
 *
 * `scripts/check-board-map.mjs` keeps `FORK_BASE` the same way and for the same reason: a fact
 * about this fork that nothing else in the tree can be asked for.
 *
 * Nothing here is derived from `origin`. These checks assert what the *tree* claims about
 * itself, and a remote is a fact about one checkout: a contributor's fork whose LICENSE and
 * README still name this account is not a failure, it is a fork.
 */

/** This fork, as `owner/name`. Renaming the repository is an edit to this line. */
export const FORK_REPO = 'vitorengers/vibemaxxing';

/** `{ repo, owner, name }` — the same fact, in the three shapes the callers want it in. */
export function repoIdentity() {
  const [owner, name] = FORK_REPO.split('/');
  return { repo: FORK_REPO, owner, name };
}

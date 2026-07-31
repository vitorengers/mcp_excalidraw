/**
 * The one place that says which GitHub this board reads, and the words it refuses the rest in.
 *
 * **The decision (#322): `github.com` is a requirement of this tool, not a default it happens
 * to have.** GitHub Enterprise Server, and every other forge, are out of scope until somebody
 * asks for them — resolving a host per workspace (`GH_HOST`, `gh config get -h`, a setting in
 * `board.config.json`) is a larger change than the audience it currently has, and it would have
 * to reach five patterns, the `gh` invocations under them and the documentation around them.
 * Stating the requirement is the honest version of what the code already did.
 *
 * What is *not* acceptable is the state this replaces: five separate patterns each assuming
 * github.com in silence — the issue URL guard, the URL taken out of an agent's output, the
 * project URL parser, the `origin` remote parser and the URL rebuilt for an interrupted run —
 * and a reader with an enterprise URL told it was malformed. A refusal that names its
 * requirement is a decision somebody can act on; `Not a GitHub issue URL` about a URL that
 * plainly is one sends them hunting for a typo that is not there.
 *
 * So: the host is a value here, the refusals are written here, and
 * `scripts/check-github-host.mjs` holds all five patterns to the same answer for the same URL.
 * The four that stay where they are carry a line pointing back at this file — a pattern next to
 * what it guards is worth more than one assembled out of fragments, but an assumption nobody
 * wrote down is worth nothing at all.
 */

/** The only host this board reads issues, projects and repositories on. */
export const GITHUB_HOST = 'github.com';

/**
 * Why an issue URL was refused: the host is the requirement, not the URL's shape.
 *
 * Shared by every route that takes an issue URL and by the reader underneath them, so the
 * enterprise user meets one sentence rather than three. The URL is quoted back because the
 * reader pasted it, and the working form is shown because the two differ by a hostname.
 */
export function issueUrlRefusal(url: string): string {
  return `This board only reads issues on ${GITHUB_HOST}: ${url || '(nothing)'}. `
    + `An issue URL looks like https://${GITHUB_HOST}/owner/repo/issues/1.`;
}

/**
 * `owner/name` out of a git remote on github.com, or null for a remote anywhere else.
 *
 * Every shape git stores one in: `git@github.com:owner/repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@github.com/owner/repo.git`, with or without the `.git`, with or without a userinfo
 * before the host.
 *
 * **Anchored at the host, which it was not.** The pattern used to look for `github.com`
 * anywhere in the remote's text, so `https://mygithub.com/acme/tools.git` parsed as
 * `acme/tools` — and an interrupted run in that checkout was announced with a link to
 * `github.com/acme/tools`, a repository belonging to somebody else entirely on a host the
 * operator had never named. A host requirement that silently rewrites one host into another is
 * worse than no requirement.
 */
export function repoFromRemoteUrl(remote: string | null | undefined): string | null {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(REMOTE_URL);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * A remote on this host and nothing else.
 *
 * Read left to right: an optional scheme, an optional `user@` or `user:token@`, then the host
 * itself — as the whole of it, because the anchor is the point — then the separator git uses
 * for each form, the owner, and the name with an optional `.git` and trailing slashes.
 */
const REMOTE_URL =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/i;

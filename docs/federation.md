# Two machines, one tab strip

Your desktop runs a board. Your laptop runs one too. This page is about the arrangement where
the laptop's tab strip carries the desktop's projects beside its own: what it is, what you
approve to get it, and what becomes of those tabs when the desktop goes to sleep.

It states the shape rather than the route list. Which call is made where is
[rest-api.md](rest-api.md), and what a project is at all is
[workspaces.md](workspaces.md).

## What is here today, and what is not

The half a person can perform is **pairing**, and it is documented from the host's end: a second
machine asks, you approve it on the machine the board is actually running on, and it holds a
credential of its own afterwards. [SECURITY.md](SECURITY.md#pairing-a-second-machine) is the
gesture and [devices.md](devices.md) is the list it writes into.

The half this page describes — a strip that answers for two machines — is being built, and this
document was written before it rather than after it. What follows is the design it is being
built to, and the parts that are not running yet say so where it matters. If a sentence here and
the board in front of you disagree, the board is right and this page is the defect;
[development-log.md](development-log.md) is the dated record of what actually landed.

## Each machine runs its own board

The second machine is not a browser pointed at the first machine's server. It runs a board of
its own — its own process, its own state directory, its own registry of projects — and its page
is served by it, talks to it, and to nothing else. When a tab on that strip belongs to the
desktop, it is the laptop's **server** that asks the desktop, over a connection between the two
servers, and the answer comes back to the page down the one connection it already had.

That is a single decision, and three things this design would otherwise have to solve are paid
for by it.

**There is no cross-origin request to allow.** Every call the page makes is same-origin and
always was: `apiUrlOn` in `frontend/src/App.tsx` decorates a *relative* path with the board a
request is about, so a request naming another machine's project is the same shape, to the same
server, as a request naming a local one. Nothing in the frontend learns a second address, and no
policy is widened for a peer.

**The origin gate's invariant survives intact** — only a board's own page may drive it.
`src/core/origin-gate.ts` refuses a request whose `Origin` is some other board's and whose
`Host` is not an authority this server answers for, which is what closes DNS rebinding and what
makes a page at any origin harmless. A page fetching a peer directly is precisely the shape that
gate exists to turn away, so a federation built in the browser would have to argue that gate
down. This one does not touch it.

**The peer credential never enters a browser.** The secret this machine presents to another one
is read from a file by this process and used by this process. `frontend/src/auth.ts` attaches a
credential to same-origin requests only and deliberately sends nothing across origins — so a
page talking to a peer would either send no credential and be refused, or be taught to carry a
second machine's secret in a tab. Neither is a thing worth building, and neither has to be.

## What you approve is a machine, not a URL

A peer link starts as an approval, and the approval is the one already written down: the board
that will be reached raises a dialog naming what asked, the code is compared on the two screens,
and refusing is as available as approving.

Three properties of that credential are what make a peer link something you can reason about
six months later.

- **The host mints it.** The machine being reached is the machine that makes the secret;
  `src/core/device-registry.ts` is the only thing there that writes one, and what it keeps is a
  hash. The asking machine holds the secret, the host only ever verifies one, so the list on the
  host is a list of devices rather than a set of keys.
- **It survives a restart.** The board's own token is per start — a restart hands it on, a fresh
  start replaces it — and that is exactly the property that makes it unusable as a way to let a
  second machine in. An approved device is on a list on disk instead, and is still on it
  tomorrow.
- **It is revocable one at a time**, and a revocation bites on that machine's next request
  rather than at the next restart. Taking one link away is not taking them all away.

So what is on the list is a machine you looked at, on a day you were at both keyboards, with a
code you compared. The address is how this board finds that machine again, not what you
approved: a peer that moves to a new address is the same approval, and a second machine is a
second row rather than a second URL under the first.

## Where the link crosses

By default a board answers on loopback only, and that default is a decision rather than an
oversight: `HOST` is `127.0.0.1`, and everything the guards below do is written for the day it
is not. [running.md](running.md#which-addresses-it-answers-on) is the operator's half — which of
the two shapes to write, and what each is worth — and it is worth reading before either machine
is put where the other can reach it.

Two guards stand between the machines, and they refuse for different reasons. **Who is calling**
is `src/core/caller-gate.ts`: a request that did not arrive from the machine the server runs on
is answered **403** by nearly every route worth reaching. That guard is what a paired device has
to get past, and since #522 an approved device is the one caller that does — the credential is
minted, the token gate accepts it, and this guard reads the same record. A caller holding
anything else, the other board's own token included, is refused there exactly as before.
**What the caller asked for** is the origin gate's `Host` pin, and it is the trap in this design
that looks like a credential failure and is not: a board reached under its name on a private
overlay is being asked for an authority it does not answer for, and refuses with a 403 that has
nothing to do with any secret. Approving a device is now what tells it about that name — the
record carries the authority the device arrived under, and the set is rebuilt when the registry
changes — so `EXCALIDRAW_ALLOWED_HOSTS` is for the names no approval put there, an alias or a
proxy in front of this board. A link that is refused for that reason and reported as a credential
problem sends its operator to fix something that was never broken, which is why the states in the
next section separate the two.

## What stops when the laptop sleeps

A machine that is asleep does not refuse a connection — it hangs, which reads as nothing at all
until something gives up waiting. So a peer's tabs carry a state of their own, and it has four
values:

| State | What it means |
|---|---|
| `checking` | Nothing has been heard from that machine yet this round. A real state, not the absence of an answer, so the first reading after a start is honest rather than a guess |
| `online` | It answered, and it accepted this board's credential |
| `unreachable` | Nothing answered inside the budget: the machine is asleep, off, or not on the network you are both on |
| `refused` | Something answered and would not have this board: a credential that is no longer on its list, or a name it does not answer for. The reason says which |

**A machine that stops answering is not a broken project.** When the desktop sleeps its projects
stop being tabs, and what is left is the peer itself, labelled and carrying the reason. Nothing
local changes: your own projects are untouched, and no run refuses because a laptop somewhere is
shut.

That sentence is the whole reason the state is a separate field. A project already has an
`error`, and it means one thing — its configuration could not be resolved. It is drawn with a
warning marker on the tab, and it **gates behaviour**: an implement run refuses outright on a
project carrying one, and the implementation queue treats that board as unusable. Writing *the
laptop is asleep* into that field would be a transient fact about a network wearing the clothes
of a permanent fact about a configuration, and the cost of the confusion is runs refusing on
projects that have nothing to do with any laptop. The two are rendered together and neither
displaces the other: a project can be misconfigured on a machine that is answering perfectly,
and a well-configured one can be on a machine nobody can reach.

What stops with the machine is everything that needed it: its boards, its shells, its agent
runs. A tab you cannot open is telling you something true about a machine, and the state and its
reason are there so that it reads as that rather than as a fault in the board in front of you.

## The asymmetry

There are two registries, one on each machine, and **they are independent**. This is the part a
reader has to be told rather than left to discover.

- The machine that **approves** keeps a device record: what it let in. That is `devices.json`,
  written by `src/core/device-registry.ts`, and it is what [devices.md](devices.md) lists.
- The machine that **asks** keeps a peer record: which board approved it, where that board
  answers, and the secret to present. It holds the secret rather than a hash, because this end
  has to present one rather than check one, and the file's permissions are the whole of its
  defence.

Neither writes to the other, and neither is told when the other changes. So:

- **Forgetting a peer** removes the secret from this machine. The device record on the other
  machine is untouched, and it stays on that operator's list until they revoke it. The link is
  dead from here; from there it is a row that has stopped being used.
- **Revoking a device** stops that machine's requests on the next one it makes. The peer record
  on the other side is untouched, so that board goes on trying and its tabs settle on `refused`
  with a reason naming the credential.

To be rid of a link altogether, do both: forget the peer on the machine that asks, and revoke
the device on the machine that answers. Doing one and assuming the other is what leaves a row
nobody recognises on a list somebody reads in six months, which is the failure
[devices.md](devices.md) is written against.

## What does not cross

**No absolute path, no path inside a WSL distro, no distro name.** A project appearing on
another machine's strip carries what a tab strip needs — a name, an id, and enough to tell it
apart from a project of the same name on another machine — and nothing about the disk it lives
on. The projection is built by naming the fields it includes rather than by removing the ones it
must not, so a field added to a project next year is absent from the wire until somebody decides
otherwise.

**Not the asking board's own token.** That secret is this server's, for callers on this machine;
the peer's is a different one entirely, and sending both would offer the peer a choice it should
never be given. The device credential replaces it, in one place, on the way out.

**Not the peer's secret, into anything readable.** It appears in no log line and in no error
handed back to a page, on either machine.

## The files it is being built in

The first six of them have landed; the rest are named here so the reader of a pull request can
see where each decision lands.

```
src/core/peer-liveness.ts          the four answers above, and which refusal you are looking at
src/core/remote-workspace-id.ts    what this board calls a peer's project, and the inverse
src/core/remote-workspace-view.ts  which fields of a project cross, and what replaces the path
src/core/peer-registry.ts          what this board keeps about a board that approved it
src/core/reply-ledger.ts           which machine a reply belongs to, when it names only a request
src/core/peer-client.ts            one board's HTTP call to another, and what each failure means
src/core/peer-request-rewrite.ts   what a request says by the time it belongs to the peer
src/core/peer-proxy.ts             the seam that sends a request to the machine that owns the board
```

The id module is where a peer's project gets the name it wears here, and it is a pure pair of
functions with no caller either. What it settles is that the name survives the *other* board's
normaliser: that function does not reject a spelling it dislikes, it rewrites it to the shared
`default` board, so a scheme punctuated with anything outside `.`, `-` and `_` would put a socket
on the wrong scene and log nothing. It answers both directions, because the second one is what
the wire needs — given a local id, the spelling the peer itself expects back — and a project that
cannot be named inside the length a workspace id has is refused by a sentence rather than
shortened into a valid id for a different board.

The view module is the paragraph above — *what does not cross* — as code, and it has no caller
either. Three fields of a project cross, named one at a time; the other fourteen are on a
withheld list in that file with the reason beside each, so a field added to a project next year
is absent from the wire until somebody edits this. It also decides what replaces the path in the
tab's tooltip, since a peer's project has none here: the project's own name and the name this
board calls the machine by, which is enough to tell two projects of the same name apart and is
this board's own word rather than anything the owner sent.

The registry is a module with no caller: it owns `peers.json` beside the state directory's other
files, and nothing yet adds a row to it or presents what a row holds. What it settles is the
asymmetry above — the record here keeps the secret rather than a hash, so the file is owner-only
and every update swaps it whole rather than rewriting it in place, and a reader looking at it
while a peer is renamed or forgotten never finds it missing or half-written.

The reply ledger is the answer to a question the section above does not raise and the wire does:
a reply that names only the request it answers. Five `POST /api/export/image/result` sites and two
`POST /api/viewport/result` sites in `frontend/src/App.tsx` carry a `requestId` and no workspace,
which is exactly right on one machine — the server that asked is the server that is answered — and
unroutable once the request came down a link. The ledger is what a forwarder consults instead of
the parameter that is not there, and it is a separate module from both transports so that the HTTP
forwarder and the socket forwarder cannot each keep their own and disagree. Three properties make
it something a forwarder can rely on: it is keyed by the request id, because that is the only
thing the reply carries and everything else is a key two live requests can share; resolving
**consumes** the id, so a duplicate post is not delivered a second time; and an entry expires no
later than the request it describes, on that request's own budget, so a peer that sleeps mid-render
leaves nothing behind. It has no caller either.

The client is the thing that performs the call, and it too has no route and no caller yet. Two
decisions give it its shape. **The header discipline is the whole of its security**: the outgoing
request is built by naming the headers that cross, so this board's own token stops here in both
of the spellings a caller can offer it in, exactly one credential reaches the peer, and
`x-client-id` arrives byte-identical — a substituted one would get the reader its own writes
echoed back. **And a failure comes back as a value rather than as an exception**, carrying one of
the four states above and a sentence for the operator: a connect timeout, a read timeout, a 401
and the two 403s are five different repairs, and the budget a connection is given to open is
stated separately from the budget the answer is given to arrive, because a machine that is asleep
and a board that is answering slowly are not the same thing. A redirect is not followed and is
reported as its own outcome, since a peer answering 3xx is not the board this device paired with.

The rewriter is the decision about what that call *says*, and it is a pure function with no
`fetch` in it and no caller yet either. Three things give it its shape. **The board is named in
exactly one place on the way out**, for the same reason the credential is: this server reads a
board off a query parameter, off a body field and off a header, so all three spellings come off
the request and the peer's own id goes back on once — which makes one request expressed three
ways one outbound request byte for byte, rather than three that agree about the board and differ
everywhere else. **What it built is read back by the reader that will read it**, `workspaceIdFrom`
itself rather than a restatement of it, because a spelling the peer dislikes is not refused there,
it is answered from the shared `default` board. **And a request that belongs to the machine it was
asked of is refused rather than rewritten**, each with the reason quoted: a restart ends that
process and every agent it hosts whichever board asked, the directory picker can only read the
disk its own process reaches, and the reply half of a render carries an id and no board at all. A
rewriter that will rewrite anything handed to it is one bug away from forwarding each of those.

The milestone that files them is *One tab strip, two machines*, and the design decisions above
are each a done-when bullet on one of its issues rather than a preference stated here.

The far end of the chain has landed too: the tab strip has the slot to draw a state in.
`WorkspaceSummary.status` in `frontend/src/components/WorkspaceTabs.tsx` is what a tab reads,
and nothing supplies it yet — a project without it draws the row it always drew. See
[canvas-frontend.md](canvas-frontend.md) for how a liveness state and a config error sit on one
tab without displacing each other.

**The union is written twice, and that is a constraint rather than a choice.**
`WorkspaceStatusState` there and `PeerLivenessState` in `src/core/peer-liveness.ts` are the same
four words. The frontend cannot import the second: that module opens sockets, so it imports
`net`, and the frontend's own `tsconfig` compiles everything it can reach. Two copies of four
words is two chances for one of them to learn a fifth, so
`scripts/check-workspace-tab-status-browser.mjs` reads both files and fails if they stop
agreeing.

## Related

- [SECURITY.md](SECURITY.md) — the trust model, the token, the gates, and the pairing gesture
- [devices.md](devices.md) — who can reach my board: the list, the rename, and the revoke
- [workspaces.md](workspaces.md) — what a project is, and what a board is pointed at
- [rest-api.md](rest-api.md) — every route, and which of them answer whom
- [running.md](running.md) — the run procedure, and which addresses a board answers on
- [whats-next.md](whats-next.md) — what has not shipped

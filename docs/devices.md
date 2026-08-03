# Who can reach my board

This board answers to two kinds of caller, and they are not the same thing.

**The machine it runs on.** The board writes a secret at startup into `server-<port>.token` in
its state directory, owner-only, and everything running as you can read it — the launcher puts
it in the URL it opens, the CLI and the MCP server read it off disk. That credential is a file,
not a device: it is per start, it is not on any list, and there is nothing to revoke about it
short of restarting. Throughout this page it is **the host**.

**A device you have approved.** A second machine — a laptop across the desk, a phone — holds a
credential of its own that survives a restart and that you can take away one at a time. Every
one of those is a row on the list below. See [SECURITY.md](SECURITY.md) for what approving one
grants, which is not a small thing.

## The list

**Devices**, on the board's own bar, beside the project settings and to the left of Clear
Canvas. It opens on a board with no project registered at all, which is the state a fresh clone
is in: who can reach this board is a fact about the server, not about anything drawn on it.

Each row carries the four things you cannot judge a device without:

| Column | What it is for |
|---|---|
| The name | **Editable here.** The registry holds whatever the device proposed for itself when it was approved, and `MacBook-Pro-3` is not what its owner calls it. Rename it to something you will recognise in six months, because that is when you will be reading this list |
| Last seen | The last request that device made. This is what tells a device in use from one nobody has opened in months — `never` means it was approved and has not been used since |
| Approved | When you approved it |
| From | The address the approval was made from, verbatim |
| Host | The authority that device was approved *for*. Recorded per device rather than globally, so approving a laptop that reaches this board under one name does not bless that name for everybody. A row naming something you do not recognise is worth reading twice |

Nothing on this page shows a device's secret, and no route hands one out. The registry stores a
SHA-256 of it and the server only ever verifies: the device is what holds the credential, and
after the approval there is no copy anywhere else. A `devices.json` somebody reads is therefore
a list of devices and not a set of keys.

## Revoking one

**Revoke**, on the row, behind a confirmation that names the device.

It takes effect on that device's **next request**, not at the next restart. The registry is read
from disk every time a credential is verified, so there is no cache to wait out and no button to
press afterwards.

It also **closes the connections that device is holding open**. This is the half you cannot see
and it is the half that would otherwise still be sending: a board's WebSocket streams the scene
and every live terminal's scrollback for as long as it stays open, so a revocation that only
made the next HTTP request fail would take a laptop off the list, show it gone here, and go on
publishing the board and every shell to it. The dialog says how many connections it closed.

### Revoking the device you are reading this on

Allowed, and warned about rather than refused. On the host it cannot happen at all — the host is
not on this list — and for a credential arriving from this machine it is the ordinary "sign this
machine out". The board stops loading there, and that machine cannot reach this board again until
it is approved afresh.

There is no way to lock yourself out of your own board from here. The host's credential is a
file in your state directory, and this page cannot touch it.

## Who may see the list

**You, on the machine the board runs on.** Every route behind this page reads the caller's own
socket address and refuses anybody else — a device you approved included, from wherever that
device is.

That is a decision rather than an omission, and it was made when the credential started working
from another machine (#522). Widening the funnel in front of the board was the point of that
change; widening the list, the rename and the revoke along with it would have put the management
surface on the network as a side effect of a change about the scene, so a second machine could
enumerate every other machine you have approved and take one off. The list is short and you are
the one who reads it. Sign a machine out from here, where you can see all of them.

What that costs is *sign this machine out*, pressed on the machine being signed out. Revoke is on
this page instead, one row along from the device you want gone, and it takes effect on that
device's next request wherever that device is.

Which credential a caller holds still decides the answer for the two that can arrive from this
machine: a device credential presented here may rename nothing, and may revoke exactly itself.
Anybody else gets 401 from the same gate that guards the rest of `/api`, and a caller that is not
on this machine gets 403 before that gate is asked — see [rest-api.md](rest-api.md) and
[SECURITY.md](SECURITY.md).

## If you have edited the file by hand

`devices.json` lives beside the pidfile in the state directory
([configuration.md](configuration.md)), owner-only, and it is readable on purpose — it is a list
of devices, not a set of credentials.

A file that cannot be parsed reads as **no devices**, with a line in the log saying which file
and why. That is deliberate: a board that refused to start because somebody opened this in an
editor would come up unhealthy, or not at all, on exactly the machine whose operator is trying
to find out what went wrong. The devices are not lost — repair the file, or approve them again.

## The routes behind it

`GET /api/devices`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id`. They are in
[rest-api.md](rest-api.md) with the rest, and `src/core/device-registry.ts` is the only thing
that reads or writes the file.

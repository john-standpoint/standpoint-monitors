# standpoint-monitors

Scheduled probes that watch **standpoint.ch** and **scan.standpoint.ch** and turn a
run red when something is wrong. Tier 0 of the reliability plan.

No dependencies, on purpose. Node 22's built-in `fetch` and `node:test` are enough,
and a monitor that can be broken by a supply-chain update is a monitor that will be
broken on the morning you need it.

---

## Why this exists

Every documented outage in this estate was **invisible**, not hard to detect. In each
case the signal already existed and nobody was on the other end of it.

| Outage | Duration | What witnessed it |
|---|---|---|
| Calendly token dead on Infomaniak | 24 hours | one `console.warn` |
| Audit registry rejecting every registration | 19 days | a non-blocking 401, by design |
| Bright Data key emptied to 0 bytes | 9 days | an empty file, which reads like an absent one |

So this repository adds **no new checks to the systems themselves**. It puts a
watcher on the signals they already emit.

## ⚠ The one rule that must not be simplified away

**The assertions read response BODIES, not status codes.**

`scan.standpoint.ch/api/health` returns **HTTP 200** while `ticket` is `off` and while
`register` is `admin-only`. That is correct on its side — those are config states John
may have chosen during a deploy window, and paging for a deliberate choice trains a
monitor to be ignored.

The consequence here is absolute: **a conventional uptime monitor watching the status
code would have reported green through the entire nineteen-day registry outage**, while
two delivered audits went missing from the dashboard. It would report green today if
`SCAN_TICKET_SECRET` vanished from Vercel.

If this probe is ever reduced to "assert 200", it stops doing the only thing it was
built for.

## The three parts, and why none is redundant

| Part | Covers | Blind to |
|---|---|---|
| **This repo's Actions probe** | JSON bodies, build markers, config modes | GitHub being down; this workflow being disabled; this repo being broken |
| **An external uptime monitor** | the host answering at all, from outside GitHub | anything inside a 200 response |
| **A dead-man's switch** | *this probe silently ceasing to run* | the detail of what broke |

⚠ **GitHub disables scheduled workflows after 60 days of repository inactivity.** No run,
no failure, no mail — a monitoring system that has stopped monitoring looks exactly like
one with nothing to report. The dead-man's switch is the only thing that catches that,
which is why `--deadman` runs on the most frequent suite and why a missing `DEADMAN_URL`
is a **hard failure** rather than a skipped step.

## Suites

| Suite | Cadence | Severities | Checks |
|---|---|---|---|
| `fast` | **~hourly, best-effort** (asks for every 15 min) | page | home · availability · scan health |
| `daily` | 06:07 UTC | page + warn | + robots.txt |
| `weekly` | Mon 06:23 UTC | page + warn | + sitemap · hidden page |

### ⚠ The fast suite does NOT run every 15 minutes, and this table used to say it did

Measured over the first night (2026-08-16/17) from the dead-man's switch's own ping log —
gaps between consecutive successful runs, in minutes:

```
20, 10, 27, 21, 11, 109, 59, 47, 47, 50, 41
median 41 · worst 109 · degrading (first five avg 18, last six avg 59)
```

None landed on the requested slots. GitHub documents the `schedule` event as best-effort:
delayed under load, and skipped outright when busy. **A `*/15` cron behaves like an hourly
one.**

The cron still asks for four an hour, deliberately — asking for four and getting one beats
asking for one, and on quiet nights GitHub does deliver several. **What was corrected is
the claim, not the request.**

⚠ **The dead-man's switch must be sized from that measurement, not from the cron.** It is
period **60 min**, grace **30 min**. The first configuration used 15/20 — sized from the
number I wanted to be true rather than from any observation — and produced **eight downtime
mails in one night against a probe that had never actually stopped.** That is precisely the
alert-fatigue failure this file argues against below, manufactured inside the tool built to
prevent it.

✅ **Recorded as a success too.** Nothing else could have caught this: every run that *did*
happen was green, the Actions tab showed success, and a probe cannot observe its own
absence. The dead-man's switch found a false claim in its own repository within 18 hours,
which is the whole argument for it being one of three parts.

**page** — the public product is broken for a visitor right now.
**warn** — a control or bookkeeping path is wrong; nobody is turned away, but it will
cost money, data or trust if left.

A warning **turns a run red**. It just does not turn every fast run red: `fast` filters
warnings out, `daily` does not. One red daily run until it is fixed is loud enough to act
on and quiet enough not to mute.

⚠ The tempting alternative — print the warning and exit 0 — recreates the exact failure
this repository was built after. A warning that only reaches a log reaches nobody.

## What is checked

1. **Homepage is the live build.** Canonical on `standpoint.ch`, `index, follow`, no
   `noindex`, Plausible present, no `new.standpoint.ch` anywhere, body not implausibly
   small. These are the four markers `deploy-staging.yml` names as what a staging build
   published over production looks like — "completely normal to a human", surfacing weeks
   later in Search Console.
2. **robots.txt** invites crawling, points at the live sitemap, and still names all six
   AI agents.
3. **Booking calendar** is `drawable` (page) and not `stale` (warn). ⚠ The two are
   separate on purpose — conflating them is what hid the 24-hour outage, and paging on
   `stale` would fire on ordinary healthy days.
4. **Scan health** — `db` (page), `ticket`, `register` (warn), all read from the body.
5. **Sitemap** has not lost pages, and every URL is on the live origin.
6. **Hidden page** `/setup-a-session/` is still reachable **and** still absent from the
   sitemap — asserted in both directions, because a check that only asked "absent from
   the sitemap?" passes with flying colours on a page that has been deleted.

## ⚠ No latency threshold is set, and that is a decision

Timings are **recorded on every run and asserted on by nothing**. The only samples
available when this was written were cold starts — 466 ms from `/api/health` on
2026-08-16, 602 ms on 2026-08-04. Setting a timeout from a cold start is how a new
monitor pages on a healthy system during its first idle period, after which it is muted
and worse than nothing.

**After a week of warm samples, come back and set one from the data.**

## Running it locally

```sh
node --test                    # prove every check can fail
npm run probe                  # fast suite against production
node probe.mjs --suite weekly  # everything
```

Exit codes: `0` clean · `1` page failure · `2` warnings only · `3` dead-man's switch
requested but not configured.

## ⚠ `node --test` is the most important file here

`checks.test.mjs` feeds every assertion a **deliberately broken fixture** and requires it
to go red — a staging build served over production, a dead Calendly token, `register:
admin-only` behind an HTTP 200 — and feeds the good fixture and requires a pass.

A monitor that has only ever been observed passing is indistinguishable from one that
cannot fail. **Adding a check without adding its red test is adding a check nobody knows
works.**

## Secrets

| Secret | Used by | If missing |
|---|---|---|
| `DEADMAN_URL` | `probe-fast` | **Hard failure, exit 3.** Never a silent skip — see below. |

The natural way to write the ping is `if (!url) return;`. That would reproduce, inside
the very tool built to prevent it, the bug that cost this estate nine days of a dead
Bright Data leg: **a silent fallback reads exactly like a passing check.**

## Cost

⚠ **The requested cadence is free only because this repository is public.** GitHub bills
Actions in whole minutes per job. A `*/15` cron *asks* for ~2,880 minutes a month — above
the 2,000-minute free tier for a private repository — even though GitHub currently
delivers closer to a third of that. **If this repo is ever made private, drop that cron to
hourly**, or the overage arrives silently. ⚠ **Do not size that decision from what GitHub
happens to deliver today**: the request is what would be billed if the scheduler ever ran
it as asked.

Nothing here contains a secret: all live in GitHub Secrets, and every URL probed is
already public.

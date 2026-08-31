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
which is why `--deadman` runs on the most frequent suite and why a missing dead-man URL
is a **hard failure** rather than a skipped step.

⚠ **As of 2026-08-31 `probe-daily` has its own switch too** — see *Secrets* for why that is
not the masking bug the original one-suite rule was guarding against. ⚠ **And the fast
suite's switch is now also fed by an external hourly trigger (cron-job.org), so a green
switch no longer proves GitHub's `schedule` delivery is working.** Read the run list for
that; the switch will not tell you.

## Suites

| Suite | Cadence | Severities | Checks |
|---|---|---|---|
| `fast` | **~hourly, best-effort** (asks for every 15 min) | page | home · availability · scan health |
| `daily` | 06:07 UTC | page + warn | + robots.txt |
| `weekly` | Mon 06:23 UTC | page + warn | + sitemap · hidden page |

### ⚠ The fast suite does NOT run every 15 minutes, and this table used to say it did

Measured from the dead-man's switch's own ping log — **31 gaps between consecutive
successful runs over two nights** (2026-08-16 → 18), in minutes:

```
10 11 20 20 20 21 21 21 22 27 29 31 33 33 33 35 36 39 41 42
46 47 47 49 50 51 52 59 62 98 109

median 35 · p95 98 · max 109
```

None landed on the requested slots. GitHub documents the `schedule` event as best-effort:
delayed under load, and skipped outright when busy. **A `*/15` cron behaves like an hourly
one.**

The cron still asks for four an hour, deliberately — asking for four and getting one beats
asking for one, and on quiet nights GitHub does deliver several. **What was corrected is
the claim, not the request.**

### ⚠⚠ The dead-man's threshold was wrong twice. Read this before tightening it.

| Setting | Tolerance | Result |
|---|---|---|
| period 15 / grace 20 | 35 min | **8 false alarms in one night** |
| period 60 / grace 30 | 90 min | **1 false alarm** — a 98-min gap |
| **period 60 / grace 90** | **150 min** | 0 breaches over 31 gaps, ~37% headroom |

The first was sized from the cron the workflow *asks* for. The second was sized the morning
after the measurement — **from a dataset whose maximum was 109 minutes, to a threshold of
90.** Set below a number sitting in the data used to justify it.

⚠ **"Size it from the measurement" is not satisfied by having taken a measurement.** Size
it from the **maximum**, with headroom.

⚠ **THE COSTS ARE NOT COMPARABLE, WHICH IS WHY THE THRESHOLD SITS WELL ABOVE THE MAXIMUM
RATHER THAN NEAR IT.** A false alarm costs trust in every alert this system will ever
send — the failure this file argues against at length. A late alarm costs an extra hour of
not knowing that **the monitor** has stopped; the site itself keeps mailing on every run
that happens.

✅ **Recorded as a success too.** Nothing else could have caught any of it: every run that
*did* happen was green, the Actions tab showed success, the external uptime monitor saw a
healthy site. **A probe cannot observe its own absence.** The switch found a false cadence
claim in its own repository within 18 hours of going live, then caught its own
miscalibration the night after. That is the whole argument for it being one of three parts.

**page** — the public product is broken for a visitor right now.
**warn** — a control or bookkeeping path is wrong; nobody is turned away, but it will
cost money, data or trust if left.

A warning **turns a run red**. It just does not turn every fast run red: `fast` filters
warnings out, `daily` does not. One red daily run until it is fixed is loud enough to act
on and quiet enough not to mute.

⚠ The tempting alternative — print the warning and exit 0 — recreates the exact failure
this repository was built after. A warning that only reaches a log reaches nobody.

## ⚠ The alert has to carry the diagnosis, or the log is where it dies

Every failure line names three things — what was checked, what was expected, and **what
was actually observed** — because the observed value is usually the whole answer.
`ticket=off` is not a symptom to investigate; it is the diagnosis.

**GitHub's failure notification drops exactly that part.** Discovered 2026-08-16 by
running the deliberate failure in `SETUP.md` step 7 rather than by reading any code: the
mail said *"All jobs have failed"* and *"Failed in 7 seconds"*, while

```
Sitemap has LOST pages — 44 URLs, floor is 9999
```

sat one click away, behind a login, on a phone, at night. An alert that costs a debugging
session to interpret is an alert that gets opened later each time.

So since 2026-08-20 `report()` emits every failure a **second** time as a GitHub workflow
annotation — `::error::` for a page, `::warning::` for a warn. The console lines are for
someone already reading the log; the annotations are for someone who is not.

### ⚠⚠ AND THAT STILL DOES NOT PUT IT IN THE MAIL. MEASURED, NOT ASSUMED.

The item this was built from asserted that *"GitHub does surface annotations in the
mail"*. **That was an assumption written as a finding, and it is false.** Proven the same
day by running the deliberate failure and photographing the resulting email, which reads
in its entirety:

```
Probe · weekly (structure): All jobs have failed
Status | Job                                          | Annotations
  ✗    | Probe · weekly (structure) / Structural      |   💬 3
       | checks — Failed in 8 seconds                 |
```

**A count. Not the text.** The sentence `Sitemap has LOST pages — 69 URLs, floor is 9999`
was in annotation 2 of those 3, and the mail did not carry one word of it.

**What the annotations did buy**, and it is not nothing: the diagnosis now sits in a red
box on the run **summary** page — the first page the "View workflow run" button lands on —
instead of inside the job log, four clicks and one expanded step deeper. **Four clicks to
one.** That is worth keeping. It is not what was asked for.

### ✅ What did work: a second channel, tested before it was built

healthchecks.io accepts a POST body on `/fail` and prints it in its own alert mail under a
**Last Ping Body** heading. **Measured 2026-08-20 against a throwaway check, before a line
of code was written** — ⚠ and the healthchecks docs do *not* promise this: "Attaching Logs"
says the body is stored and points at the web UI's Events section, saying nothing about
notifications. The previous remedy was believed on the strength of a plausible sentence and
cost a build. This one was believed on the strength of an email.

So `--alert` POSTs the full failure text — every failure the suite allows, each with its
observed value, plus the run URL — to a **per-suite** check:

```
standpoint-probe-fast    standpoint-probe-daily    standpoint-probe-weekly
```

⚠ **PER-SUITE, AND NOT FOR TIDINESS.** With one shared check, a weekly sitemap failure
would alert and then the next *fast* run — up to an hour later — would post success and
healthchecks would mail **"UP"** while the sitemap was still short 25 pages. **A recovery
notice for something that has not recovered is the green-while-blind failure, delivered by
mail.** Per-suite, a weekly failure stays down until a weekly run passes.

⚠ **These three checks are NOT a second liveness monitor.** Their periods are set
deliberately loose (`SETUP.md` step 7b) because liveness belongs to the dead-man's switch,
which is calibrated, proven, and pinged by exactly one suite. These exist only to carry
text.

⚠⚠ **AND THE FIRST VERSION OF THIS BROKE ALL THREE SUITES, BY APPLYING THE RULE AT THE TOP
OF THIS FILE WHERE IT DOES NOT HOLD.** The acceptance check required the response body to
start with `OK` — reasoning from *read the body, not the status*. The ping that
**auto-provisions** a check answers `HTTP 201` with the body `Created`, so the guard
rejected the one response that meant everything had worked, and every suite exited 3 on its
first live run.

**The rule is a statement about a particular service, not a law of HTTP.** It holds for
`/api/health`, which answers 200 while broken. It holds for healthchecks' **UUID**
endpoints, which answer `200 OK (not found)` for a check that does not exist. It does not
hold for healthchecks' **slug** endpoints, which return honest status codes. The decision
now lives in `alertPingAccepted(status, body)` — pure, exported, and tested, which the
original could not be, because it was buried inside a function that makes a network call.

⚠ **A missing `HC_PING_KEY` under `--alert` is a hard failure, exit 3** — and a *clean* run
whose alert channel is broken exits 3 as well, because nothing else would ever notice: the
probe is green, GitHub is quiet, and the one path carrying a diagnosis is dead until the
day it is needed.

⚠ **They are emitted unconditionally, not gated on `GITHUB_ACTIONS`.** The tidier version
has a state in which the annotations are silently off and reports identically to the
working one. Outside Actions these are two extra lines of text; inside it there is no
branch that can be wrong.

⚠ **When all targets fail at the transport layer, that notice is annotated FIRST**, because
it changes what every annotation under it means. Six red hosts is a convincing picture of
a catastrophe and was wrong the one time it happened.

⚠ **No test in this repository can prove the mail.** `report.test.mjs` proves the
annotation is well-formed, one-line, correctly escaped and carries the observed value.
Whether GitHub surfaces it in the notification is settled only by `SETUP.md` step 7, in a
real inbox — and on 2026-08-20 it settled it in the negative. **That is exactly why the
step exists**, and why "it should appear in the mail" was never a safe thing to write
down.

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
5. **Sitemap** has not lost pages, and every URL is on the live origin. ⚠ It also
   **warns when the floor has drifted** more than 10 pages below the live count — because
   *"remember to raise the floor when you publish"* failed twice on 2026-08-20 alone: it
   sat at 44 against a real 69 for four days, and the corrected 69 was stale within the
   hour when 25 French pages landed. **The gap between the floor and reality is the
   check's blind side, and nothing was measuring it.** A warning, never a page — publishing
   is normal, nothing is broken for a visitor, and an alert that fires after ordinary work
   is an alert that gets muted, taking the real "pages have disappeared" signal with it.
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
| `DEADMAN_URL_FAST` *(or legacy `DEADMAN_URL`)* | `probe-fast` | **Hard failure, exit 3.** Never a silent skip — see below. |
| `DEADMAN_URL_DAILY` | `probe-daily` | **Hard failure, exit 3.** ⚠ Must be its OWN healthchecks check. |
| `HC_PING_KEY` | every suite, via `--alert` | **Hard failure, exit 3** on an otherwise clean run. |

⚠⚠ **ONE SWITCH PER SUITE, AND THEY MUST NOT BE THE SAME CHECK.** Until 2026-08-31 only
`probe-fast` had a dead-man's switch, on the reasoning that liveness must belong to exactly
one suite or a healthy daily run could mask a dead fast one. **That reasoning was right about
the hazard and wrong about the remedy:** it forbids two suites *sharing one switch*, not two
switches. The cost of the conflation was measured when GitHub's scheduler degraded — the
daily suite ran **5 to 12 hours late on five consecutive days and nothing reported it**,
because a suite that does not run emits no red run, no mail and no missing ping.

⚠ **The legacy `DEADMAN_URL` is accepted for the `fast` suite ALONE**, so the pre-existing
secret keeps working. It is deliberately *not* a generic fallback: a daily run resolving to
`DEADMAN_URL` would ping the fast suite's switch and keep it green while the fast probe was
dead — the masking bug, reintroduced by its own fix. `resolveDeadmanUrl` enforces this and
`report.test.mjs` proves it, including by mutation.

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

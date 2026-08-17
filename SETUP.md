# Setup — John's steps, in order

Everything in this file is a thing **only you can do**: this session runs in a Linux
sandbox that cannot create a GitHub repository, cannot push, and cannot open a
monitoring account. The code is written, tested and verified against live production;
what follows is wiring it up.

**Time: about 20 minutes**, most of it waiting for a first run.

⚠ **Do these in order.** Step 5 deliberately comes after step 4, because a monitor
wired up before its first successful run is a monitor whose first signal is a false
alarm — that is how `/api/health` shipped a check that answered 503 against a database
that was perfectly fine.

---

## Step 1 — Check the repo is where you expect it

```sh
cd ~/Developer/standpoint-monitors && ls -a
```

**Expected output** — 11 files:

```
.  ..  .github  .gitignore  README.md  SETUP.md  checks.mjs  checks.test.mjs
package.json  probe.mjs  report.test.mjs
```

If `.github` is missing, stop — the rest will do nothing.

---

## Step 2 — Run the tests and the probe yourself, before any of it is automated

```sh
cd ~/Developer/standpoint-monitors && node --test
```

**Expected output** ends with:

```
# tests 27
# pass 27
# fail 0
```

Then the probe against live production:

```sh
cd ~/Developer/standpoint-monitors && node probe.mjs --suite weekly
```

**Expected output** — six ticks, then `✓ All 6 checks passed.`

```
  ✓ home: Live build served: canonical, indexable, analytics present.
  ✓ robots: robots.txt invites crawling; all 6 AI agents present.
  ✓ availability: Calendar drawable and fresh (147 future slots).
  ✓ scan-health: db ok · ticket enforce · register on (365 ms).
  ✓ sitemap: Sitemap lists 44 live URLs (floor 44).
  ✓ hidden-page: …/setup-a-session/ reachable and correctly absent from the sitemap.
```

**Verification:** `echo $?` immediately after must print `0`.

⚠ **The slot count and the timings will differ from the numbers above and that is
fine.** The only thing that must match is six ticks and exit 0. If a check is red here,
it has found something real on the live site — read it before going further, because
automating a red check just automates the alarm.

---

## Step 3 — Create the repository and push

⚠ **Public, not private.** GitHub bills Actions in whole minutes per job, and the fast
probe's cron *asks* for ~2,880 minutes a month — above the 2,000-minute free tier for a
private repo. Public repos get unlimited free Actions. Nothing here holds a secret, and
every URL it probes is already public.

⚠ **Size that on what is REQUESTED, not on what GitHub delivers.** In practice the
scheduler runs it closer to hourly (see the note in step 5), but the request is what would
be billed the moment GitHub honoured it.

```sh
cd ~/Developer/standpoint-monitors
git init -b main
git add -A
git commit -m "standpoint-monitors: Tier 0 probe, body assertions, dead-man's switch"
```

**Expected output:** `12 files changed`.

⚠ **Twelve, not eleven.** `ls -a` in step 1 shows eleven *entries*, but two of those are `.`
and `..` and one is the `.github` directory holding four workflow files. Corrected here
after the first run through reported 12 against an expected 11 — a stated number that had
never been counted, which is the shape worth catching even when it costs nothing.

Then create it on GitHub. ⚠ **`gh` was unauthenticated on your Mac as of the last
check**, so try it and fall back to the browser:

```sh
gh auth status
```

**If that prints `Logged in to github.com`:**

```sh
cd ~/Developer/standpoint-monitors
gh repo create standpoint-monitors --public --source=. --remote=origin --push
```

**If it does not**, create `standpoint-monitors` at <https://github.com/new> —
**Public**, no README, no .gitignore, no licence — then:

```sh
cd ~/Developer/standpoint-monitors
git remote add origin https://github.com/john-standpoint/standpoint-monitors.git
git push -u origin main
```

The account is `john-standpoint`, read from `standpoint-website`'s own remote rather
than assumed — it is the same account that holds `standpoint-website` and
`current-standpoint-scan`.

**Verification:** open the repo's **Actions** tab. You should see one run of
**Tests · prove the checks can fail**, green. That run proves the checks can fail,
which is the only evidence that any of the rest means anything.

---

## Step 4 — Watch a probe run before wiring any alerting to it

Actions tab → **Probe · weekly (structure)** → **Run workflow** → `main`.

**Expected:** green, ~30 seconds, and the log ends in `✓ All 6 checks passed.`

⚠ **If it is red here, do not proceed to step 5.** Either the site has a real problem or
a check is wrong, and wiring a dead-man's switch to a failing probe means it never pings
and alerts forever.

---

## Step 5 — The dead-man's switch

This is the part that notices when **the probe itself stops**. GitHub disables
scheduled workflows after 60 days of repository inactivity — no run, no failure, no
mail — and a monitoring system that has stopped monitoring looks exactly like one with
nothing to report.

1. Sign up free at <https://healthchecks.io> and create a check:
   - **Name:** `standpoint-monitors fast probe`
   - **Period:** `60 minutes`
   - **Grace time:** `30 minutes`

   ⚠⚠ **THESE NUMBERS ARE MEASURED, AND THE FIRST ONES WERE NOT.** This originally said
   period 15 / grace 20, sized from the cron the workflow *asks* for. GitHub does not
   deliver that cadence — observed gaps on the first night were
   `20, 10, 27, 21, 11, 109, 59, 47, 47, 50, 41` minutes, median 41 — so the switch
   flapped and sent **eight downtime mails in one night about a probe that had never
   stopped.** Sizing an alert from a number you wish were true is the same error as
   setting a latency threshold from a cold start, which this repo refuses to do and warns
   about in three places.

   ⚠ **Detection of a fully-dead probe is therefore ~90 minutes, and that is fine.** The
   dead-man's switch is **not** the outage detector — page-level failures still mail on any
   run that happens. Its only question is "has the probe stopped entirely".
2. Copy its **ping URL** (looks like `https://hc-ping.com/<uuid>`).
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**
   - **Name:** `DEADMAN_URL` — exactly this, case-sensitive
   - **Value:** the ping URL
4. Confirm your healthchecks.io account has an email alert configured — a switch that
   notices silence and tells nobody is the same as no switch.

**Verification** — Actions → **Probe · fast** → **Run workflow**, then check the log
ends with:

```
  dead-man's switch pinged: HTTP 200
```

and that healthchecks.io now shows the check as **up**.

⚠ **If the secret is missing the run FAILS with exit 3, deliberately** — it will not
quietly skip the ping. That is the whole feature: a silent fallback reads exactly like a
passing check, which is what cost nine days on the Bright Data key.

---

## Step 6 — The external monitor

Covers what the Actions probe cannot: GitHub being down, the workflow being disabled,
this repo being broken.

At <https://betterstack.com/uptime> or <https://uptimerobot.com> (both free), create
two monitors:

| URL | Interval | Alert on |
|---|---|---|
| `https://standpoint.ch/` | 5 min | non-200 |
| `https://scan.standpoint.ch/api/health` | 5 min | non-200 |

⚠ **Do not set a response-time threshold.** The only samples we have are cold starts —
466 ms and 602 ms — and a threshold from a cold start pages on a healthy system during
its first idle period, after which it gets muted.

⚠ **This monitor is the shallow one and must not be mistaken for the deep one.**
`/api/health` returns **200** while `ticket` is `off` and while `register` is
`admin-only` — a status-code monitor would have reported green through the whole
19-day registry outage. That is what the Actions probe is for. This one only answers
"is anything answering at all", from outside GitHub.

---

## Step 7 — Confirm failure mail actually reaches you

The alerts are worth nothing if the mail goes to a tab you never open.

1. <https://github.com/settings/notifications> → **Actions** → tick **Email**, and
   **Only notify for failed workflows**.
2. Force one real failure to prove the path end to end:

```sh
cd ~/Developer/standpoint-monitors
sed -i '' 's/const SITEMAP_FLOOR = 44;/const SITEMAP_FLOOR = 9999;/' probe.mjs
git commit -am "TEMPORARY: prove the failure mail arrives"
git push
```

Actions → **Probe · weekly** → **Run workflow**.

**Expected:** the run goes **red** with

```
  ✗ PAGE  sitemap: Sitemap has LOST pages — 44 URLs, floor is 9999.
```

and **an email arrives.** Then put it back:

```sh
cd ~/Developer/standpoint-monitors
sed -i '' 's/const SITEMAP_FLOOR = 9999;/const SITEMAP_FLOOR = 44;/' probe.mjs
git commit -am "Revert the deliberate failure"
git push
```

**Verification:** `grep 'SITEMAP_FLOOR =' probe.mjs` prints `const SITEMAP_FLOOR = 44;`.

⚠ **Do not skip this step.** A monitor observed only passing is indistinguishable from
one that cannot fail, and the mail path is the one part of the chain that no test in
this repository can exercise.

---

## Step 8 — ⚠ Confirm the SCHEDULE is firing, not just the button

**This is the step that is easiest to skip and most likely to be the one that
matters.** Everything up to here was triggered by hand with **Run workflow**. That
proves the code runs. It proves **nothing** about whether the cron ever fires — and a
schedule that never fires is silent in exactly the way this whole repository exists to
prevent.

GitHub will not run a scheduled workflow until it is on the **default branch**, and new
schedules are often delayed on their first firing.

**Wait 20 minutes after the push**, then:

Actions → **Probe · fast** → look at the run list.

**Expected:** at least one run whose trigger reads **`Scheduled`**, not
`workflow_dispatch` / "manually run by".

```sh
gh run list --workflow probe-fast.yml --limit 5
```

**Expected output** — a `schedule` in the event column:

```
completed  success  Probe · fast   main  schedule  ...
```

⚠ **If after 40 minutes there is still no `schedule` run**, the cron is not live. Check
that the workflow file is on `main` and that Actions is enabled under
**Settings → Actions → General**. Do not assume it will start on its own.

**Second verification, and the stronger one:** healthchecks.io should now be receiving a
ping without you touching anything — roughly hourly, not every 15 minutes. That is the only evidence
that the whole chain — schedule → probe → ping — is alive.

---

## Step 9 — Record that it is actually running

Until this point every document in the estate says *built, not pushed*. That wording is
deliberate — **packaging is not shipping**, and a closed "built" item invites the
reading that it is live. Once step 8 passes, that is no longer true and the record
should say so.

Say to any Cowork session in the PROJECTS folder:

> monitors is live — schedule confirmed firing and healthchecks.io is green. Update the record.

It should then, holding `docs:root`:

1. Strike **P1 item 8** in `OPEN_ITEMS.md` ("Finish Tier 0 … John's half").
2. Update the **`## monitors`** section heading in `OPEN_ITEMS.md` from *BUILT … NOT YET
   RUNNING* to live, with the date.
3. Fully close the half-closed **`/api/health` exists and is green, but nothing watches
   it** item under *Current Standpoint Scan* — that item closes when the watcher runs,
   not when it was written.
4. Update the **`## monitors`** entry in `INDEX.md`.

⚠ **Do not let it write "live" from your say-so alone** — the estate has already lost
time to a tracker that was true when written and false within hours. It should confirm
the `schedule` run itself before changing the wording.

---

## Step 10 — After a week: the one thing left deliberately open

Timings are recorded on every run and asserted on by **nothing**. Once a week of warm
samples exists in the Actions logs, set a latency threshold from the data.

To collect them:

```sh
cd ~/Developer/standpoint-monitors
gh run list --workflow probe-fast.yml --limit 100 --json databaseId --jq '.[].databaseId' | while read -r id; do gh run view "$id" --log 2>/dev/null | grep -E 'scanHealth: HTTP'; done
```

**Expected output:** a hundred-odd lines of `scanHealth: HTTP 200 in NNN ms, 1 attempt(s)`.

Set the threshold well above the **95th percentile of the warm samples**, never near the
median, and never from a cold start. Until then the only latency rule is a 20-second
fetch timeout, which means *unreachable*, not *slow*.

⚠ **The attempt counts in those lines are worth reading too.** A target that quietly
needs two or three attempts every time is a degrading system, and the retry logic is
currently averaging that away into a green tick.

---

## What this does not cover

Tier 0 watches **whether the public product is up and whether its controls are on**. It
does not watch:

- **engine keys and balances** — a spent Bright Data balance stops the Scan and the
  Audit as dead as a bad key, and presents as engine failure rather than a billing
  message *(Tier 1)*;
- **count checks** — "audits registered this week ≠ audits delivered this week" is the
  only shape that catches a quietly-failing non-blocking ping, and no error monitor will
  ever see it *(Tier 1)*;
- **whether the gates themselves are blind** — the recurring failure in this estate is a
  check that reads green because it is looking at nothing *(Tier 2)*.

Full plan: `_sessions/inbox/2026-08-16-1304-root-7c3e.md`.

/*
 * probe.mjs — fetch the endpoints, run the assertions, report, and prove the
 * probe itself is still alive.
 *
 *   node probe.mjs --suite fast
 *   node probe.mjs --suite daily
 *   node probe.mjs --suite weekly
 *   node probe.mjs --suite fast --deadman     (also pings the dead-man's switch)
 *
 * WHAT THIS IS FOR, IN ONE LINE: every documented outage in this estate was
 * invisible rather than hard to detect, because the signal existed and nobody
 * was on the other end of it. This is the other end.
 *
 *   Calendly token dead on Infomaniak   24 hours   witnessed by one console.warn
 *   Audit registry rejecting everything 19 days    witnessed by a non-blocking 401
 *   Bright Data key emptied to 0 bytes   9 days    witnessed by an empty file
 *
 * THREE PARTS, AND THEY ARE NOT REDUNDANT. This script covers assertions on
 * response BODIES, which is what a status-code monitor cannot do. An external
 * uptime monitor covers what this cannot: GitHub being down, this workflow
 * being disabled, this repository being broken. The dead-man's switch covers
 * what neither can: THIS SCRIPT SILENTLY CEASING TO RUN. Drop any one and a
 * documented outage class becomes invisible again.
 *
 * ⚠ GitHub disables scheduled workflows in a repository with no activity for
 * 60 days. That is a silent death, and it is precisely why the dead-man's
 * switch is not optional garnish.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PAGE,
  WARN,
  checkAvailability,
  checkHiddenPage,
  checkHomepage,
  checkRobots,
  checkScanHealth,
  checkSitemap,
} from "./checks.mjs";

/* ------------------------------------------------------------------------ *
 * Configuration — everything that could reasonably change, in one place.
 * ------------------------------------------------------------------------ */

const TARGETS = {
  home: "https://standpoint.ch/",
  robots: "https://standpoint.ch/robots.txt",
  availability: "https://standpoint.ch/api/availability.php",
  scanHealth: "https://scan.standpoint.ch/api/health",
  sitemap: "https://standpoint.ch/sitemap.xml",
  hidden: "https://standpoint.ch/setup-a-session/",
};

/*
 * ⚠ A RATCHET, NOT A CONSTANT — see checkSitemap. 44 URLs were served on
 * 2026-08-16. RAISE THIS when pages are added; it exists to catch pages
 * disappearing, which has never once been intentional.
 */
const SITEMAP_FLOOR = 9999;

/*
 * ⚠⚠ NO LATENCY THRESHOLD IS SET, AND THAT IS A DECISION, NOT AN OVERSIGHT.
 *
 * The samples available when this was written were cold starts — 466 ms from
 * /api/health on 2026-08-16, 602 ms recorded on 2026-08-04. Setting a timeout
 * from a cold start is how a new monitor pages on a perfectly healthy system
 * during its first idle period, after which it is muted and worse than
 * nothing.
 *
 * So: timings are RECORDED on every run and asserted on by nothing. After a
 * week of warm samples, come back and set one from the data. Until then the
 * only latency rule is the hard fetch timeout below, which is set high enough
 * to mean "unreachable", not "slow".
 */
const FETCH_TIMEOUT_MS = 20_000;

/*
 * Retries exist so a single dropped packet does not page. They are bounded and
 * COUNTED — attempts are printed on every run, because a target that quietly
 * needs three attempts every time is a degrading system, and averaging that
 * away into a green tick is how it stays unnoticed until it fails outright.
 */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 4_000;

/* ------------------------------------------------------------------------ *
 * Suites
 * ------------------------------------------------------------------------ */

/*
 * ⚠ WHY WARNINGS ARE A CADENCE DECISION AND NOT A LOG LINE.
 *
 * The obvious design is one suite that prints warnings and exits 0. It is
 * wrong, and it is wrong in this estate's own signature way: a warning that
 * only reaches a log reaches nobody. The audit registry failed into exactly
 * that shape for nineteen days — non-blocking by design, correct by design,
 * reported to one line of chat and then nowhere.
 *
 * So a warning turns a run RED. It just does not turn ninety-six runs a day
 * red: `fast` filters warnings out, `daily` does not. One red daily run per
 * day until it is fixed is loud enough to act on and quiet enough not to mute.
 */
const SUITES = {
  fast: { severities: [PAGE], checks: ["home", "availability", "scanHealth"] },
  daily: { severities: [PAGE, WARN], checks: ["home", "robots", "availability", "scanHealth"] },
  weekly: {
    severities: [PAGE, WARN],
    checks: ["home", "robots", "availability", "scanHealth", "sitemap", "hidden"],
  },
};

/* ------------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------------ */

async function fetchOnce(url) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      /*
       * Named so that a spike in the server logs is attributable, and so that
       * probe traffic can be excluded from analytics if it ever needs to be.
       */
      "User-Agent": "standpoint-monitors/1.0 (+https://github.com/standpoint/standpoint-monitors)",
      /* Never let a CDN or an intermediary answer on the origin's behalf. */
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  const body = await response.text();
  return { status: response.status, body, ms: Date.now() - started };
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchOnce(url);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  /*
   * ⚠ A TRANSPORT FAILURE IS REPORTED AS status 0 WITH THE REASON ATTACHED,
   * never swallowed into a generic failure. DNS failure, TLS failure, timeout
   * and connection-refused are four different problems with four different
   * fixes, and collapsing them costs a diagnosis every time.
   */
  return {
    status: 0,
    body: "",
    ms: 0,
    attempts: ATTEMPTS,
    transportError: String(lastError?.message || lastError),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------------ */

async function run(suiteName) {
  const suite = SUITES[suiteName];
  if (!suite) throw new Error(`Unknown suite '${suiteName}'. Expected one of: ${Object.keys(SUITES).join(", ")}`);

  const allowed = new Set(suite.severities);
  const wanted = new Set(suite.checks);
  const results = [];
  const timings = [];

  const get = async (key) => {
    const response = await fetchWithRetry(TARGETS[key]);
    timings.push({ key, ms: response.ms, attempts: response.attempts, status: response.status });
    if (response.transportError) {
      console.log(`  ✗ ${key}: transport failure after ${response.attempts} attempts — ${response.transportError}`);
    }
    return response;
  };

  if (wanted.has("home")) results.push(...checkHomepage(await get("home")));
  if (wanted.has("robots")) results.push(...checkRobots(await get("robots")));
  if (wanted.has("availability")) results.push(...checkAvailability(await get("availability")));
  if (wanted.has("scanHealth")) results.push(...checkScanHealth(await get("scanHealth")));

  /*
   * The sitemap is fetched once and its URL list is handed to the hidden-page
   * check, so the two can never disagree about what the sitemap contained —
   * two fetches a second apart could.
   */
  let sitemapUrls = [];
  if (wanted.has("sitemap") || wanted.has("hidden")) {
    const sitemap = await get("sitemap");
    sitemapUrls = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    if (wanted.has("sitemap")) results.push(...checkSitemap(sitemap, { floor: SITEMAP_FLOOR }));
  }
  if (wanted.has("hidden")) {
    results.push(...checkHiddenPage(await get("hidden"), { sitemapUrls, url: TARGETS.hidden }));
  }

  return { results, timings, allowed };
}

/* ------------------------------------------------------------------------ *
 * Annotations — getting the diagnosis into the alert itself
 * ------------------------------------------------------------------------ */

/*
 * ⚠⚠ THE FAILURE MAIL DOES NOT CARRY THE DIAGNOSIS, AND THAT WAS FOUND BY
 * RUNNING A DELIBERATE FAILURE RATHER THAN BY READING THE CODE.
 *
 * On 2026-08-16 the sitemap floor was set to 9999 on purpose to prove the
 * alert path worked. It did: the mail arrived. But all it said was "All jobs
 * have failed" and "Failed in 7 seconds". The actual answer —
 *
 *     Sitemap has LOST pages — 44 URLs, floor is 9999
 *
 * — was one click away, in the run log, behind a login, on a phone, at night.
 * Every failure line in checks.mjs was written to name expected-vs-observed
 * precisely so an alert would not cost a debugging session to interpret, and
 * the notification dropped exactly that part.
 *
 * GitHub *does* surface workflow annotations in the failure notification. So
 * the same three facts are emitted a second time as `::error::` / `::warning::`
 * workflow commands. The console lines above are for a human reading the log;
 * these are for the mail.
 *
 * ⚠ EMITTED UNCONDITIONALLY, NOT GATED ON `GITHUB_ACTIONS`. The tidier version
 * checks the environment and stays quiet locally. That version has a state in
 * which the annotations are silently off — a mistyped env name, a `act` run, a
 * future workflow that clears the environment — and it reports exactly like the
 * working one, which is this repository's signature bug. Outside Actions these
 * lines are merely two extra lines of text; inside it there is no branch that
 * can be wrong. Local noise is a cheaper price than a silent fallback.
 */

/*
 * Escaping is not decoration: an unescaped newline TRUNCATES the annotation at
 * that point, so the observed value — the whole reason for this — is the part
 * that would go missing. Data and properties escape differently; `:` and `,`
 * matter only inside the property list, where they are the delimiters.
 */
const escapeData = (value) =>
  String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const escapeProperty = (value) =>
  escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function annotation(failure, suiteName) {
  const isPage = failure.severity === PAGE;
  /*
   * ⚠ A MISSING `observed` IS NAMED, NEVER RENDERED AS "undefined". This line
   * exists to carry the observed value; a check that forgot to record one is a
   * defect in that check, and the annotation should say so rather than print a
   * word that reads like a value.
   */
  const observed =
    failure.observed === undefined || failure.observed === null || failure.observed === ""
      ? "(NOT RECORDED — this check failed without an observed value, which is a defect in the check)"
      : failure.observed;

  const title = escapeProperty(`${isPage ? "PAGE" : "WARN"} ${failure.id} · suite ${suiteName}`);
  const message = escapeData(`${failure.note}\nobserved: ${observed}`);
  return `::${isPage ? "error" : "warning"} title=${title}::${message}`;
}

/* ------------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------------ */

/*
 * ⚠ EVERY FAILURE LINE NAMES THREE THINGS: what was checked, what was
 * expected, and WHAT WAS ACTUALLY OBSERVED. An alert that says "check failed"
 * costs a debugging session per fire, and the observed value is usually the
 * whole diagnosis — `ticket=off` is not a symptom to investigate, it is the
 * answer.
 */
export function report({ results, timings, allowed }, suiteName) {
  const failures = results.filter((r) => !r.ok && allowed.has(r.severity));
  const pages = failures.filter((r) => r.severity === PAGE);
  const warns = failures.filter((r) => r.severity === WARN);
  const passes = results.filter((r) => r.ok);

  console.log(`\nstandpoint-monitors · suite=${suiteName} · ${new Date().toISOString()}\n`);

  /*
   * ⚠ "EVERYTHING IS DOWN" ALMOST ALWAYS MEANS THE PROBE IS DOWN.
   *
   * Found while verifying this script rather than reasoned about in advance:
   * the first live run reported six simultaneous PAGE failures, and the estate
   * was entirely healthy — the runner simply had no direct egress. Six red
   * lines is a convincing picture of a catastrophe, and it was wrong.
   *
   * The tell is that standpoint.ch is on Infomaniak and scan.standpoint.ch is
   * on Vercel. Two unrelated providers failing in the same second is far less
   * likely than one runner losing its network. So when EVERY target fails at
   * the transport layer, the alert says so instead of letting the reader spend
   * the first ten minutes of an incident on the wrong system.
   *
   * ⚠ It still exits non-zero. "Probably our end" is not "ignore it" — a probe
   * that cannot reach anything is a probe that is not monitoring anything, and
   * that is exactly the silent state this repository exists to prevent.
   */
  const fetched = timings.length;
  const transportFailures = timings.filter((t) => t.status === 0).length;
  if (fetched > 1 && transportFailures === fetched) {
    console.log(
      `  ⚠ ALL ${fetched} TARGETS FAILED AT THE TRANSPORT LAYER — read this as the probe's own\n` +
        `    network before reading it as an outage. standpoint.ch (Infomaniak) and\n` +
        `    scan.standpoint.ch (Vercel) are different providers; simultaneous failure is\n` +
        `    implausible. Check the runner's egress, then confirm by hand:\n` +
        `      curl -sS -o /dev/null -w '%{http_code}\\n' https://standpoint.ch/\n`,
    );
    /*
     * ⚠ ANNOTATED FIRST, DELIBERATELY, BECAUSE IT CHANGES WHAT THE OTHER SIX
     * ANNOTATIONS MEAN. Without it the mail shows six red lines against six
     * different hosts — a convincing picture of a catastrophe, and wrong the one
     * time it actually happened. The reader spends the first ten minutes on the
     * wrong system, which is the exact cost these annotations exist to remove.
     *
     * ⚠ It is also the only annotation that does not correspond to a check, so
     * it is the first thing to delete if this ever needs trimming. Named here so
     * that deleting it is a decision rather than a discovery.
     */
    console.log(
      annotation(
        {
          id: "probe-egress",
          severity: PAGE,
          note: "ALL targets failed at the transport layer — read this as the probe's own network before reading it as an outage",
          observed:
            `${transportFailures} of ${fetched} targets unreachable. standpoint.ch (Infomaniak) and ` +
            `scan.standpoint.ch (Vercel) are different providers, so simultaneous failure is implausible. ` +
            `Check the runner's egress first.`,
        },
        suiteName,
      ),
    );
  }

  for (const pass of passes) console.log(`  ✓ ${pass.id}: ${pass.note}`);
  for (const failure of warns) {
    console.log(`  ⚠ WARN  ${failure.id}: ${failure.note}`);
    console.log(`          observed: ${failure.observed}`);
  }
  for (const failure of pages) {
    console.log(`  ✗ PAGE  ${failure.id}: ${failure.note}`);
    console.log(`          observed: ${failure.observed}`);
  }

  /*
   * ⚠ EMITTED AFTER the human-readable block and never instead of it. The two
   * audiences are different — the log is read by someone already looking, the
   * annotation reaches someone who is not — and collapsing them would mean
   * losing one to tidy up the other.
   *
   * ⚠ Only failures the suite actually ALLOWS are annotated, so `fast` cannot
   * annotate a warning it deliberately ignores. An annotation on a green run
   * would be a red mark on a passing job: the cadence rule that keeps `ticket:
   * off` from paging ninety-six times a day has to hold here too, or it is
   * defeated through the mail instead of through the exit code.
   */
  for (const failure of [...pages, ...warns]) console.log(annotation(failure, suiteName));

  console.log(
    `\n  timings (recorded, NOT asserted on — no threshold until a week of warm samples exists):`,
  );
  for (const t of timings) {
    console.log(`    ${t.key}: HTTP ${t.status} in ${t.ms} ms, ${t.attempts} attempt(s)`);
  }

  if (pages.length) {
    console.log(`\n✗ ${pages.length} PAGE failure(s), ${warns.length} warning(s).\n`);
    return 1;
  }
  if (warns.length) {
    console.log(`\n⚠ ${warns.length} warning(s), nothing broken for a visitor.\n`);
    return 2;
  }
  console.log(`\n✓ All ${passes.length} checks passed.\n`);
  return 0;
}

/* ------------------------------------------------------------------------ *
 * The dead-man's switch
 * ------------------------------------------------------------------------ */

/*
 * ⚠⚠ THE MISSING-SECRET CASE MUST BE LOUD, AND HERE IS WHY THAT IS THE WHOLE
 * POINT OF THE FEATURE.
 *
 * The natural way to write this is `if (!url) return;` — ping when configured,
 * skip quietly when not. That would reproduce, inside the very tool built to
 * prevent it, the exact bug that cost this estate nine days of a dead Bright
 * Data leg and nineteen days of a dead audit registry: A SILENT FALLBACK READS
 * EXACTLY LIKE A PASSING CHECK.
 *
 * Worse here than anywhere else, because the dead-man's switch is the thing
 * that notices when everything else stops. If the secret were absent, no ping
 * would ever be sent, healthchecks.io would alert once, and after that a
 * disabled or deleted workflow would be invisible forever while every run that
 * did happen looked green.
 *
 * So: asked for and missing is a hard failure with its own exit code.
 */
async function pingDeadman() {
  const url = process.env.DEADMAN_URL;
  if (!url) {
    console.error(
      "\n✗ --deadman was requested but DEADMAN_URL is not set.\n" +
        "  Refusing to exit 0 on a probe whose liveness signal goes nowhere.\n" +
        "  Set the DEADMAN_URL repository secret, or drop the --deadman flag deliberately.\n",
    );
    return false;
  }
  try {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
    console.log(`  dead-man's switch pinged: HTTP ${response.status}`);
    return response.ok;
  } catch (error) {
    console.error(`  ✗ dead-man's switch ping failed: ${error.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------------ */

/*
 * ⚠ THE CLI IS GUARDED SO THAT IMPORTING THIS FILE DOES NOT FIRE A PROBE.
 *
 * Without the guard, `report` could not be unit-tested — importing the module
 * to reach it would run a live probe as a side effect — and an untestable
 * severity-to-exit-code mapping is exactly the kind of thing that silently
 * inverts. The same pattern, for the same reason, is used by
 * standpoint-website's scripts/assert-live-build.mjs.
 *
 * ⚠ This is NOT an escape hatch. There is no flag that makes a failing probe
 * exit 0, and none should ever be added: the publish gate next door records
 * why ("NO ESCAPE HATCH, DELIBERATELY"), and a monitor with an off switch is
 * a monitor that will be found switched off.
 */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const args = process.argv.slice(2);
  const suiteName = args.includes("--suite") ? args[args.indexOf("--suite") + 1] : "fast";
  const wantsDeadman = args.includes("--deadman");

  const outcome = await run(suiteName);
  const code = report(outcome, suiteName);

  /*
   * ⚠ PING ONLY ON A CLEAN RUN. A probe that pings while failing tells the
   * dead-man's switch it is healthy, which is the one lie that would make the
   * switch worse than absent.
   *
   * The consequence is deliberate and worth stating: a sustained failure will
   * ALSO trip the dead-man's switch once its grace period expires, on top of
   * the GitHub failure mail. That duplicate is accepted on purpose — it is the
   * only path that still alerts if GitHub's own notification mail is what is
   * broken.
   */
  if (wantsDeadman) {
    if (code === 0) {
      const pinged = await pingDeadman();
      if (!pinged) process.exit(3);
    } else {
      console.log("  dead-man's switch NOT pinged — the run was not clean, and saying otherwise would be a lie.");
      /* Still surface a missing secret, so a misconfiguration cannot hide behind an unrelated failure. */
      if (!process.env.DEADMAN_URL) {
        console.error("  ✗ …and DEADMAN_URL is not set either. Fix that separately; it is not caused by the failure above.");
      }
    }
  }

  process.exit(code);
}

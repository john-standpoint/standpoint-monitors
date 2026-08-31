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
  checkCyrjHome,
  checkCyrjWorksheet,
  checkNotFoundEn,
  checkNotFoundFr,
  checkRedirects,
  checkHiddenPage,
  checkHomepage,
  checkRobots,
  checkScanHealth,
  checkSitemap,
} from "./checks.mjs";

/* ------------------------------------------------------------------------ *
 * Configuration — everything that could reasonably change, in one place.
 * ------------------------------------------------------------------------ */

/*
 * ⚠ DERIVED FROM TARGETS.home, NOT RETYPED. checks.mjs holds its own origin
 * constant and does not export it; a second literal here would be a third copy
 * and the one nobody updates. It is also what caught this: the redirect loop
 * was first written against a bare origin identifier that does not exist in
 * this module, and `node --check` passed it, because a ReferenceError is a
 * runtime event. Only running the probe found it.
 */
const liveOrigin = () => new URL(TARGETS.home).origin;

const TARGETS = {
  home: "https://standpoint.ch/",
  robots: "https://standpoint.ch/robots.txt",
  availability: "https://standpoint.ch/api/availability.php",
  scanHealth: "https://scan.standpoint.ch/api/health",
  sitemap: "https://standpoint.ch/sitemap.xml",
  hidden: "https://standpoint.ch/setup-a-session/",

  /*
   * chartingyourretirementjourney.com — added 2026-08-24 [claim-3c4e], three
   * days after it went live on Astro.
   *
   * ⚠ THE WORKSHEET URL IS LOAD-BEARING AND MUST NOT BE "TIDIED" TO A NICER
   * PATH. The seventeen worksheet PDFs are where the printed book's QR codes
   * send readers, and those codes cannot be reissued. This is one of them.
   */
  cyrjHome: "https://chartingyourretirementjourney.com/",
  cyrjWorksheet: "https://chartingyourretirementjourney.com/downloads/4.2-Base-Camp-Check-In.pdf",

  /*
   * ⚠ THESE TWO PATHS MUST NEVER EXIST, AND THE NAME SAYS SO ON PURPOSE.
   * They probe the 404 HANDLERS, so the check is meaningless the moment a real
   * page answers. If anyone ever adds a page here the checks go red on the
   * status assertion rather than passing quietly, which is the wanted failure.
   */
  notFoundEn: "https://standpoint.ch/_monitor-404-probe/",
  notFoundFr: "https://standpoint.ch/fr/_monitor-404-probe/",
};

/*
 * The hand-pasted redirect rules. Added 2026-08-24 [claim-3b8e].
 *
 * ⚠⚠ THIS LIST IS DUPLICATED FROM standpoint-website/scripts/check-redirects.sh
 * AND NOTHING CAN KEEP THEM IN STEP. They are in different repositories, so no
 * import is possible, and the authoritative copy is neither of them — it is the
 * live .htaccess, pasted by hand through the Infomaniak manager, with
 * docs/launch/htaccess-redirects.txt as the script for rebuilding it.
 * That makes FOUR places. ⚠ When a rule is added there, add it here; the count
 * in this check's ok line is what will show the drift, and only to somebody
 * reading it.
 *
 * ⚠ /independant-consultants/ IS NOT A TYPO — it is the misspelling the answer
 * engines actually cite. The correctly-spelled rule above it reported ok since
 * launch while catching nothing, because it was written from what the slug
 * should have been rather than from what was published. Both stay.
 *
 * ⚠ /storybuilding-book carries NO trailing slash because that is the form
 * printed on the book's copyright page, and a checker should test the string a
 * reader will type. The .htaccess rule is anchored `/?$` so both forms work.
 */
const REDIRECT_RULES = [
  { from: "/companies/", want: "/charter/" },
  { from: "/independent-consultants/", want: "/charter/" },
  { from: "/a-little-about-me/", want: "/about-me/" },
  { from: "/how-we-can-work-together/", want: "/working-together/" },
  { from: "/tagline-builder/", want: "/scan/" },
  { from: "/sprint/", want: "/charter/" },
  { from: "/story-governance/", want: "/governance/" },

  /* Citation recovery, 2026-08-16 [claim-b3f8] — every one a URL an engine cites. */
  { from: "/my-persona/", want: "/about-me/" },
  { from: "/un-peu-sur-moi/", want: "/about-me/" },
  { from: "/podcast-interviews/", want: "/interviews/" },
  { from: "/standpoint-storytelling/", want: "/storybuilding/" },
  { from: "/independant-consultants/", want: "/charter/" },
  { from: "/cases-studies/", want: "/case-studies/" },

  /* The address printed in the book, 2026-08-19 [claim-7e21]. Not fixable at source. */
  { from: "/storybuilding-book", want: "/the-book/" },

  /*
   * ⚠ Block 3b — the case-study PDFs. CHECKING THEM IS NOT ENDORSING THEM.
   * John ruled on 13 August that no redirects would be written for these; they
   * were found live on the server on 19 August anyway. His instruction: do not
   * add new ones, but assert the ones that are there, because a live rule
   * nothing asserts can break silently and nobody learns. If he later decides
   * they should go, delete the rules AND these four lines together.
   */
  { from: "/wp-content/uploads/2025/09/Storybuilding-Case-Study-CertCare.pdf", want: "/case-studies/certcare/" },
  { from: "/wp-content/uploads/2025/09/Storybuilding-Case-Study-GoEko.pdf", want: "/case-studies/goeko/" },
  { from: "/wp-content/uploads/2025/09/Storybuilding-Case-Study-fAIcon.pdf", want: "/case-studies/faicon/" },
  { from: "/wp-content/uploads/2025/09/Storybuilding-Case-Study-Finbed.pdf", want: "/case-studies/finbed/" },
];

/*
 * ⚠ A RATCHET, NOT A CONSTANT — see checkSitemap. RAISE THIS when pages are
 * added; it exists to catch pages disappearing, which has never once been
 * intentional.
 *
 * 44 URLs were served on 2026-08-16. **69 at 16:16 on 2026-08-20. 94 at 17:16
 * THE SAME DAY** — twenty-five more inside one hour, from a different session
 * publishing the French interview pages.
 *
 * ⚠ THAT IS THE COST OF A RATCHET NOBODY RATCHETS, AND BOTH NUMBERS WERE FOUND
 * BY ACCIDENT: each surfaced only because the floor was temporarily set to 9999
 * to test an alert. The floor sat at 44 for four days while the real count was
 * 69, then the corrected 69 was stale within the hour. Nothing here notices a
 * floor drifting below the real count — the check is asymmetric by design, and
 * its blind side widens every time a page is published.
 *
 * ⚠⚠ SO THIS IS NOT A NUMBER TO SET ONCE. **Raising it is part of publishing
 * pages.** A red weekly run after a deliberate content change means raise the
 * floor; a red one after no change means find the missing pages.
 */
const SITEMAP_FLOOR = 94;

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
  /*
   * ⚠ cyrjHome is in FAST; cyrjWorksheet is not. The homepage catches the
   * outage class this site has actually had — a staging build or the WordPress
   * rollback served over production, both of which render perfectly — and that
   * wants hourly eyes. The worksheet fetch pulls ~99 KB and its failure mode is
   * slow-moving, so daily is enough; putting it in fast would multiply the
   * bandwidth by twenty-four to shorten a detection window that nothing else
   * depends on.
   */
  /*
   * ⚠ notFoundEn is PAGE severity but is NOT in `fast`, and that is a cadence
   * decision rather than a severity one. Its failure mode is a hand edit to a
   * server file — an event with a person attached, not a drift that happens at
   * 3am — so a detection window of a day is the right size, and putting it in
   * fast would add 24 requests a day to shorten a window nothing depends on.
   */
  fast: { severities: [PAGE], checks: ["home", "availability", "scanHealth", "cyrjHome"] },
  daily: {
    severities: [PAGE, WARN],
    checks: ["home", "robots", "availability", "scanHealth", "cyrjHome", "cyrjWorksheet", "notFoundEn", "notFoundFr", "redirects"],
  },
  weekly: {
    severities: [PAGE, WARN],
    checks: [
      "home", "robots", "availability", "scanHealth", "sitemap", "hidden",
      "cyrjHome", "cyrjWorksheet", "notFoundEn", "notFoundFr", "redirects",
    ],
  },
};

/* ------------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------------ */

/*
 * ⚠ `follow` IS AN ARGUMENT BECAUSE A REDIRECT CHECK CANNOT USE THE DEFAULT.
 * With redirect:"follow" the 301 is invisible — fetch reports the FINAL 200 and
 * the intermediate hop is gone, so "301 to the right place" and "meta-refresh
 * HTML that happens to end up there" are the same observation. astro.config.mjs
 * emits exactly those meta-refresh pages for these same slugs, and they pass no
 * signal to a search engine, so telling them apart is the entire job.
 */
async function fetchOnce(url, { follow = true } = {}) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: follow ? "follow" : "manual",
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
  return {
    status: response.status,
    body,
    location: response.headers.get("location"),
    ms: Date.now() - started,
  };
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchOnce(url, options);
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
  if (wanted.has("cyrjHome")) results.push(...checkCyrjHome(await get("cyrjHome")));
  if (wanted.has("cyrjWorksheet")) results.push(...checkCyrjWorksheet(await get("cyrjWorksheet")));

  if (wanted.has("notFoundEn")) {
    results.push(...checkNotFoundEn(await get("notFoundEn"), { url: TARGETS.notFoundEn }));
  }
  if (wanted.has("notFoundFr")) {
    results.push(...checkNotFoundFr(await get("notFoundFr"), { url: TARGETS.notFoundFr }));
  }

  /*
   * ⚠ TWO REQUESTS PER RULE, AND BOTH ARE LOAD-BEARING. The unfollowed one
   * proves it is a real 301 to the right target; the followed one proves that
   * target is not itself dead. A 301 to a 404 is worse than no redirect at all
   * — it tells four answer engines that a specific page is the successor to the
   * old one — and it is invisible to either half alone.
   */
  if (wanted.has("redirects")) {
    const observations = [];
    for (const rule of REDIRECT_RULES) {
      const url = `${liveOrigin()}${rule.from}`;
      const first = await fetchWithRetry(url, { follow: false });
      timings.push({ key: `redirect ${rule.from}`, ms: first.ms, attempts: first.attempts, status: first.status });
      if (first.transportError) {
        observations.push({ ...rule, transportError: first.transportError });
        continue;
      }
      /*
       * Only follow when the first hop already looks right. Following a 404
       * costs a request and tells us nothing we do not already know.
       */
      let finalStatus = null;
      if (first.status === 301) {
        const followed = await fetchWithRetry(url);
        finalStatus = followed.transportError ? 0 : followed.status;
      }
      observations.push({ ...rule, status: first.status, location: first.location, finalStatus });
    }
    results.push(...checkRedirects(observations));
  }

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

/*
 * ⚠ A MISSING `observed` IS NAMED, NEVER RENDERED AS "undefined". Both the
 * annotation and the healthchecks body exist to carry the observed value; a
 * check that forgot to record one is a defect in that check, and the alert
 * should say so rather than print a word that reads like a value.
 *
 * Shared by both paths deliberately — two copies of this rule would drift, and
 * the one that drifted would be the one nobody was reading at the time.
 */
export const observedOf = (failure) =>
  failure.observed === undefined || failure.observed === null || failure.observed === ""
    ? "(NOT RECORDED — this check failed without an observed value, which is a defect in the check)"
    : failure.observed;

export function annotation(failure, suiteName) {
  const isPage = failure.severity === PAGE;
  const observed = observedOf(failure);

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
 * The alert channel — the only path proven to put the diagnosis in an inbox
 * ------------------------------------------------------------------------ */

/*
 * ⚠⚠ THIS EXISTS BECAUSE GITHUB'S MAIL CARRIES A COUNT, NOT THE TEXT.
 *
 * Measured 2026-08-20, twice, and the two results are the whole design:
 *
 *   GitHub failure mail    "All jobs have failed" · "Annotations 💬 3"
 *                          — the number of annotations. Not one word of them.
 *   healthchecks.io mail   a "Last Ping Body" heading with the POST body
 *                          printed verbatim underneath.
 *
 * ⚠ The healthchecks DOCS do not promise the second one. "Attaching Logs" says
 * the body is stored and points at the web UI's Events section; nothing in it
 * mentions notifications. It was tested against a throwaway check before any of
 * this was written, because the previous remedy in this file was believed on the
 * strength of a plausible sentence and turned out to be false. THE TEST IS THE
 * REASON THIS IS HERE, not the documentation.
 *
 * ⚠ PER-SUITE CHECKS, VIA SLUG URLS, AND THAT IS NOT AN AESTHETIC CHOICE.
 * With a single shared check, a weekly sitemap failure would alert — and then
 * the next fast run, up to an hour later, would post success and healthchecks
 * would mail "UP" while the sitemap was still short 25 pages. A recovery notice
 * for something that has not recovered is worse than no notice: it is the
 * green-while-blind shape, delivered by mail. Per-suite, a weekly failure stays
 * down until a WEEKLY run passes.
 *
 * Slug URLs mean one secret instead of three, and `create=1` means the checks
 * provision themselves on first ping. ⚠ Their PERIOD must then be set long by
 * hand — an auto-provisioned check defaults to one day, so the weekly one would
 * go down every day for the crime of being weekly. SETUP.md step 9 covers it.
 */
const ALERT_SLUG = (suiteName) => `standpoint-probe-${suiteName}`;

/*
 * The body is plain text on purpose. It is read in a mail client, on a phone,
 * by someone who was doing something else — not parsed.
 */
export function alertBody({ results, allowed }, suiteName, env = process.env) {
  const failures = results.filter((r) => !r.ok && allowed.has(r.severity));
  const lines = [];

  lines.push(`standpoint-monitors · suite ${suiteName} · ${failures.length} failure(s)`);
  lines.push("");

  for (const failure of failures) {
    lines.push(`${failure.severity === PAGE ? "PAGE" : "WARN"}  ${failure.id}: ${failure.note}`);
    lines.push(`      observed: ${observedOf(failure)}`);
  }

  /*
   * The run URL earns its place: it turns "something is wrong" into one tap.
   * Built from the environment rather than hard-coded, and simply omitted when
   * absent — a local run has no run to link to, and inventing one would be worse
   * than saying nothing.
   */
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    lines.push("");
    lines.push(`${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`);
  }

  return lines.join("\n");
}

/*
 * ⚠⚠ WHETHER A PING WAS ACCEPTED IS ITS OWN FUNCTION, AND THIS IS WHY.
 *
 * The first version of this rule read: "the body must start with OK". It was
 * written by applying this repository's founding principle — READ THE BODY, NOT
 * THE STATUS — and it was wrong, and it took all three suites down on their
 * first live run. The auto-provisioning ping that CREATES each check answers
 * `HTTP 201` with the body `Created`, so the guard rejected the one response
 * that meant everything had worked.
 *
 * ⚠ THE PRINCIPLE IS A STATEMENT ABOUT A PARTICULAR SERVICE, NOT A LAW OF HTTP.
 * It holds for `scan.standpoint.ch/api/health`, which answers 200 while broken.
 * It holds for healthchecks' UUID endpoints, which answer `200 OK (not found)`
 * for a check that does not exist. It does NOT hold for healthchecks' SLUG
 * endpoints, which return real status codes — 200, 201, 404, 409, 429 — where
 * the body adds nothing the status has not already said. Applying it as a law
 * produced a check that failed a correct response, which is the failure mode
 * that teaches people to work around checks.
 *
 * So: status decides, and the known lying bodies are rejected explicitly. Pure,
 * exported, and tested — the previous version could not be tested at all,
 * because it was buried inside a function that makes a network call.
 */
export function alertPingAccepted(status, body) {
  const text = String(body ?? "").trim();

  /*
   * The three phrases healthchecks returns behind a 200 when it has in fact
   * ignored the ping. Rejected by name rather than by pattern-guessing.
   */
  if (/not found/i.test(text)) return false;
  if (/rate limit/i.test(text)) return false;
  if (/ambiguous/i.test(text)) return false;

  /* 200 OK on an existing check, 201 Created on first contact. Both are real. */
  return status >= 200 && status < 300;
}

/*
 * ⚠ ASKED FOR AND MISSING IS A HARD FAILURE, exactly as with DEADMAN_URL and
 * for the same reason: a silent skip here means the diagnosis goes nowhere while
 * every run looks identical to one where it arrived.
 */
async function pingAlert(outcome, suiteName, code) {
  const key = process.env.HC_PING_KEY;
  if (!key) {
    console.error(
      "\n✗ --alert was requested but HC_PING_KEY is not set.\n" +
        "  Refusing to exit 0 on a probe whose diagnosis goes nowhere.\n" +
        "  Set the HC_PING_KEY repository secret, or drop the --alert flag deliberately.\n",
    );
    return false;
  }

  const base = `https://hc-ping.com/${key}/${ALERT_SLUG(suiteName)}`;
  const url = code === 0 ? `${base}?create=1` : `${base}/fail?create=1`;

  try {
    const response = await fetch(url, {
      method: "POST",
      /* Only a failing run has anything to say. A clean one just clears the state. */
      body: code === 0 ? "" : alertBody(outcome, suiteName),
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await response.text()).trim();
    console.log(`  alert channel (${code === 0 ? "clear" : "FAIL"}): HTTP ${response.status} ${text}`);
    if (!alertPingAccepted(response.status, text)) {
      console.error(
        `  ✗ alert channel did not accept the ping — HTTP ${response.status}, body: ${text.slice(0, 120)}\n` +
          `    404 means the ping key is wrong. 400 means the slug is malformed.\n` +
          `    A 200 saying "not found" means the key is valid but the check is not.`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(`  ✗ alert channel ping failed: ${error.message}`);
    return false;
  }
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
/*
 * ⚠⚠ ONE SWITCH PER SUITE, AND THE FALLBACK IS DELIBERATELY NOT GENERIC.
 *
 * Until 2026-08-31 this read a single hardcoded `DEADMAN_URL`, because only the
 * fast suite pinged. That stopped being adequate when GitHub's scheduler broke:
 * `probe-daily` ran 5–12 HOURS LATE on five consecutive days and NOTHING COULD
 * HAVE REPORTED IT. A suite that does not run emits no red run, no mail and no
 * missing ping — from outside, LATE and HEALTHY and DEAD are one observation.
 *
 * ⚠ The obvious implementation is a per-suite variable falling back to the old
 * `DEADMAN_URL` for any suite. THAT WOULD BE THE MASKING BUG, REINTRODUCED BY
 * THE FIX: a daily run with only `DEADMAN_URL` set would ping the FAST suite's
 * switch, keeping it green while the fast probe was dead — the precise failure
 * `probe-fast.yml`'s header forbids two suites from causing.
 *
 * So the fallback is scoped to `fast` ALONE, purely so the existing repository
 * secret keeps working. Every other suite must name its own variable or fail
 * hard, exactly as a missing secret has always failed here.
 */
export const deadmanEnvName = (suiteName) => `DEADMAN_URL_${suiteName.toUpperCase()}`;

export function resolveDeadmanUrl(suiteName, env = process.env) {
  const name = deadmanEnvName(suiteName);
  if (env[name]) return { url: env[name], name };
  /* Legacy compatibility, fast only — see the block above for why not all suites. */
  if (suiteName === "fast" && env.DEADMAN_URL) return { url: env.DEADMAN_URL, name: "DEADMAN_URL" };
  return { url: undefined, name };
}

async function pingDeadman(suiteName) {
  const { url, name } = resolveDeadmanUrl(suiteName);
  if (!url) {
    console.error(
      `\n✗ --deadman was requested for the ${suiteName} suite but ${name} is not set.\n` +
        "  Refusing to exit 0 on a probe whose liveness signal goes nowhere.\n" +
        `  Set the ${name} repository secret, or drop the --deadman flag deliberately.\n` +
        (suiteName === "fast"
          ? "  (The legacy DEADMAN_URL is still accepted for this suite only.)\n"
          : "  ⚠ DEADMAN_URL is NOT accepted here: it belongs to the fast suite, and pinging\n" +
            "     it from this one would keep that switch green while the fast probe was dead.\n"),
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

  const wantsAlert = args.includes("--alert");

  const outcome = await run(suiteName);
  const code = report(outcome, suiteName);

  /*
   * ⚠ THE ALERT GOES FIRST, BEFORE THE DEAD-MAN'S SWITCH AND BEFORE THE EXIT.
   * It is the only leg that carries the diagnosis, so it is the one that must
   * not be skipped by an early return added later in a hurry.
   *
   * ⚠ A failed ALERT does not change the exit code on a FAILING run — the run is
   * already red and already mailing through GitHub. Overwriting a real code 1
   * with a delivery-plumbing 3 would hide which of the two things is broken.
   * On a CLEAN run there is nothing else to notice it, so it exits 3.
   */
  let alertDelivered = true;
  if (wantsAlert) {
    alertDelivered = await pingAlert(outcome, suiteName, code);
    if (!alertDelivered && code !== 0) {
      console.error("  ✗ …and the run itself failed. Two separate problems; fix the delivery one too.");
    }
  }

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
      const pinged = await pingDeadman(suiteName);
      if (!pinged) process.exit(3);
    } else {
      console.log("  dead-man's switch NOT pinged — the run was not clean, and saying otherwise would be a lie.");
      /* Still surface a missing secret, so a misconfiguration cannot hide behind an unrelated failure. */
      if (!resolveDeadmanUrl(suiteName).url) {
        console.error(
          `  ✗ …and ${deadmanEnvName(suiteName)} is not set either. Fix that separately; it is not caused by the failure above.`,
        );
      }
    }
  }

  /*
   * ⚠ A CLEAN RUN WHOSE ALERT CHANNEL IS BROKEN EXITS 3. Nothing else would
   * ever notice: the probe is green, GitHub is quiet, and the one path that
   * carries a diagnosis is dead — which is only discovered on the day it is
   * needed. Same reasoning as the missing DEADMAN_URL, one layer out.
   *
   * ⚠⚠ THIS BRANCH HAS NEVER EXECUTED. It needs a run that is simultaneously
   * green and unable to reach hc-ping.com, which no environment available on
   * 2026-08-20 could produce — the container that could break the network could
   * not produce a green run, for the same reason. It is written to the same rule
   * as everything around it and is UNPROVEN, which is not the same as working.
   * The honest way to exercise it is to point HC_PING_KEY at a deliberately
   * wrong key on a healthy day and confirm the run goes red.
   */
  if (code === 0 && !alertDelivered) process.exit(3);

  process.exit(code);
}

/*
 * checks.mjs — the assertions, as PURE FUNCTIONS over already-fetched bytes.
 *
 * WHY THE ASSERTIONS ARE SEPARATED FROM THE FETCHING.
 *
 * Because a check that has never been observed failing is not known to work.
 * Every rule below takes a body and returns a verdict, with no network in it,
 * so `checks.test.mjs` can feed each one a deliberately broken fixture and
 * prove it goes red. That test is the whole reason this file exists as its own
 * module. If a future change moves an assertion back inline into probe.mjs to
 * save a file, the meta-test dies with it and the probe becomes unfalsifiable.
 *
 * This estate has been bitten by blind checks repeatedly: a cross-reference
 * gate that had never once run in a real build, four gate rules that could not
 * pass a correct document, a bundle manifest generated from the tree it was
 * meant to audit. In every case the check reported green because it was blind,
 * not because the thing was sound.
 *
 * WHAT THIS IS NOT. It is not the publish gate. standpoint-website already has
 * scripts/assert-live-build.mjs, which asserts nine rules against `dist/`
 * BEFORE upload, and it is better than this file at that job. The rules below
 * deliberately mirror several of its rules, because they are asking the same
 * question on the OTHER SIDE OF THE WIRE: not "is the build we are about to
 * publish the live one" but "is the live one what is actually being served
 * right now". Those diverge when an upload half-completes, when someone FTPs by
 * hand, when a document root moves, or when a stale copy is served from
 * somewhere nobody remembers. Neither check can answer the other's question.
 *
 * ⚠ DO NOT "DEDUPLICATE" THIS AGAINST assert-live-build.mjs. Two
 * implementations of one rule drift, and normally the drifting one is the
 * problem — but here the duplication is the point: the pre-publish gate reads
 * the filesystem and this reads the network, and a rule that is true of one is
 * routinely false of the other. That difference is precisely the outage class
 * being watched for.
 */

const LIVE_ORIGIN = "https://standpoint.ch";
const STAGING_HOST = "new.standpoint.ch";

/*
 * SEVERITY IS TWO VALUES AND THE DISTINCTION IS LOAD-BEARING.
 *
 *   page — the public product is broken for a visitor right now.
 *   warn — a control or a bookkeeping path is wrong. Nobody is being turned
 *          away, but it will cost money, data or trust if left.
 *
 * The suites, not this file, decide who is woken: `fast` runs page checks
 * only, `daily` runs both. So a warn produces exactly ONE red run per day
 * until it is fixed, rather than ninety-six.
 *
 * ⚠ The reason this is not a single severity: /api/availability.php is
 * documented to fail its refresh routinely and serve a good cache. Paging on
 * that would fire on healthy days, and an alert that fires on healthy days is
 * an alert that gets muted — after which the estate is worse off than with no
 * monitor at all, because everyone believes there is one.
 */
export const PAGE = "page";
export const WARN = "warn";

const ok = (id, severity, note) => ({ id, severity, ok: true, note });
const bad = (id, severity, note, observed) => ({ id, severity, ok: false, note, observed });

/* ------------------------------------------------------------------------ *
 * 1. The homepage is the LIVE build, not a staging build served by accident.
 * ------------------------------------------------------------------------ */

/*
 * The four markers below are not chosen by taste. They are the four
 * differences that deploy-staging.yml itself names as what a staging build
 * published over production would look like: "a noindex, Disallow-everything,
 * wrong-canonical, analytics-free copy that looked completely normal to a
 * human and would have surfaced weeks later in Search Console."
 *
 * ⚠ EACH RULE IS STATED TWICE WHERE IT CAN BE — the live marker PRESENT and
 * the staging marker ABSENT. A build that produced neither would otherwise
 * sail through a presence-only check. This is copied deliberately from
 * assert-live-build.mjs, which learned it the same way.
 */
export function checkHomepage({ status, body }) {
  const out = [];
  const id = "home";

  if (status !== 200) {
    return [bad(id, PAGE, `Homepage did not answer 200.`, `HTTP ${status}`)];
  }

  /*
   * ⚠ A 200 WITH AN EMPTY OR TINY BODY IS THE FAILURE THAT LOOKS LIKE HEALTH.
   * A host serving an error page, an empty directory index, or a truncated
   * upload answers 200 and satisfies every content assertion below by
   * vacuously not containing the staging markers. The floor is deliberately
   * crude: the real page is ~37 KB, so 10 KB catches a stub without being so
   * tight that an ordinary content edit trips it.
   */
  if (body.length < 10_000) {
    out.push(bad(id, PAGE, `Homepage body is implausibly small — a stub or a truncated upload.`, `${body.length} bytes`));
  }

  if (!body.includes(`<link rel="canonical" href="${LIVE_ORIGIN}/`)) {
    out.push(bad(id, PAGE, `No canonical on ${LIVE_ORIGIN}/. A staging build is being served.`, excerpt(body, /<link rel="canonical"[^>]*>/)));
  }
  if (!/content="index, follow"/.test(body)) {
    out.push(bad(id, PAGE, `Homepage is not marked 'index, follow'.`, excerpt(body, /<meta name="robots"[^>]*>/)));
  }
  if (/noindex/.test(body)) {
    out.push(bad(id, PAGE, `Homepage carries a noindex directive. This is a staging build.`, excerpt(body, /<meta name="robots"[^>]*>/)));
  }
  /*
   * Analytics is in the PAGE tier, not warn, on purpose. It is invisible to a
   * visitor, so by the ordinary reading it is not "broken for a visitor" — but
   * its absence is undetectable until someone opens the Plausible dashboard
   * weeks later and finds a hole, and by then the traffic it measured is gone
   * for good. There is no recovering the data after the fact, which is what
   * puts it above a warn.
   */
  if (!/plausible\.io\/js\//.test(body)) {
    out.push(bad(id, PAGE, `No Plausible script. The live site is measuring nothing.`, "no plausible.io/js/ in body"));
  }
  if (body.includes(STAGING_HOST)) {
    out.push(bad(id, PAGE, `Homepage still references ${STAGING_HOST}.`, excerpt(body, new RegExp(`[^"'\\s]*${STAGING_HOST}[^"'\\s]*`))));
  }

  return out.length ? out : [ok(id, PAGE, "Live build served: canonical, indexable, analytics present.")];
}

/* ------------------------------------------------------------------------ *
 * 2. robots.txt still invites the crawlers, including the AI ones.
 * ------------------------------------------------------------------------ */

/*
 * The six agents are named because the AI crawler policy is a positioning
 * decision John made deliberately — training crawlers as well as answer
 * engines, allowed on every Standpoint host. A build that silently dropped
 * them would leave a robots.txt that still looks entirely reasonable.
 *
 * ⚠ robots.txt is GENERATED BY THE BUILD from src/pages/robots.txt.ts, reading
 * the same PUBLIC_ALLOW_INDEXING as the meta tag. So this check and the
 * homepage check above can never disagree about intent — but they CAN
 * disagree about what was uploaded, which is why both are here.
 */
export const AI_AGENTS = [
  "GPTBot",
  "ClaudeBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
];

export function checkRobots({ status, body }) {
  const out = [];
  const id = "robots";

  if (status !== 200) {
    return [bad(id, PAGE, "robots.txt did not answer 200.", `HTTP ${status}`)];
  }
  if (!/^Allow: \/$/m.test(body)) {
    out.push(bad(id, PAGE, "robots.txt has no 'Allow: /'. This is a staging build.", firstLines(body, 6)));
  }
  if (/^Disallow: \/$/m.test(body)) {
    out.push(bad(id, PAGE, "robots.txt disallows crawling outright. This is a staging build.", firstLines(body, 6)));
  }
  if (!new RegExp(`^Sitemap: ${LIVE_ORIGIN}/sitemap\\.xml$`, "m").test(body)) {
    out.push(bad(id, PAGE, "robots.txt does not point at the live sitemap.", firstLines(body, 12)));
  }
  const missing = AI_AGENTS.filter((agent) => !new RegExp(`^User-agent: ${agent}$`, "m").test(body));
  if (missing.length) {
    out.push(bad(id, WARN, `AI crawler policy has lost agents from robots.txt.`, `missing: ${missing.join(", ")}`));
  }
  if (body.includes(STAGING_HOST)) {
    out.push(bad(id, PAGE, `robots.txt still references ${STAGING_HOST}.`, firstLines(body, 12)));
  }

  return out.length ? out : [ok(id, PAGE, `robots.txt invites crawling; all ${AI_AGENTS.length} AI agents present.`)];
}

/* ------------------------------------------------------------------------ *
 * 3. The booking calendar can actually be drawn.
 * ------------------------------------------------------------------------ */

/*
 * ⚠ THIS IS THE CHECK THE 13–14 AUGUST OUTAGE EXISTS TO JUSTIFY. A dead
 * Calendly token on Infomaniak killed both the availability tint and the
 * "opens on the right day" deep link for twenty-four hours, and the only thing
 * that ever witnessed it was a console.warn nobody was reading.
 *
 * ⚠ `drawable` AND `stale` ARE SEPARATE AND MUST STAY SEPARATE. The endpoint's
 * own source is explicit about this and it is not a stylistic preference:
 *
 *   drawable — there is enough data to render the calendar. FALSE is the
 *              outage. Page.
 *   stale    — this answer is a cache we could not refresh. TRUE on any
 *              ordinary failed refresh, which happens on healthy days. Warn.
 *
 * Conflating them is what hid the outage in the first place: an undrawable
 * response was indistinguishable from a merely stale one. Paging on `stale`
 * would swing the error the other way and train the alert to be ignored.
 */
export function checkAvailability({ status, body }) {
  const out = [];
  const id = "availability";
  let payload;

  if (status !== 200) {
    return [bad(id, PAGE, "/api/availability.php did not answer 200.", `HTTP ${status}`)];
  }
  try {
    payload = JSON.parse(body);
  } catch {
    /*
     * ⚠ Unparseable JSON is its own named failure, not a generic one. This
     * endpoint has already shipped a bug where a PHP warning was welded to the
     * front of valid JSON — the body was correct and unreadable at the same
     * time, and it presented to the client as the endpoint being unreachable.
     * Saying so here saves that diagnosis being redone.
     */
    return [bad(id, PAGE, "/api/availability.php did not return parseable JSON — check for output before the body.", body.slice(0, 200))];
  }

  if (payload.drawable !== true) {
    out.push(bad(id, PAGE, "Booking calendar is NOT drawable. Check STANDPOINT_CALENDLY_TOKEN on Infomaniak.", JSON.stringify(strip(payload))));
  }
  if (payload.stale === true) {
    out.push(bad(id, WARN, "Availability is a cache that could not be refreshed. Early warning, not yet an outage.", JSON.stringify(strip(payload))));
  }
  /*
   * A drawable, fresh response listing no future slots is a real condition —
   * a genuinely full diary — so this is a warn, not a page. But zero is never
   * treated as a null: a silent empty list is exactly how a broken pull
   * disguises itself as a quiet week.
   */
  if (typeof payload.future_slots === "number" && payload.future_slots === 0) {
    out.push(bad(id, WARN, "Zero future slots offered. Either the diary is full or the pull is returning nothing.", JSON.stringify(strip(payload))));
  }

  return out.length ? out : [ok(id, PAGE, `Calendar drawable and fresh (${payload.future_slots ?? "?"} future slots).`)];
}

/* ------------------------------------------------------------------------ *
 * 4. The Scan's health endpoint — READ THE BODY, NOT THE STATUS CODE.
 * ------------------------------------------------------------------------ */

/*
 * ⚠⚠ THIS IS THE SINGLE MOST IMPORTANT COMMENT IN THIS REPOSITORY.
 *
 * /api/health RETURNS 200 WHILE `ticket` IS "off" AND WHILE `register` IS
 * "admin-only". That is deliberate and correct on its side: those are config
 * states John may have chosen during a deploy window, and paging for a
 * deliberate choice trains a monitor to be ignored.
 *
 * The consequence for THIS side is absolute: a conventional uptime monitor
 * watching the status code would have reported green through the entire
 * nineteen-day period in which every audit registration returned 401 and two
 * delivered audits went missing from the dashboard. It would report green
 * today if SCAN_TICKET_SECRET vanished from Vercel and submissions became
 * unbound again.
 *
 * ⚠ IF ANYONE EVER SIMPLIFIES THIS PROBE TO "assert 200", THE PROBE STOPS
 * DOING THE ONE THING IT WAS BUILT FOR. There is no shorter version of this
 * check that is worth running.
 */
export function checkScanHealth({ status, body }) {
  const out = [];
  const id = "scan-health";
  let payload;

  try {
    payload = JSON.parse(body);
  } catch {
    /*
     * ⚠ AN EMPTY BODY HAS TO SAY SO — found on 2026-08-20 by watching a real
     * failing run rather than by reading this line. `"".slice(0, 200)` is the
     * empty string, so the failure rendered `observed:` followed by nothing,
     * which reads as a field the check forgot to fill rather than as the
     * finding itself. It is also exactly the shape a transport failure takes
     * (status 0, body ""), i.e. the case where naming it saves the reader from
     * going off to debug malformed JSON that was never served at all.
     */
    const observed = body
      ? body.slice(0, 200)
      : `HTTP ${status}, EMPTY BODY — no bytes at all, which usually means unreachable rather than malformed`;
    return [bad(id, PAGE, "/api/health did not return parseable JSON.", observed)];
  }

  /*
   * db is the only field that moves the status code, so it is the only one
   * where the code and the body agree. Both are asserted anyway — a 200 with
   * db:"error" would mean the endpoint's own contract had broken, which is
   * worth knowing loudly.
   */
  if (status !== 200 || payload.ok !== true || payload.db !== "ok") {
    out.push(bad(id, PAGE, "Scan database is not reachable. Every scan is failing.", `HTTP ${status} ${JSON.stringify(payload)}`));
  }
  if (payload.ticket !== "enforce") {
    out.push(bad(id, WARN, `B-07 submission ticket is not enforcing (${payload.ticket}). 'off' means SCAN_TICKET_SECRET is missing and submissions are unbound.`, `ticket=${payload.ticket}`));
  }
  if (payload.register !== "on") {
    out.push(bad(id, WARN, `Audit registry is not accepting the skill's token (${payload.register}). 'admin-only' is the state that looks fine and is not — delivered audits will silently miss the dashboard.`, `register=${payload.register}`));
  }

  return out.length ? out : [ok(id, PAGE, `db ok · ticket enforce · register on (${payload.ms} ms).`)];
}

/* ------------------------------------------------------------------------ *
 * 5. The sitemap has not quietly lost pages. (Weekly.)
 * ------------------------------------------------------------------------ */

/*
 * ⚠ THE FLOOR IS A RATCHET, NOT A CONSTANT. It is passed in rather than
 * hard-coded so that adding an interview raises it and nothing has to be
 * remembered. What it catches is the direction that is always a defect: pages
 * DISAPPEARING. A count that grows is normal; a count that shrinks has never
 * been intentional here.
 *
 * ⚠ It also asserts every URL is on the live origin, for the reason
 * assert-live-build.mjs records as "the fourth instance of the same rule": a
 * check that reads the file NAMING a thing has not read the thing. robots.txt
 * pointing at the live sitemap says nothing about what that sitemap contains,
 * and a sitemap full of staging URLs once satisfied every check in the estate.
 */
/*
 * ⚠ HOW MUCH DRIFT IS TOLERATED BEFORE THE WARNING FIRES, and why it is not 0.
 *
 * At 0 the warning fires the day after any page is published, every time, which
 * makes it noise and gets it ignored — and an ignored warning is the exact
 * failure this repository was built after. At 10 it fires when the gap has grown
 * to something that would actually matter if those pages disappeared. Both of
 * the real gaps observed so far — 25 pages, twice — clear it easily.
 */
const DRIFT_SLACK = 10;

export function checkSitemap({ status, body }, { floor }) {
  const out = [];
  const id = "sitemap";

  if (status !== 200) {
    return [bad(id, PAGE, "sitemap.xml did not answer 200.", `HTTP ${status}`)];
  }
  if (!/<urlset\b/.test(body)) {
    return [bad(id, PAGE, "sitemap.xml is not a <urlset>.", body.slice(0, 200))];
  }

  const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

  if (urls.length < floor) {
    out.push(bad(id, PAGE, `Sitemap has LOST pages — ${urls.length} URLs, floor is ${floor}. Pages do not disappear on purpose.`, `${urls.length} < ${floor}`));
  }

  /*
   * ⚠⚠ THE DRIFT WARNING — because "remember to raise the floor" is an
   * instruction that has now failed twice in one day.
   *
   * The floor sat at 44 for four days while the site served 69, so the check
   * could have watched 25 pages vanish and stayed green. It was corrected to 69
   * at 16:16 on 2026-08-20 and was stale again by 17:16, when a different
   * session published 25 French pages. Both gaps were found BY ACCIDENT, while
   * testing something else.
   *
   * ⚠ THE CHECK'S BLIND SIDE IS THE DISTANCE BETWEEN THE FLOOR AND REALITY, AND
   * NOTHING WAS MEASURING IT. A floor is a ratchet; a ratchet nobody ratchets is
   * a number that silently stops meaning anything. So the gap is now reported.
   *
   * ⚠ WARN, NOT PAGE, AND THAT IS THE WHOLE DESIGN. Publishing pages is normal
   * and good; nothing is broken for a visitor; John decides when to raise it. A
   * page-level failure here would fire on a healthy day after ordinary work,
   * which is how an alert gets muted — and a muted sitemap check takes the real
   * "pages have disappeared" signal with it. ⚠ In practice this surfaces WEEKLY
   * and only weekly, since the sitemap is only fetched by that suite: once a
   * week is the right cadence for a chore, and would be far too slow for an
   * incident. Another reason it must not be a page.
   *
   * ⚠ The slack is deliberately generous. A tight threshold would fire on every
   * single publication and be indistinguishable from noise.
   */
  const drift = urls.length - floor;
  if (drift > DRIFT_SLACK) {
    out.push(
      bad(
        id,
        WARN,
        `Sitemap floor has drifted — ${drift} pages above the floor of ${floor}. That gap is how many pages could vanish unnoticed. Raise SITEMAP_FLOOR to ${urls.length}.`,
        `${urls.length} served, floor ${floor}, blind to a loss of up to ${drift}`,
      ),
    );
  }
  const foreign = urls.filter((u) => !u.startsWith(`${LIVE_ORIGIN}/`));
  if (foreign.length) {
    out.push(bad(id, PAGE, "Sitemap lists URLs that are not on the live origin.", foreign.slice(0, 5).join(", ")));
  }
  if (!urls.includes(`${LIVE_ORIGIN}/`)) {
    out.push(bad(id, PAGE, "Sitemap does not list the homepage.", `${urls.length} URLs, no ${LIVE_ORIGIN}/`));
  }

  return out.length ? out : [ok(id, PAGE, `Sitemap lists ${urls.length} live URLs (floor ${floor}).`)];
}

/* ------------------------------------------------------------------------ *
 * 6. Hidden pages are still hidden — as a SET, in both directions.
 * ------------------------------------------------------------------------ */

/*
 * standpoint-website retired a hand-maintained UNLISTED_PAGES list for a
 * reason worth repeating here: John publishes hidden pages ON PURPOSE —
 * /setup-a-session/ is how startup clients book time with him — so "this page
 * is noindex" was never the right question, and a list fails in the quiet
 * direction when a second hidden page is simply never added to it.
 *
 * Served-side, the invariant that survives is narrower but still checkable in
 * both directions, which is what makes it worth having:
 *
 *   - the page must still be REACHABLE (200), or a client following a link
 *     John sent them personally hits a 404 and says nothing;
 *   - and it must still be ABSENT from the sitemap, or it has quietly become
 *     public.
 *
 * ⚠ Failing only one direction is the trap. A check that only asserted "not in
 * sitemap" would pass with flying colours on a page that had been deleted.
 */
export function checkHiddenPage({ status }, { sitemapUrls, url }) {
  const out = [];
  const id = "hidden-page";

  if (status !== 200) {
    out.push(bad(id, PAGE, `Unlisted page ${url} is not reachable. Anyone John sent the link to gets a 404.`, `HTTP ${status}`));
  }
  if (sitemapUrls.some((u) => u.replace(/\/$/, "") === url.replace(/\/$/, ""))) {
    out.push(bad(id, WARN, `Unlisted page ${url} has appeared in the sitemap — it is no longer unlisted.`, url));
  }

  return out.length ? out : [ok(id, PAGE, `${url} reachable and correctly absent from the sitemap.`)];
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function excerpt(body, pattern) {
  const match = body.match(pattern);
  return match ? match[0].slice(0, 200) : "(marker not present at all)";
}

function firstLines(body, n) {
  return body.split("\n").slice(0, n).join(" ⏎ ").slice(0, 300);
}

/* The slot list is long and says nothing a human reading an alert needs. */
function strip(payload) {
  const { slots, ...rest } = payload;
  return rest;
}

/* ------------------------------------------------------------------------ *
 * 7. chartingyourretirementjourney.com — added 2026-08-24 [claim-3c4e]
 * ------------------------------------------------------------------------ */

const CYRJ_ORIGIN = "https://chartingyourretirementjourney.com";
const CYRJ_STAGING_HOST = "new.chartingyourretirementjourney.com";

/*
 * ⚠ A SEPARATE FUNCTION RATHER THAN A PARAMETERISED checkHomepage, DELIBERATELY.
 *
 * `checkHomepage` closes over LIVE_ORIGIN at module scope. Generalising it would
 * mean editing a check that currently guards a live site, to add a second one —
 * and the two sites do not actually want the same assertions. standpoint.ch
 * pages on missing analytics; CYRJ has no analytics decision yet. CYRJ must be
 * free of two markers standpoint.ch has never heard of. The duplication is
 * cheaper than the coupling, and the same argument is already made at the top of
 * this file about duplicating the pre-publish gate.
 *
 * WHAT THIS SITE'S OUTAGES ACTUALLY LOOK LIKE, which is what these assert:
 *
 *   · A STAGING BUILD PUBLISHED OVER PRODUCTION. It happened on 2026-08-21,
 *     during cutover: `npm run deploy:staging` was run after the domain had been
 *     repointed, and the live site served a noindex, Disallow-everything build
 *     that RENDERED PERFECTLY. `.cutover-done` now refuses that command, but a
 *     guard in one repo is not a monitor on the live URL.
 *   · THE WORDPRESS PAST COMING BACK. Until 2026-08-21 this site served its
 *     logo, both author portraits and half its homepage illustrations from
 *     `ut6on4bvzlz.preview.infomaniak.website` — a PREVIEW host. WordPress is
 *     still on disk as the rollback. If the document root is ever pointed back,
 *     the site returns 200 on every page and looks plausible.
 */
export function checkCyrjHome({ status, body }) {
  const out = [];
  const id = "cyrj-home";

  if (status !== 200) {
    return [bad(id, PAGE, `chartingyourretirementjourney.com did not answer 200.`, `HTTP ${status}`)];
  }

  /*
   * ⚠ A 200 WITH A TINY BODY IS THE FAILURE THAT LOOKS LIKE HEALTH — the same
   * reasoning as the standpoint.ch homepage above. Measured on the live page,
   * which is comfortably over 20 KB; 8 KB catches a stub or a truncated upload
   * without tripping on ordinary copy edits.
   */
  if (body.length < 8_000) {
    out.push(bad(id, PAGE, `CYRJ homepage body is implausibly small — a stub or a truncated upload.`, `${body.length} bytes`));
  }

  /* Stated twice where it can be: live marker PRESENT, staging marker ABSENT. */
  if (!body.includes(`<link rel="canonical" href="${CYRJ_ORIGIN}/`)) {
    out.push(bad(id, PAGE, `No canonical on ${CYRJ_ORIGIN}/. A staging build is being served.`, excerpt(body, /<link rel="canonical"[^>]*>/)));
  }
  if (body.includes(CYRJ_STAGING_HOST)) {
    out.push(bad(id, PAGE, `The page references ${CYRJ_STAGING_HOST}. A staging build is being served.`, excerpt(body, new RegExp(`[^"']*${CYRJ_STAGING_HOST}[^"']*`))));
  }
  if (!/content="index, follow"/.test(body)) {
    out.push(bad(id, PAGE, `CYRJ homepage is not marked 'index, follow'.`, excerpt(body, /<meta name="robots"[^>]*>/)));
  }
  if (/noindex/.test(body)) {
    out.push(bad(id, PAGE, `CYRJ homepage carries a noindex directive. This is a staging build.`, excerpt(body, /<meta name="robots"[^>]*>/)));
  }

  /*
   * ⚠ THE TWO MARKERS UNIQUE TO THIS SITE. Their presence means either the
   * WordPress rollback is being served, or an asset reverted to the preview
   * host. Both return 200 on every page and look entirely normal.
   */
  if (body.includes("wp-content")) {
    out.push(bad(id, PAGE, `CYRJ homepage references wp-content — WordPress is being served, or an asset was not migrated.`, excerpt(body, /[^"']*wp-content[^"']*/)));
  }
  if (body.includes("preview.infomaniak.website")) {
    out.push(bad(id, PAGE, `CYRJ homepage references the Infomaniak PREVIEW host. That dependency is what the rebuild removed.`, excerpt(body, /[^"']*preview\.infomaniak\.website[^"']*/)));
  }

  /*
   * ⚠ ANALYTICS IS PAGE-TIER HERE, MATCHING standpoint.ch, AND FOR ITS REASON:
   * it is invisible to a visitor, so by the ordinary reading it is not "broken"
   * — but its absence is undetectable until someone opens the Plausible
   * dashboard weeks later and finds a hole, and by then the traffic it would
   * have measured is gone. There is no backfill.
   *
   * ⚠ Added 2026-08-24 [claim-5b7a], NOT with the rest of these checks. The
   * earlier pass deliberately left it out because Plausible was undecided for
   * this site, and an assertion that pages on a site never meant to have
   * analytics is worse than none. John decided yes; the assertion follows the
   * decision rather than presuming it.
   *
   * ⚠ WHAT THIS CANNOT SEE: that the domain is REGISTERED in the Plausible
   * account. The script tag being present is all any check here can observe.
   * A `data-domain` for a site Plausible does not know about loads perfectly
   * and its events are discarded in silence.
   */
  if (!/plausible\.io\/js\//.test(body)) {
    out.push(bad(id, PAGE, `CYRJ homepage carries no Plausible script. Analytics is off, and the gap cannot be backfilled.`, excerpt(body, /<script[^>]*>/)));
  }

  return out.length ? out : [ok(id, PAGE, "CYRJ homepage is the live build: canonical, indexable, analytics on, no wp-content, no preview host.")];
}

/*
 * ⚠ THE ASSERTION IS THE MAGIC BYTES, NOT THE CONTENT-TYPE HEADER.
 *
 * The probe hands checks `{ status, body }` as TEXT and no headers, so a
 * content-type assertion is not available here — and that is no loss, because
 * `%PDF` is the stronger claim anyway. A host serving an HTML 404 under a
 * `.pdf` name can still send `content-type: application/pdf`; it cannot fake
 * the first four bytes of the file.
 *
 * WHY A WORKSHEET AND NOT SOME OTHER URL. The seventeen worksheet PDFs are what
 * the printed book's QR codes send readers to. Those codes cannot be reissued.
 * A worksheet that 404s is the one failure on this site with no recovery path
 * and no other witness — nobody browses to `/downloads/` to check.
 */
export function checkCyrjWorksheet({ status, body }) {
  const id = "cyrj-worksheet";

  if (status !== 200) {
    return [bad(id, PAGE, `A worksheet PDF did not answer 200. The printed QR codes lead here.`, `HTTP ${status}`)];
  }
  if (!body.startsWith("%PDF")) {
    return [
      bad(
        id,
        PAGE,
        `A worksheet URL answered 200 but the body is not a PDF — an error page under a .pdf name.`,
        `first bytes: ${JSON.stringify(body.slice(0, 40))}`,
      ),
    ];
  }
  /*
   * The real file is ~99 KB. A truncated upload still begins with %PDF, so the
   * magic bytes alone would pass it.
   */
  if (body.length < 5_000) {
    return [bad(id, PAGE, `A worksheet PDF is implausibly small — a truncated upload.`, `${body.length} bytes`)];
  }

  return [ok(id, PAGE, "A worksheet PDF is served, and it is genuinely a PDF.")];
}

/* ------------------------------------------------------------------------ *
 * SERVER-SIDE CONFIG — the hand-pasted .htaccess. Added 2026-08-24 [claim-3b8e]
 * ------------------------------------------------------------------------ *
 *
 * ⚠⚠ EVERYTHING BELOW WATCHES RULES THAT EXIST ONLY ON A SERVER, AND UNTIL
 * TODAY NOTHING WATCHED THEM AT ALL. A grep for `Redirect` or `301` across this
 * file and probe.mjs returned zero.
 *
 * WHY THIS CLASS IS INVISIBLE TO EVERY OTHER INSTRUMENT WE HAVE.
 * standpoint-website's scripts/assert-live-build.mjs reads `dist/`. These rules
 * are not in `dist/` and CANNOT BE: scripts/deploy-staging.mjs lists ".htaccess"
 * in `protectedNames`, so it refuses to upload one, deliberately — the root
 * .htaccess is host-managed and once carried the staging password protection.
 * So the rules are pasted by hand into the Infomaniak manager and live nowhere
 * else that any automated thing can read. Only a network probe can see them.
 *
 * ⚠ WHAT THAT COST, MEASURED. `ErrorDocument 404 /404.html` sat on OPEN_ITEMS.md
 * as an open P1 — "without this the 404 page is never served" — from before the
 * 12 August launch until 24 August, while it worked perfectly the whole time.
 * Nobody was careless. There was no instrument that could have told anyone.
 *
 * ⚠ THIS DUPLICATES standpoint-website's scripts/check-redirects.sh, AND THAT
 * IS DELIBERATE, for the same reason the header of this file gives for not
 * deduplicating against assert-live-build.mjs. That script is a launch tool: a
 * human runs it at a domain switch. This asks the same question every day
 * without being remembered. ⚠ The two lists WILL drift, because they are in
 * different repositories and nothing can import across them — see the ⚠ on
 * REDIRECT_RULES in probe.mjs for the reconciliation that has to stay manual.
 */

/*
 * ⚠⚠ A 404 HANDLER CANNOT BE CHECKED BY ITS STATUS CODE. THIS IS THE WHOLE
 * POINT OF THESE TWO RULES.
 *
 * Working and broken both answer `404`. When the handler is missing, Apache
 * serves its own grey default page — still 404. When /fr/'s handler is missing,
 * the ROOT handler cascades down and serves the ENGLISH page under a French
 * URL — still 404, still renders perfectly, still not blank. Every check anyone
 * would naturally reach for (status code, body non-empty, no server error)
 * PASSES in both broken states.
 *
 * Measured on 2026-08-24, before the fix, on /fr/no-such-page-xyz/:
 *   grep -c "vous cherchiez" -> 0        grep -c "came here for" -> 2
 * After John created <site>/fr/.htaccess:
 *   grep -c "vous cherchiez" -> 2        grep -c "came here for" -> 0
 *
 * So the assertion is on the BODY, and the French one asserts the ABSENCE of
 * the English marker as well as the presence of the French one. The absence is
 * the half that catches the real regression; presence alone would too, but a
 * failure that says "the English page is being served here" costs nobody a
 * debugging session, and one that says "marker missing" costs everybody one.
 */
const EN_NOT_FOUND_MARKER = "came here for";
const FR_NOT_FOUND_MARKER = "vous cherchiez";

function notFoundBase(id, severity, { status, body }, url) {
  if (status === 0) {
    return [bad(id, severity, `${url} could not be reached at all.`, "transport failure — status 0, empty body")];
  }
  /*
   * ⚠ NOT `!== 404`. A 200 here is a SOFT 404 — the page rendering as an
   * ordinary success, which is the shape that gets a 404 page indexed — and a
   * 403 is Apache refusing a directory, which is what the /setup-a-session/
   * deploy looked like mid-flight on 14 August. Three different problems, and
   * the message names which one was seen.
   */
  if (status !== 404) {
    return [
      bad(
        id,
        severity,
        status === 200
          ? `${url} answered 200 — a missing page is being served as a SUCCESS. Search engines will index it.`
          : `${url} answered ${status}, not 404.`,
        `HTTP ${status}, expected 404`,
      ),
    ];
  }
  return null;
}

/*
 * English. PAGE severity: when this breaks, a visitor who mistypes a URL gets
 * Apache's unstyled grey error page with the server version on it. That is the
 * public product being broken, which is what `page` means here.
 */
export function checkNotFoundEn(response, { url }) {
  const id = "notFoundEn";
  const early = notFoundBase(id, PAGE, response, url);
  if (early) return early;

  const { body } = response;
  if (!body.includes(EN_NOT_FOUND_MARKER)) {
    return [
      bad(
        id,
        PAGE,
        "The English 404 handler is gone — a missing page shows Apache's default error page, not ours.",
        `body has no ${JSON.stringify(EN_NOT_FOUND_MARKER)}; add "ErrorDocument 404 /404.html" to the root .htaccess`,
      ),
    ];
  }
  return [ok(id, PAGE, `custom English 404 served, status 404 (asserted on the body, not the status)`)];
}

/*
 * French. WARN, not PAGE, and the distinction is the one this file's severity
 * doctrine is built on: when this breaks nobody is turned away. A visitor gets
 * a real, styled, working 404 page — in the wrong language. That is worth one
 * red daily run, not ninety-six.
 */
export function checkNotFoundFr(response, { url }) {
  const id = "notFoundFr";
  const early = notFoundBase(id, WARN, response, url);
  if (early) return early;

  const { body } = response;
  const out = [];

  if (body.includes(EN_NOT_FOUND_MARKER)) {
    /*
     * ⚠ THIS IS THE REGRESSION THAT ACTUALLY HAPPENED, from the French site
     * shipping on 19 August until 24 August. Named explicitly so the alert
     * carries its own diagnosis.
     */
    out.push(
      bad(
        id,
        WARN,
        "French visitors are being served the ENGLISH 404 page. The /fr/ handler is missing and the root one is cascading down.",
        'create <site>/fr/.htaccess containing: ErrorDocument 404 /fr/404/index.html',
      ),
    );
  } else if (!body.includes(FR_NOT_FOUND_MARKER)) {
    out.push(
      bad(
        id,
        WARN,
        "The French 404 handler is gone and the English one is not covering for it either.",
        `body has no ${JSON.stringify(FR_NOT_FOUND_MARKER)} and no ${JSON.stringify(EN_NOT_FOUND_MARKER)}`,
      ),
    );
  }

  /*
   * ⚠ The lang attribute is checked because it has ALREADY been wrong on this
   * exact page: the French 404 shipped as <html lang="en"> on 19 August,
   * because `locale="fr"` was never passed to BaseLayout on the one page
   * written by hand. A build gate caught it that time; nothing would catch it
   * being reintroduced at the server layer, and our own Scan reads this
   * attribute as its locale tiebreaker.
   */
  if (out.length === 0 && !body.includes('lang="fr')) {
    out.push(
      bad(id, WARN, "The French 404 page is served but declares a non-French lang attribute.", 'expected lang="fr…" in the <html> tag'),
    );
  }

  return out.length ? out : [ok(id, WARN, "custom French 404 served, and the English page is NOT leaking into /fr/")];
}

/*
 * REDIRECTS.
 *
 * Takes already-fetched observations so this stays a pure function like every
 * other rule here. Each observation is
 *   { from, want, status, location, finalStatus, transportError }
 * where `status`/`location` come from an UNFOLLOWED request and `finalStatus`
 * from a followed one. Both halves are needed and neither is sufficient:
 * a 301 to a URL that itself 404s is a broken redirect that looks fine to any
 * checker that only reads the first response, and a followed-only check cannot
 * tell a 301 from a meta-refresh page — which matters here, because
 * astro.config.mjs emits meta-refresh pages for these same slugs and those pass
 * no signal to a search engine.
 */
export function checkRedirects(observations) {
  const id = "redirects";
  const out = [];

  /*
   * ⚠ VERIFYING NOTHING IS NOT A PASS. An empty table means someone emptied
   * REDIRECT_RULES or the wiring broke, and the honest report of that is RED,
   * not a green tick over zero rules. This exact shape shipped a "✓ Shipped.
   * 0 page(s)" in ship.mjs's first draft.
   */
  if (observations.length === 0) {
    return [bad(id, WARN, "No redirect rules were checked at all.", "REDIRECT_RULES is empty — the check is blind, not clean")];
  }

  for (const o of observations) {
    if (o.transportError) {
      out.push(bad(id, WARN, `${o.from} could not be reached.`, `transport failure — ${o.transportError}`));
      continue;
    }
    if (o.status !== 301) {
      out.push(
        bad(
          id,
          WARN,
          `${o.from} no longer 301s.`,
          `HTTP ${o.status}${o.status === 404 ? " — the rule is gone from .htaccess" : ""}, expected 301 -> ${o.want}`,
        ),
      );
      continue;
    }
    if (!String(o.location || "").endsWith(o.want)) {
      out.push(bad(id, WARN, `${o.from} 301s to the wrong place.`, `Location ${o.location || "(absent)"}, expected to end with ${o.want}`));
      continue;
    }
    /*
     * ⚠ A 301 TO A DEAD PAGE IS THE FAILURE THIS HALF EXISTS FOR. It is worse
     * than no redirect: a 404 loses one citation, whereas a 301 tells four
     * answer engines that a specific page is the successor to the old one.
     */
    if (o.finalStatus !== 200) {
      out.push(bad(id, WARN, `${o.from} 301s to ${o.want}, which is DEAD.`, `following the redirect gives HTTP ${o.finalStatus}, expected 200`));
    }
  }

  /*
   * ⚠ THE COVERAGE LINE IS NOT DECORATION. A gate reports what it RAN, not
   * only what it found — `L19-xref` in the audit toolkit read green for weeks
   * having never executed. If this number ever drops, the check narrowed and
   * nobody would otherwise see it.
   */
  if (out.length === 0) {
    return [ok(id, WARN, `${observations.length} of ${observations.length} redirect rules ok (301, right target, target answers 200)`)];
  }
  out.push(ok(id, WARN, `${observations.length - out.length} of ${observations.length} redirect rules ok`));
  return out;
}

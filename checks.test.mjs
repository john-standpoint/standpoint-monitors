/*
 * checks.test.mjs — proves every assertion can go RED.
 *
 *   node --test
 *
 * ⚠⚠ THIS IS THE MOST IMPORTANT FILE IN THE REPOSITORY, AND IT IS NOT A UNIT
 * TEST SUITE IN THE ORDINARY SENSE.
 *
 * A monitor that has only ever been observed passing is indistinguishable from
 * a monitor that cannot fail. Both print a green tick, on a healthy system and
 * on a burning one alike. This estate has met that shape at least six times:
 *
 *   · a cross-reference gate that had never once run in a real build, because
 *     it called `node` where there was no node_modules — green, forever;
 *   · four gate rules that could not pass a CORRECT document, teaching
 *     everyone to work around the gate;
 *   · a bundle manifest generated FROM the tree it was supposed to audit, so
 *     client data was listed, packed, and verified as a clean pass;
 *   · a health check that probed a column which did not exist, answering 503
 *     against a database that was perfectly fine;
 *   · a report field stored and rendered by nothing, so a correct read looked
 *     like a missed page;
 *   · a cover screenshot that worked once in fourteen attempts, absent at four
 *     layers, each indistinguishable from success.
 *
 * The lesson every one of them teaches is the same: verify the check by
 * breaking the thing. So each test below feeds a deliberately broken fixture
 * to a real assertion and REQUIRES it to fail — and, just as importantly,
 * feeds the good fixture and requires it to pass, because a rule that fails on
 * everything is no better than one that passes on everything.
 *
 * ⚠ ADDING A CHECK WITHOUT ADDING ITS RED TEST HERE IS ADDING A CHECK NOBODY
 * KNOWS WORKS. The whole plan this repository implements exists because that
 * keeps happening.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PAGE,
  WARN,
  checkAvailability,
  checkCyrjHome,
  checkCyrjWorksheet,
  checkHiddenPage,
  checkHomepage,
  checkRobots,
  checkScanHealth,
  checkSitemap,
} from "./checks.mjs";

/* ------------------------------------------------------------------------ *
 * Fixtures — the GOOD ones are the bytes production actually served on
 * 2026-08-16, trimmed. Inventing a "realistic" fixture is how a test comes to
 * assert something the live system never does.
 * ------------------------------------------------------------------------ */

const GOOD_HOME =
  `<!DOCTYPE html><html lang="en"><head>` +
  `<link rel="canonical" href="https://standpoint.ch/">` +
  `<meta name="robots" content="index, follow">` +
  `<script defer src="https://plausible.io/js/pa-ErC926G8tXfQpneI8tW7R.js"></script>` +
  `</head><body>` +
  "x".repeat(20_000) +
  `</body></html>`;

const GOOD_ROBOTS = `# Standpoint - live site

User-agent: *
Allow: /

User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Applebot-Extended
Allow: /

Sitemap: https://standpoint.ch/sitemap.xml
`;

const GOOD_AVAILABILITY = JSON.stringify({
  ok: true,
  generated_at: "2026-08-16T12:27:41Z",
  stale: false,
  drawable: true,
  future_slots: 147,
  slots: ["2026-08-18T12:30:00Z"],
});

const GOOD_HEALTH = JSON.stringify({
  ok: true,
  db: "ok",
  ticket: "enforce",
  register: "on",
  ms: 466,
});

const GOOD_SITEMAP =
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  Array.from({ length: 44 }, (_, i) => `<loc>https://standpoint.ch/${i === 0 ? "" : `page-${i}/`}</loc>`).join("") +
  `</urlset>`;

const SITEMAP_URLS = [...GOOD_SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

/* Helpers that say what the test means rather than how it inspects the array. */
const failures = (results) => results.filter((r) => !r.ok);
const failedWith = (results, severity) => failures(results).filter((r) => r.severity === severity);

/* ------------------------------------------------------------------------ *
 * 1. Homepage — the live-build signature
 * ------------------------------------------------------------------------ */

test("homepage: the real served bytes pass", () => {
  const results = checkHomepage({ status: 200, body: GOOD_HOME });
  assert.equal(failures(results).length, 0, "production bytes must not trip the check");
});

test("homepage: a staging build FAILS on every one of its four markers", () => {
  /*
   * This is the disaster deploy-staging.yml describes: the old staging build
   * published over production. It renders perfectly and looks completely
   * normal to a human. All four markers are wrong at once, which is exactly
   * how it presents — they all come from the same three PUBLIC_* variables.
   */
  const staging = GOOD_HOME.replace(
    `<link rel="canonical" href="https://standpoint.ch/">`,
    `<link rel="canonical" href="https://new.standpoint.ch/">`,
  )
    .replace(`content="index, follow"`, `content="noindex, nofollow"`)
    .replace(/<script defer src="https:\/\/plausible\.io[^>]*><\/script>/, "");

  const notes = failedWith(checkHomepage({ status: 200, body: staging }), PAGE).map((f) => f.note).join(" | ");
  assert.match(notes, /canonical/i);
  assert.match(notes, /index, follow/i);
  assert.match(notes, /noindex/i);
  assert.match(notes, /Plausible/i);
  assert.match(notes, /new\.standpoint\.ch/i);
});

test("homepage: a 200 with an empty body FAILS rather than vacuously passing", () => {
  /*
   * ⚠ The nastiest case in the file. An empty or truncated response contains
   * none of the staging markers, so a presence-only-of-bad-things check would
   * report it clean. A host serving an empty directory after a half-finished
   * upload answers exactly this.
   */
  const results = checkHomepage({ status: 200, body: "" });
  assert.ok(failedWith(results, PAGE).length > 0, "an empty 200 must never pass");
  assert.match(failures(results).map((f) => f.note).join(" "), /implausibly small/i);
});

test("homepage: a non-200 fails immediately and says so", () => {
  const results = checkHomepage({ status: 503, body: "" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].observed, /503/);
});

/* ------------------------------------------------------------------------ *
 * 2. robots.txt
 * ------------------------------------------------------------------------ */

test("robots: the real served bytes pass", () => {
  assert.equal(failures(checkRobots({ status: 200, body: GOOD_ROBOTS })).length, 0);
});

test("robots: a staging robots.txt that disallows everything FAILS", () => {
  const staging = "User-agent: *\nDisallow: /\n";
  const notes = failedWith(checkRobots({ status: 200, body: staging }), PAGE).map((f) => f.note).join(" | ");
  assert.match(notes, /Allow/i);
  assert.match(notes, /disallows crawling/i);
});

test("robots: losing the AI crawler agents WARNS, and names which ones", () => {
  /*
   * A warn rather than a page: the site still works for humans. But it is a
   * deliberate positioning decision of John's, so it must not vanish quietly —
   * and the alert names the missing agents, because "robots.txt changed" would
   * cost a diff to interpret.
   */
  const withoutClaude = GOOD_ROBOTS.replace("User-agent: ClaudeBot\n", "").replace(
    "User-agent: Claude-SearchBot\n",
    "",
  );
  const warns = failedWith(checkRobots({ status: 200, body: withoutClaude }), WARN);
  assert.equal(warns.length, 1);
  assert.match(warns[0].observed, /ClaudeBot/);
  assert.match(warns[0].observed, /Claude-SearchBot/);
});

/* ------------------------------------------------------------------------ *
 * 3. Availability — the 13–14 August outage
 * ------------------------------------------------------------------------ */

test("availability: the real served bytes pass", () => {
  assert.equal(failures(checkAvailability({ status: 200, body: GOOD_AVAILABILITY })).length, 0);
});

test("availability: THE 24-HOUR OUTAGE — a dead Calendly token PAGES", () => {
  /*
   * The 13–14 August shape: the token is dead, so nothing can be drawn. Under
   * the old conflated reading this was indistinguishable from an ordinary
   * stale cache, which is exactly why it survived a day witnessed by nothing
   * but a console.warn.
   */
  const dead = JSON.stringify({ ok: true, stale: true, drawable: false, future_slots: 0 });
  const pages = failedWith(checkAvailability({ status: 200, body: dead }), PAGE);
  assert.equal(pages.length, 1);
  assert.match(pages[0].note, /NOT drawable/i);
  assert.match(pages[0].note, /STANDPOINT_CALENDLY_TOKEN/);
});

test("availability: a merely STALE cache warns and does NOT page", () => {
  /*
   * ⚠ The single most important negative assertion in this file. Paging here
   * would fire on ordinary healthy days — the endpoint is documented to fail
   * refreshes routinely and serve a good cache — and an alert that fires on
   * healthy days is an alert that gets muted, after which the estate is worse
   * off than with no monitor at all.
   */
  const stale = JSON.stringify({ ok: true, stale: true, drawable: true, future_slots: 147 });
  const results = checkAvailability({ status: 200, body: stale });
  assert.equal(failedWith(results, PAGE).length, 0, "a stale but drawable calendar must NEVER page");
  assert.equal(failedWith(results, WARN).length, 1);
});

test("availability: zero future slots is a FINDING, not a null", () => {
  const empty = JSON.stringify({ ok: true, stale: false, drawable: true, future_slots: 0 });
  const warns = failedWith(checkAvailability({ status: 200, body: empty }), WARN);
  assert.equal(warns.length, 1);
  assert.match(warns[0].note, /Zero future slots/i);
});

test("availability: JSON with a PHP warning welded to the front FAILS as unparseable", () => {
  /*
   * A real bug this endpoint has already shipped: display_errors printing a
   * notice ahead of a perfectly valid body. It presented to the client as the
   * endpoint being unreachable, which sent the diagnosis in the wrong
   * direction. The check names the cause so that is not repeated.
   */
  const polluted = `<br /><b>Warning</b>: something\n${GOOD_AVAILABILITY}`;
  const results = checkAvailability({ status: 200, body: polluted });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /parseable JSON/i);
});

/* ------------------------------------------------------------------------ *
 * 4. Scan health — the checks a status-code monitor cannot do
 * ------------------------------------------------------------------------ */

test("scan health: the real served bytes pass", () => {
  assert.equal(failures(checkScanHealth({ status: 200, body: GOOD_HEALTH })).length, 0);
});

test("⚠ scan health: AN EMPTY BODY IS NAMED, not reported as an empty observed value", () => {
  /*
   * Found 2026-08-20 by reading a genuinely failing run: with no egress the
   * body is "", and `body.slice(0, 200)` made the alert say `observed:` and
   * then stop. An observed value that is blank is indistinguishable from a
   * check that forgot to record one — the same ambiguity as an empty key file
   * reading identically to an absent one, which cost nine days once.
   */
  const results = checkScanHealth({ status: 0, body: "" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.ok(results[0].observed.trim().length > 0, "the observed value must not be blank");
  assert.match(results[0].observed, /EMPTY BODY/);
  assert.match(results[0].observed, /HTTP 0/, "the status belongs with it — 0 means unreachable");
});

test("scan health: THE 19-DAY OUTAGE — register 'admin-only' behind a 200 is caught", () => {
  /*
   * ⚠⚠ THE TEST THIS ENTIRE REPOSITORY EXISTS TO MAKE POSSIBLE.
   *
   * Note the status: 200. This is not a hypothetical — it is the exact
   * response scan.standpoint.ch served for nineteen days while every audit
   * registration returned 401 and two delivered audits went missing from the
   * dashboard. A monitor watching the status code sees 200 and reports green.
   * The body is the only place the failure exists.
   *
   * 'admin-only' is the specific state described as the one that LOOKS FINE
   * AND IS NOT: registration works from a manual curl, and never from the
   * audit skill, which does not hold the dashboard password.
   */
  const results = checkScanHealth({
    status: 200,
    body: JSON.stringify({ ok: true, db: "ok", ticket: "enforce", register: "admin-only", ms: 12 }),
  });
  assert.equal(failedWith(results, PAGE).length, 0, "a bookkeeping door is not a visitor-facing outage");
  const warns = failedWith(results, WARN);
  assert.equal(warns.length, 1);
  assert.match(warns[0].note, /looks fine and is not/i);
  assert.match(warns[0].observed, /register=admin-only/);
});

test("scan health: ticket 'off' behind a 200 is caught", () => {
  /* B-07 wide open — submissions unbound — while every outward signal is green. */
  const results = checkScanHealth({
    status: 200,
    body: JSON.stringify({ ok: true, db: "ok", ticket: "off", register: "on", ms: 12 }),
  });
  const warns = failedWith(results, WARN);
  assert.equal(warns.length, 1);
  assert.match(warns[0].note, /SCAN_TICKET_SECRET is missing/);
});

test("scan health: a dead database PAGES", () => {
  const results = checkScanHealth({
    status: 503,
    body: JSON.stringify({ ok: false, db: "error", ticket: "enforce", register: "on", ms: 20 }),
  });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /not reachable/i);
});

/* ------------------------------------------------------------------------ *
 * 5. Sitemap
 * ------------------------------------------------------------------------ */

test("sitemap: the real shape passes at its floor", () => {
  assert.equal(failures(checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 44 })).length, 0);
});

test("sitemap: pages DISAPPEARING fails, and growth does not", () => {
  const shrunk = GOOD_SITEMAP.replace(/<loc>https:\/\/standpoint\.ch\/page-4[0-3]\/<\/loc>/g, "");
  assert.ok(failedWith(checkSitemap({ status: 200, body: shrunk }, { floor: 44 }), PAGE).length > 0);

  const grown = GOOD_SITEMAP.replace("</urlset>", "<loc>https://standpoint.ch/new-page/</loc></urlset>");
  assert.equal(failures(checkSitemap({ status: 200, body: grown }, { floor: 44 })).length, 0, "adding a page must not turn the probe red");
});

/*
 * ⚠⚠ THE DRIFT WARNING — the check on the check, added 2026-08-20 after
 * "remember to raise the floor" failed twice in one day.
 *
 * The floor sat at 44 for four days against a real count of 69, then the
 * corrected 69 was stale within the hour when 25 French pages landed. Both were
 * found by accident. Nothing was measuring the gap between the floor and
 * reality — which IS the check's blind side.
 */

test("⚠ sitemap: DRIFT above the floor WARNS, naming how many pages could vanish unnoticed", () => {
  const results = checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 20 });
  const warns = failedWith(results, WARN);
  assert.equal(warns.length, 1, "a 24-page gap must be reported");
  assert.match(warns[0].note, /drifted/i);
  assert.ok(warns[0].note.includes("44"), "it must name the number to raise the floor TO");
  assert.ok(warns[0].observed.includes("24"), `the size of the blind spot is the finding: ${warns[0].observed}`);
});

test("⚠ sitemap: drift is a WARNING, NEVER a page failure", () => {
  /*
   * Publishing pages is normal and good, and nothing is broken for a visitor.
   * A page-level failure here would fire after ordinary work, get muted, and
   * take the real "pages have disappeared" signal down with it.
   */
  const results = checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 20 });
  assert.equal(failedWith(results, PAGE).length, 0, "drift must never page");
});

test("sitemap: ordinary publishing does NOT warn — the slack exists so this is not noise", () => {
  /*
   * At zero slack this fires the day after every publication and becomes
   * indistinguishable from noise, which is how a warning stops being read.
   */
  assert.equal(failures(checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 44 })).length, 0, "exactly at the floor");
  assert.equal(failures(checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 38 })).length, 0, "six new pages is not yet a finding");
  assert.equal(failures(checkSitemap({ status: 200, body: GOOD_SITEMAP }, { floor: 34 })).length, 0, "ten is the boundary, still quiet");
});

test("sitemap: LOSING pages still pages, and drift never masks it", () => {
  /*
   * The two conditions are opposite in direction and must not interfere: a
   * sitemap cannot be simultaneously below its floor and drifting above it.
   */
  const shrunk = GOOD_SITEMAP.replace(/<loc>https:\/\/standpoint\.ch\/page-4[0-3]\/<\/loc>/g, "");
  const results = checkSitemap({ status: 200, body: shrunk }, { floor: 44 });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.equal(failedWith(results, WARN).length, 0, "a shrinking sitemap must not also report drift");
});

test("sitemap: a sitemap full of staging URLs fails even though robots.txt would be clean", () => {
  /*
   * The "a check that reads the file NAMING a thing has not read the thing"
   * case. robots.txt can correctly point at https://standpoint.ch/sitemap.xml
   * while that sitemap hands Google 44 staging hostnames.
   */
  const staging = GOOD_SITEMAP.replaceAll("https://standpoint.ch/", "https://new.standpoint.ch/");
  const notes = failedWith(checkSitemap({ status: 200, body: staging }, { floor: 44 }), PAGE).map((f) => f.note).join(" | ");
  assert.match(notes, /not on the live origin/i);
});

/* ------------------------------------------------------------------------ *
 * 6. Hidden pages — failing in BOTH directions
 * ------------------------------------------------------------------------ */

test("hidden page: reachable and unlisted passes", () => {
  const results = checkHiddenPage({ status: 200 }, { sitemapUrls: SITEMAP_URLS, url: "https://standpoint.ch/setup-a-session/" });
  assert.equal(failures(results).length, 0);
});

test("hidden page: a DELETED unlisted page fails — the direction a listing check misses", () => {
  /*
   * ⚠ This is why the check is two-directional. A rule that only asked "is it
   * absent from the sitemap?" would pass with flying colours on a page that no
   * longer exists — and the people who notice are clients John personally sent
   * the link to, who mostly just say nothing.
   */
  const results = checkHiddenPage({ status: 404 }, { sitemapUrls: SITEMAP_URLS, url: "https://standpoint.ch/setup-a-session/" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /not reachable/i);
});

test("hidden page: one that has appeared in the sitemap warns", () => {
  const results = checkHiddenPage(
    { status: 200 },
    { sitemapUrls: [...SITEMAP_URLS, "https://standpoint.ch/setup-a-session/"], url: "https://standpoint.ch/setup-a-session/" },
  );
  assert.equal(failedWith(results, WARN).length, 1);
  assert.match(results[0].note, /no longer unlisted/i);
});

/* ------------------------------------------------------------------------ *
 * chartingyourretirementjourney.com — added 2026-08-24 [claim-3c4e]
 *
 * ⚠ The GOOD fixture is shaped from the bytes that site served on 2026-08-21,
 * the day it went live: canonical on the bare domain, index/follow, and — the
 * two that matter here — NO `wp-content` and NO preview host anywhere.
 * ------------------------------------------------------------------------ */

const GOOD_CYRJ_HOME =
  `<!DOCTYPE html><html lang="en"><head>` +
  `<link rel="canonical" href="https://chartingyourretirementjourney.com/">` +
  `<meta name="robots" content="index, follow">` +
  `</head><body>` +
  "x".repeat(20_000) +
  `</body></html>`;

/* A real PDF opens with these four bytes. Everything after is padding. */
const GOOD_WORKSHEET = "%PDF-1.4\n" + "%".repeat(20_000);

test("cyrj home: the live build passes", () => {
  const results = checkCyrjHome({ status: 200, body: GOOD_CYRJ_HOME });
  assert.equal(failures(results).length, 0, "the bytes served on launch day must not trip the check");
});

test("cyrj home: a NON-200 pages immediately", () => {
  const results = checkCyrjHome({ status: 503, body: "" });
  assert.equal(failedWith(results, PAGE).length, 1);
});

test("cyrj home: a 200 with a stub body is caught — the failure that looks like health", () => {
  const results = checkCyrjHome({ status: 200, body: GOOD_CYRJ_HOME.slice(0, 400) });
  assert.ok(failures(results).some((r) => /implausibly small/i.test(r.note)));
});

/*
 * ⚠ THE ONE THAT ACTUALLY HAPPENED. On 2026-08-21 `npm run deploy:staging` was
 * run after the domain had been repointed, and the live site served a noindex
 * build that rendered perfectly. Three written warnings had not prevented it.
 */
test("cyrj home: A STAGING BUILD PUBLISHED OVER PRODUCTION fails on every marker", () => {
  const staging =
    `<!DOCTYPE html><html lang="en"><head>` +
    `<link rel="canonical" href="https://new.chartingyourretirementjourney.com/">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `</head><body>` +
    "x".repeat(20_000) +
    `</body></html>`;
  const results = checkCyrjHome({ status: 200, body: staging });
  const notes = failures(results).map((r) => r.note).join(" | ");
  assert.match(notes, /canonical/i);
  assert.match(notes, /new\.chartingyourretirementjourney\.com/);
  assert.match(notes, /index, follow/i);
  assert.match(notes, /noindex/i);
  assert.ok(failedWith(results, PAGE).length >= 4, "a staging build must trip more than one marker");
});

/* The WordPress rollback, or an asset reverted to the preview host. Both
   answer 200 on every page and look entirely normal to a human. */
test("cyrj home: wp-content coming back is caught", () => {
  const results = checkCyrjHome({ status: 200, body: GOOD_CYRJ_HOME.replace("<body>", `<body><img src="/wp-content/uploads/x.png">`) });
  assert.ok(failures(results).some((r) => /wp-content/i.test(r.note)));
});

test("cyrj home: the Infomaniak PREVIEW host coming back is caught", () => {
  const results = checkCyrjHome({ status: 200, body: GOOD_CYRJ_HOME.replace("<body>", `<body><img src="https://ut6on4bvzlz.preview.infomaniak.website/x.png">`) });
  assert.ok(failures(results).some((r) => /preview host/i.test(r.note)));
});

test("cyrj worksheet: a real PDF passes", () => {
  const results = checkCyrjWorksheet({ status: 200, body: GOOD_WORKSHEET });
  assert.equal(failures(results).length, 0);
});

test("cyrj worksheet: a 404 page under a .pdf name is caught — 200, and not a PDF", () => {
  const results = checkCyrjWorksheet({ status: 200, body: "<!DOCTYPE html><title>404 Not Found</title>" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /not a PDF/i);
});

test("cyrj worksheet: a TRUNCATED upload still opens with %PDF and is still caught", () => {
  const results = checkCyrjWorksheet({ status: 200, body: "%PDF-1.4\n" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /implausibly small/i);
});

test("cyrj worksheet: a non-200 pages — the printed QR codes lead here", () => {
  const results = checkCyrjWorksheet({ status: 404, body: "" });
  assert.equal(failedWith(results, PAGE).length, 1);
  assert.match(results[0].note, /QR codes/i);
});

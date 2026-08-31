/*
 * report.test.mjs — proves the SEVERITY-TO-EXIT-CODE mapping, which is the
 * part of this repository that would fail most quietly if it were wrong.
 *
 * ⚠ WHY THIS DESERVES ITS OWN FILE.
 *
 * checks.test.mjs proves each assertion can go red. It says nothing about what
 * happens next. If `report` returned 0 on a page failure — a single inverted
 * comparison — every check could be working perfectly and every workflow run
 * would still be green. The probe would look immaculate and monitor nothing,
 * and it is difficult to think of a failure mode better disguised than a
 * monitoring repository whose runs are all passing.
 *
 * The exit code is the entire product. Everything else is console output that
 * nobody reads on a green run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PAGE, WARN } from "./checks.mjs";
import {
  alertBody,
  alertPingAccepted,
  annotation,
  deadmanEnvName,
  report,
  resolveDeadmanUrl,
} from "./probe.mjs";

/* Quieten the reporter; these tests are about the return value, not the prose. */
const silence = () => {
  const log = console.log;
  console.log = () => {};
  return () => {
    console.log = log;
  };
};

/*
 * The annotation tests are about the prose, so they capture it instead of
 * discarding it. Same override, opposite intent.
 */
const capture = () => {
  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.log = log;
    },
  };
};

const outcome = (results, severities) => ({
  results,
  timings: [{ key: "home", ms: 12, attempts: 1, status: 200 }],
  allowed: new Set(severities),
});

const pass = { id: "home", severity: PAGE, ok: true, note: "fine" };
const pageFail = { id: "home", severity: PAGE, ok: false, note: "broken", observed: "HTTP 503" };
const warnFail = { id: "scan-health", severity: WARN, ok: false, note: "drifted", observed: "ticket=off" };

test("a clean run exits 0", () => {
  const restore = silence();
  assert.equal(report(outcome([pass], [PAGE, WARN]), "daily"), 0);
  restore();
});

test("a page failure exits 1", () => {
  const restore = silence();
  assert.equal(report(outcome([pageFail], [PAGE, WARN]), "fast"), 1);
  restore();
});

test("warnings alone exit 2 — non-zero, so the run still goes RED", () => {
  /*
   * ⚠ The assertion that matters is `!== 0`. A warning that exited 0 would
   * reach a log and nobody else, which is precisely the shape the audit
   * registry failed into for nineteen days: non-blocking, correct, reported
   * to one line of chat and then nowhere.
   */
  const restore = silence();
  const code = report(outcome([warnFail], [PAGE, WARN]), "daily");
  restore();
  assert.equal(code, 2);
  assert.notEqual(code, 0, "a warning must never leave a run green");
});

test("a page failure outranks a warning", () => {
  const restore = silence();
  assert.equal(report(outcome([pageFail, warnFail], [PAGE, WARN]), "daily"), 1);
  restore();
});

test("THE FAST SUITE FILTERS WARNINGS OUT — this is the cadence rule, and it is easy to invert", () => {
  /*
   * The whole warn tier depends on this one line of filtering. If it broke,
   * `ticket: off` would page every fifteen minutes, the alert would be muted
   * within a day, and the muting would then hide the page-level checks too.
   * The failure would present as "the monitor is too noisy", never as a bug.
   */
  const restore = silence();
  assert.equal(report(outcome([pass, warnFail], [PAGE]), "fast"), 0, "fast must stay green on a warning");
  assert.equal(report(outcome([pass, warnFail], [PAGE, WARN]), "daily"), 2, "daily must go red on the same warning");
  restore();
});

/* ------------------------------------------------------------------------ *
 * Annotations — the part of a failure that actually reaches a human
 * ------------------------------------------------------------------------ */

/*
 * ⚠ WHY THESE EXIST. The alert mail said "All jobs have failed" and "Failed in
 * 7 seconds" while `Sitemap has LOST pages — 44 URLs, floor is 9999` sat one
 * click away in the run log. The annotation is the only route by which the
 * observed value reaches the notification, so the assertion that matters in
 * every test below is THE OBSERVED VALUE IS IN THE STRING. A well-formed
 * annotation carrying "check failed" would pass a shape test and be worthless.
 */

test("a PAGE failure produces an ::error:: annotation CARRYING THE OBSERVED VALUE", () => {
  const line = annotation(pageFail, "fast");
  assert.match(line, /^::error /, "PAGE must be an error, which is what GitHub surfaces in the mail");
  assert.ok(line.includes("HTTP 503"), `the observed value is missing from: ${line}`);
  assert.ok(line.includes("broken"), "the expectation should travel with the observation");
  assert.ok(line.includes("home"), "the check id names which assertion fired");
});

test("a WARN failure produces an ::warning:: annotation, not an error", () => {
  /*
   * A warning that annotated as an error would put a red mark on the daily run
   * for `ticket: off`, which is a config state John may have chosen. The
   * severity distinction is the whole reason the warn tier exists.
   */
  const line = annotation(warnFail, "daily");
  assert.match(line, /^::warning /);
  assert.ok(line.includes("ticket=off"));
});

test("⚠ NEWLINES ARE ESCAPED — an unescaped one truncates the annotation at exactly the observed value", () => {
  /*
   * This is the failure mode that would be invisible: the annotation appears,
   * looks right in the log, and the mail shows only the first line — dropping
   * the part this whole change exists to deliver.
   */
  const line = annotation(
    { id: "x", severity: PAGE, ok: false, note: "first line", observed: "second\nthird" },
    "weekly",
  );
  assert.ok(!line.includes("\n"), "an annotation must be exactly one line");
  assert.ok(line.includes("%0A"), "newlines must survive as %0A, not vanish");
  assert.ok(line.includes("third"), "the text after the newline must still be there");
});

test("a percent sign is escaped first, so it cannot corrupt the other escapes", () => {
  const line = annotation(
    { id: "x", severity: PAGE, ok: false, note: "n", observed: "100% CPU" },
    "fast",
  );
  assert.ok(line.includes("100%25 CPU"), `percent not escaped: ${line}`);
});

test("a colon or comma in the title is escaped — they are the property delimiters", () => {
  /*
   * `::error title=a,b::msg` parses `b` as a second property and loses it. The
   * id is interpolated into the title, so an id containing a comma would
   * silently mangle the annotation rather than fail.
   */
  const line = annotation(
    { id: "scan:health,ticket", severity: PAGE, ok: false, note: "n", observed: "o" },
    "fast",
  );
  const [properties] = line.slice("::error ".length).split("::");
  assert.ok(!properties.includes(","), `unescaped comma in properties: ${properties}`);
  assert.ok(!properties.includes(":"), `unescaped colon in properties: ${properties}`);
  assert.ok(properties.includes("%2C") && properties.includes("%3A"));
});

test("⚠ A MISSING observed VALUE IS NAMED, never rendered as the word 'undefined'", () => {
  /*
   * A check that failed without recording what it saw is a defect in that
   * check. Printing "observed: undefined" into an alert reads like a value and
   * teaches the reader to distrust the field. Say what happened instead.
   */
  const line = annotation({ id: "x", severity: PAGE, ok: false, note: "n" }, "fast");
  assert.ok(!line.includes("undefined"), `annotation rendered undefined: ${line}`);
  assert.ok(line.includes("NOT RECORDED"));
});

test("report() emits one annotation per failure and NONE on a clean run", () => {
  const clean = capture();
  report(outcome([pass], [PAGE, WARN]), "daily");
  clean.restore();
  assert.equal(
    clean.lines.filter((l) => l.startsWith("::")).length,
    0,
    "a green run must not put a red mark on a passing job",
  );

  const dirty = capture();
  report(outcome([pass, pageFail, warnFail], [PAGE, WARN]), "daily");
  dirty.restore();
  const emitted = dirty.lines.filter((l) => l.startsWith("::"));
  assert.equal(emitted.length, 2, `expected one per failure, got: ${JSON.stringify(emitted)}`);
  assert.ok(emitted.some((l) => l.includes("HTTP 503")));
  assert.ok(emitted.some((l) => l.includes("ticket=off")));
});

test("⚠ THE FAST SUITE DOES NOT ANNOTATE A WARNING IT DELIBERATELY IGNORES", () => {
  /*
   * The cadence rule lives in the exit code. If annotations bypassed the
   * severity filter, `ticket: off` would put a red annotation on every fast run
   * — defeating that rule through the mail instead of through the exit code,
   * and getting the alert muted just the same.
   */
  const captured = capture();
  const code = report(outcome([pass, warnFail], [PAGE]), "fast");
  captured.restore();
  assert.equal(code, 0);
  assert.equal(captured.lines.filter((l) => l.startsWith("::")).length, 0);
});

test("the transport-layer notice is annotated FIRST, so it frames the failures under it", () => {
  /*
   * Six red hosts is a convincing picture of a catastrophe and was wrong the
   * one time it happened — the runner simply had no egress. If that line is not
   * first in the mail, the reader starts on the wrong system.
   */
  const captured = capture();
  report(
    {
      results: [pageFail],
      timings: [
        { key: "home", ms: 0, attempts: 3, status: 0 },
        { key: "scanHealth", ms: 0, attempts: 3, status: 0 },
      ],
      allowed: new Set([PAGE, WARN]),
    },
    "fast",
  );
  captured.restore();
  const emitted = captured.lines.filter((l) => l.startsWith("::"));
  assert.ok(emitted[0].includes("probe-egress"), `egress notice not first: ${JSON.stringify(emitted)}`);
  assert.ok(emitted[0].includes("2 of 2"));
});

/* ------------------------------------------------------------------------ *
 * The healthchecks body — the ONE path measured to reach an inbox
 * ------------------------------------------------------------------------ */

/*
 * ⚠ GitHub's mail carries a COUNT of annotations. healthchecks.io's mail
 * carries the POST body verbatim, under a "Last Ping Body" heading — measured
 * 2026-08-20 against a throwaway check, because the docs never promise it.
 *
 * So this string is the alert. Not a log line that might be read; the text that
 * lands on a phone. Everything below asserts on its CONTENT.
 */

test("the alert body carries every failure WITH ITS OBSERVED VALUE", () => {
  const body = alertBody(outcome([pass, pageFail, warnFail], [PAGE, WARN]), "daily", {});
  assert.ok(body.includes("HTTP 503"), `page failure's observed value missing:\n${body}`);
  assert.ok(body.includes("ticket=off"), `warning's observed value missing:\n${body}`);
  assert.ok(body.includes("broken") && body.includes("drifted"), "the expectations must travel too");
  assert.ok(body.includes("daily"), "the suite name says which cadence found it");
});

test("the alert body does NOT carry passing checks — an alert is not a report", () => {
  /*
   * A body that lists everything makes the reader hunt for the red line on a
   * phone at night. The log is where the full picture lives.
   */
  const body = alertBody(outcome([pass, pageFail], [PAGE, WARN]), "fast", {});
  assert.ok(!body.includes("fine"), `passing check leaked into the alert:\n${body}`);
});

test("⚠ the alert body respects the SEVERITY FILTER, like the exit code and the annotations", () => {
  /*
   * Third place the same rule has to hold. If it were missed here, `ticket: off`
   * would mail through healthchecks on every fast run — muted within a day,
   * taking the page-level alerts with it.
   */
  const body = alertBody(outcome([pass, warnFail], [PAGE]), "fast", {});
  assert.ok(!body.includes("ticket=off"), `fast suite leaked an ignored warning:\n${body}`);
  assert.match(body, /0 failure\(s\)/);
});

test("a missing observed value is named in the alert body too, not printed as 'undefined'", () => {
  const body = alertBody(
    outcome([{ id: "x", severity: PAGE, ok: false, note: "n" }], [PAGE, WARN]),
    "fast",
    {},
  );
  assert.ok(!body.includes("undefined"), `alert body rendered undefined:\n${body}`);
  assert.ok(body.includes("NOT RECORDED"));
});

test("the run URL is included when the environment has one, and OMITTED when it does not", () => {
  /*
   * One tap from the mail to the run. Built from the environment, never
   * invented: a local run has no run to link to, and a fabricated URL in an
   * alert is worse than no URL.
   */
  const withEnv = alertBody(outcome([pageFail], [PAGE, WARN]), "fast", {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "john-standpoint/standpoint-monitors",
    GITHUB_RUN_ID: "12345",
  });
  assert.ok(withEnv.includes("https://github.com/john-standpoint/standpoint-monitors/actions/runs/12345"));

  const withoutEnv = alertBody(outcome([pageFail], [PAGE, WARN]), "fast", {});
  assert.ok(!withoutEnv.includes("actions/runs"), `invented a run URL:\n${withoutEnv}`);
  assert.ok(!withoutEnv.includes("undefined"), "a partial environment must not produce a broken URL");
});

/* ------------------------------------------------------------------------ *
 * Was the ping accepted? — the rule that took all three suites down
 * ------------------------------------------------------------------------ */

/*
 * ⚠ THE BUG THESE EXIST FOR, RECORDED SO IT IS NOT REINTRODUCED BY SOMEONE
 * APPLYING THIS REPOSITORY'S OWN RULE.
 *
 * The first version required the body to start with "OK", reasoning from READ
 * THE BODY, NOT THE STATUS. Every suite went red on its first live run with
 * exit 3: the auto-provisioning ping that CREATES a check answers `HTTP 201
 * Created`, and the guard rejected the response that meant success.
 *
 * The principle describes `scan.standpoint.ch/api/health` and healthchecks'
 * UUID endpoints. It does not describe healthchecks' SLUG endpoints, which
 * return honest status codes. A check that fails a CORRECT response is worse
 * than no check: it teaches people to route around it.
 */

test("⚠ 201 Created is ACCEPTED — this is the auto-provisioning ping, and rejecting it broke everything", () => {
  assert.equal(alertPingAccepted(201, "Created"), true);
});

test("200 OK is accepted — the ordinary ping to a check that already exists", () => {
  assert.equal(alertPingAccepted(200, "OK"), true);
});

test("a 200 that says 'not found' is REJECTED — healthchecks lies with the status here", () => {
  /*
   * The UUID endpoints answer 200 for a check that does not exist. That case is
   * real and is why the original instinct was not silly — just misapplied.
   */
  assert.equal(alertPingAccepted(200, "OK (not found)"), false);
});

test("a rate-limited ping is REJECTED — it was accepted by the server and then ignored", () => {
  assert.equal(alertPingAccepted(200, "OK (rate limited)"), false);
});

test("404, 409 and 400 are rejected, and each means something different", () => {
  assert.equal(alertPingAccepted(404, "not found"), false, "wrong ping key");
  assert.equal(alertPingAccepted(409, "ambiguous slug"), false, "the slug matches two checks");
  assert.equal(alertPingAccepted(400, "invalid url format"), false, "malformed slug");
});

test("a 500 is rejected, and an empty body does not accidentally pass", () => {
  assert.equal(alertPingAccepted(500, ""), false);
  assert.equal(alertPingAccepted(200, ""), true, "an empty body on a 200 is not a known lie");
  assert.equal(alertPingAccepted(undefined, undefined), false, "no status is not a success");
});

test("a partial GitHub environment produces NO url rather than a broken one", () => {
  const body = alertBody(outcome([pageFail], [PAGE, WARN]), "fast", {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "12345",
  });
  assert.ok(!body.includes("actions/runs"), `built a URL from an incomplete environment:\n${body}`);
});

/* ------------------------------------------------------------------------ *
 * The dead-man's switch resolver — added 2026-08-31
 *
 * ⚠⚠ THE TEST THAT MATTERS HERE IS THE NEGATIVE ONE. Giving `probe-daily` its
 * own switch is only safe if a suite can never reach ANOTHER suite's switch. A
 * generic fallback to the legacy DEADMAN_URL would reintroduce, as the fix, the
 * exact masking bug that kept --deadman off the daily suite in the first place:
 * a daily run keeping the FAST switch green while the fast probe was dead.
 *
 * ⚠ The resolver was extracted and exported specifically so this could be
 * proven. `pingDeadman` was never exported and therefore never tested — which
 * is how a single hardcoded env var survived unremarked until an outage.
 * ------------------------------------------------------------------------ */

test("the env var name is derived per suite, not hardcoded", () => {
  assert.equal(deadmanEnvName("fast"), "DEADMAN_URL_FAST");
  assert.equal(deadmanEnvName("daily"), "DEADMAN_URL_DAILY");
  assert.equal(deadmanEnvName("weekly"), "DEADMAN_URL_WEEKLY");
});

test("each suite resolves its OWN variable when set", () => {
  const env = { DEADMAN_URL_FAST: "https://hc/fast", DEADMAN_URL_DAILY: "https://hc/daily" };
  assert.equal(resolveDeadmanUrl("fast", env).url, "https://hc/fast");
  assert.equal(resolveDeadmanUrl("daily", env).url, "https://hc/daily");
});

test("the legacy DEADMAN_URL still works for the fast suite, so no secret has to be touched", () => {
  const got = resolveDeadmanUrl("fast", { DEADMAN_URL: "https://hc/legacy" });
  assert.equal(got.url, "https://hc/legacy");
  assert.equal(got.name, "DEADMAN_URL", "the reported name must be the one actually used");
});

test("⚠ the DAILY suite must NEVER fall back to the fast suite's legacy DEADMAN_URL", () => {
  const got = resolveDeadmanUrl("daily", { DEADMAN_URL: "https://hc/fast-switch" });
  assert.equal(
    got.url,
    undefined,
    "daily reached the fast suite's switch — this is the masking bug, and it would keep the " +
      "fast switch green while the fast probe was dead",
  );
  assert.equal(got.name, "DEADMAN_URL_DAILY", "the error must name the variable the operator should set");
});

test("⚠ no suite other than fast gets the legacy fallback either", () => {
  for (const suite of ["daily", "weekly"]) {
    assert.equal(
      resolveDeadmanUrl(suite, { DEADMAN_URL: "https://hc/fast-switch" }).url,
      undefined,
      `${suite} fell back to the shared legacy variable`,
    );
  }
});

test("a per-suite variable WINS over the legacy one rather than being shadowed by it", () => {
  const got = resolveDeadmanUrl("fast", {
    DEADMAN_URL_FAST: "https://hc/new",
    DEADMAN_URL: "https://hc/legacy",
  });
  assert.equal(got.url, "https://hc/new");
  assert.equal(got.name, "DEADMAN_URL_FAST");
});

test("an UNSET secret renders as an empty string, and empty must not count as configured", () => {
  /* GitHub interpolates a missing secret to "" rather than omitting the var —
   * so `in` and `!== undefined` are both wrong tests, and truthiness is right. */
  const got = resolveDeadmanUrl("fast", { DEADMAN_URL_FAST: "", DEADMAN_URL: "https://hc/legacy" });
  assert.equal(got.url, "https://hc/legacy", "an empty per-suite var blocked the working fallback");
});

test("nothing configured resolves to no url, so the caller can fail hard", () => {
  const got = resolveDeadmanUrl("daily", {});
  assert.equal(got.url, undefined);
  assert.equal(got.name, "DEADMAN_URL_DAILY");
});

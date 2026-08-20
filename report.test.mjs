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
import { annotation, report } from "./probe.mjs";

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

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
import { report } from "./probe.mjs";

/* Quieten the reporter; these tests are about the return value, not the prose. */
const silence = () => {
  const log = console.log;
  console.log = () => {};
  return () => {
    console.log = log;
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

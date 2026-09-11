/*
 * transport.test.mjs — proves that a transport failure NAMES ITS CAUSE, and
 * that one transport failure is re-checked before it is allowed to page.
 * Added 2026-09-11 [claim-e7a2].
 *
 * ⚠⚠ WHY THE FIRST HALF USES REAL ERRORS, NOT HAND-BUILT ONES.
 *
 * From 2026-08-16 to 2026-09-11 every transport failure this probe reported was
 * the literal string "fetch failed" — undici's wrapper — while the real reason
 * sat one level down in `error.cause`. The code carried a comment promising the
 * opposite and passed every test it had, because no test ever looked at what a
 * REAL failure produced. A test built only from hand-made error objects would
 * have the same blind spot: it proves the walker handles the shape its author
 * imagined. So the load-bearing tests below make this Node's own fetch fail —
 * refused, reset and timed out, all against 127.0.0.1, no outside network — and
 * assert on what comes back. If undici ever moves the cause again, these fail.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { checkAvailability, checkCyrjHome, checkCyrjWorksheet, checkHiddenPage, checkHomepage, checkNotFoundEn, checkRobots, checkScanHealth, checkSitemap, observedStatus } from "./checks.mjs";
import { clearBody, describeTransportError, fetchWithRetry, run } from "./probe.mjs";

/* ------------------------------------------------------------------------ *
 * Real failures from this Node's fetch
 * ------------------------------------------------------------------------ */

/* A port that was just open and is now closed: connecting to it is REFUSED. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withServer(onConnection, fn) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(server.address().port);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("⚠⚠ THE TRAP IS REAL: undici's own message for a refused connection is just 'fetch failed'", async () => {
  const port = await closedPort();
  const error = await fetch(`http://127.0.0.1:${port}/`).then(
    () => assert.fail("expected the fetch to fail"),
    (e) => e,
  );
  /* If this ever stops being true, undici changed — re-read describeTransportError. */
  assert.equal(error.message, "fetch failed");
  const described = describeTransportError(error);
  assert.notEqual(described.text, "fetch failed");
  assert.ok(!described.text.startsWith("fetch failed"), described.text);
  assert.ok(described.codes.includes("ECONNREFUSED"), described.text);
});

test("⚠⚠ a REAL refusal through fetchWithRetry names ECONNREFUSED, the class, and how fast it failed", async () => {
  const port = await closedPort();
  const r = await fetchWithRetry(`http://127.0.0.1:${port}/`, { attempts: 2, retryDelayMs: 0 });
  assert.equal(r.status, 0);
  assert.equal(r.transportClass, "REFUSED");
  assert.match(r.transportError, /^REFUSED \[[^\]]*ECONNREFUSED/);
  assert.match(r.transportError, /2 attempt\(s\), failed after \d+\/\d+ ms$/);
  assert.doesNotMatch(r.transportError, /^fetch failed/);
});

test("a REAL timeout is classed TIMEOUT, and its time-to-fail is the timeout, not 0", async () => {
  await withServer(
    () => {
      /* accept the connection, never answer */
    },
    async (port) => {
      const r = await fetchWithRetry(`http://127.0.0.1:${port}/`, { attempts: 1, retryDelayMs: 0, timeoutMs: 200 });
      assert.equal(r.status, 0);
      assert.equal(r.transportClass, "TIMEOUT", r.transportError);
      assert.ok(r.ms >= 150, `failed after ${r.ms} ms`);
    },
  );
});

test("a REAL reset (the host accepts, then drops the connection) is classed RESET", async () => {
  await withServer(
    (socket) => socket.destroy(),
    async (port) => {
      const r = await fetchWithRetry(`http://127.0.0.1:${port}/`, { attempts: 1, retryDelayMs: 0 });
      assert.equal(r.status, 0);
      assert.equal(r.transportClass, "RESET", r.transportError);
      assert.doesNotMatch(r.transportError, /^fetch failed/);
    },
  );
});

/* ------------------------------------------------------------------------ *
 * Shapes that cannot be produced against 127.0.0.1 — hand-built, and labelled so
 * ------------------------------------------------------------------------ */

const fetchFailed = (cause) => new TypeError("fetch failed", { cause });
const coded = (message, code) => Object.assign(new Error(message), { code });

test("DNS failure is classed DNS and blames the zone, not the host", () => {
  const d = describeTransportError(fetchFailed(coded("getaddrinfo ENOTFOUND standpoint.ch", "ENOTFOUND")));
  assert.equal(d.klass, "DNS");
  assert.match(d.text, /ENOTFOUND/);
  assert.match(d.text, /DNS zone/);
});

test("⚠ happy-eyeballs: v4 REFUSED + v6 UNREACHABLE is a REFUSAL — the runner's missing IPv6 must not be blamed", () => {
  const aggregate = new AggregateError(
    [coded("connect ENETUNREACH 2001:1600:0:aaaa::80:52:443", "ENETUNREACH"), coded("connect ECONNREFUSED 185.125.27.166:443", "ECONNREFUSED")],
    "",
  );
  const d = describeTransportError(fetchFailed(aggregate));
  assert.equal(d.klass, "REFUSED");
  assert.deepEqual([...d.codes].sort(), ["ECONNREFUSED", "ENETUNREACH"]);
});

test("an expired certificate is classed TLS", () => {
  assert.equal(describeTransportError(fetchFailed(coded("certificate has expired", "CERT_HAS_EXPIRED"))).klass, "TLS");
});

test("an AbortSignal timeout (numeric DOMException code 23) is classed by its NAME", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const d = describeTransportError(timeout);
  assert.equal(d.klass, "TIMEOUT");
  assert.ok(!d.codes.includes(23));
});

test("a cyclic cause chain terminates", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.doesNotThrow(() => describeTransportError(fetchFailed(a)));
});

test("⚠ no cause at all says NO CAUSE — it never collapses back into the bare 'fetch failed'", () => {
  const d = describeTransportError(new TypeError("fetch failed"));
  assert.equal(d.klass, "NO CAUSE");
  assert.notEqual(d.text, "fetch failed");
});

test("an unknown code is kept verbatim and named UNCLASSIFIED, never dropped", () => {
  const d = describeTransportError(fetchFailed(coded("something new", "UND_ERR_SOMETHING_NEW")));
  assert.equal(d.klass, "UNCLASSIFIED");
  assert.match(d.text, /UND_ERR_SOMETHING_NEW/);
});

/* ------------------------------------------------------------------------ *
 * The cause reaches `observed` — at every site, not just the one I remembered
 * ------------------------------------------------------------------------ */

const DEAD = { status: 0, body: "", transportError: "REFUSED [ECONNREFUSED] connect ECONNREFUSED 185.125.27.166:443" };

test("observedStatus carries a transport cause, and leaves a real HTTP status alone", () => {
  assert.equal(observedStatus(DEAD), `transport failure — ${DEAD.transportError}`);
  assert.equal(observedStatus({ status: 503 }), "HTTP 503");
  assert.equal(observedStatus({ status: 0 }), "HTTP 0");
});

test("⚠ EVERY single-URL check carries the cause into observed — none still says 'HTTP 0'", () => {
  const sites = {
    home: checkHomepage(DEAD),
    robots: checkRobots(DEAD),
    availability: checkAvailability(DEAD),
    scanHealth: checkScanHealth(DEAD),
    sitemap: checkSitemap(DEAD, { floor: 1 }),
    hidden: checkHiddenPage(DEAD, { sitemapUrls: [], url: "https://standpoint.ch/x/" }),
    cyrjHome: checkCyrjHome(DEAD),
    cyrjWorksheet: checkCyrjWorksheet(DEAD),
    notFoundEn: checkNotFoundEn(DEAD, { url: "https://standpoint.ch/_monitor-404-probe/" }),
  };
  for (const [name, results] of Object.entries(sites)) {
    const failures = results.filter((r) => !r.ok);
    assert.ok(failures.length > 0, `${name} did not fail on a dead target`);
    assert.ok(
      failures.some((f) => String(f.observed).includes("ECONNREFUSED")),
      `${name} lost the cause: ${failures.map((f) => f.observed).join(" / ")}`,
    );
    assert.ok(!failures.some((f) => f.observed === "HTTP 0"), `${name} still says HTTP 0`);
  }
});

/* ------------------------------------------------------------------------ *
 * The re-check
 * ------------------------------------------------------------------------ */

const HOME = "https://standpoint.ch/";
const OK = { status: 200, body: "", ms: 5, attempts: 1 };
const REFUSED = (n = 3) => ({ status: 0, body: "", ms: 1, attempts: n, transportError: "REFUSED [ECONNREFUSED] connect ECONNREFUSED 185.125.27.166:443" });

/* A fetch that answers from a per-URL script, and records every call. */
function scripted(script) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const queue = script[url];
    if (Array.isArray(queue) && queue.length) return queue.shift();
    return OK;
  };
  return { fetchImpl, calls };
}

function sleeper() {
  const slept = [];
  return { sleepImpl: async (ms) => slept.push(ms), slept };
}

const quiet = () => {};
const homeResults = (outcome) => outcome.results.filter((r) => r.id === "home");

test("⚠⚠ a BLIP is absorbed: refused once, answering a minute later → no transport failure reported", async () => {
  const { fetchImpl, calls } = scripted({ [HOME]: [REFUSED(), OK] });
  const { sleepImpl, slept } = sleeper();
  const outcome = await run("fast", { fetchImpl, sleepImpl, log: quiet });

  assert.deepEqual(slept, [60_000], "the re-check waits one minute, once");
  assert.equal(outcome.recovered.length, 1);
  assert.equal(outcome.recovered[0].key, "home");
  assert.match(outcome.recovered[0].firstError, /ECONNREFUSED/);
  assert.ok(!homeResults(outcome).some((r) => String(r.observed).startsWith("transport failure")));

  const homeCalls = calls.filter((c) => c.url === HOME);
  assert.equal(homeCalls.length, 2);
  assert.equal(homeCalls[1].options.attempts, 1, "the re-check is ONE attempt, which is what bounds the job time");
});

test("⚠ the re-check re-fetches ONLY what failed — every good answer is reused, not fetched twice", async () => {
  const { fetchImpl, calls } = scripted({ [HOME]: [REFUSED(), OK] });
  const { sleepImpl } = sleeper();
  await run("fast", { fetchImpl, sleepImpl, log: quiet });
  const others = calls.filter((c) => c.url !== HOME);
  assert.equal(others.length, 3, `expected availability, scanHealth, cyrjHome once each, got ${others.map((c) => c.url)}`);
});

test("⚠⚠ a REAL outage still pages — and observed carries BOTH failures", async () => {
  const { fetchImpl } = scripted({ [HOME]: [REFUSED(), REFUSED(1)] });
  const { sleepImpl } = sleeper();
  const outcome = await run("fast", { fetchImpl, sleepImpl, log: quiet });

  assert.equal(outcome.recovered.length, 0);
  const failure = homeResults(outcome).find((r) => !r.ok);
  assert.ok(failure, "home must still fail");
  assert.match(failure.observed, /^transport failure — REFUSED/);
  assert.match(failure.observed, /and 60 s earlier: REFUSED/);
  assert.equal((failure.observed.match(/the host refused/g) ?? []).length, 0, "canned errors carry no hint; real ones carry it once");
});

test("a clean run never sleeps — the re-check costs nothing on a healthy day", async () => {
  const { fetchImpl } = scripted({});
  const { sleepImpl, slept } = sleeper();
  const outcome = await run("fast", { fetchImpl, sleepImpl, log: quiet });
  assert.deepEqual(slept, []);
  assert.deepEqual(outcome.recovered, []);
});

test("⚠ an HTTP error is an ANSWER, not a transport failure — it is NOT re-checked and NOT delayed", async () => {
  const { fetchImpl, calls } = scripted({ [HOME]: [{ status: 503, body: "", ms: 5, attempts: 1 }] });
  const { sleepImpl, slept } = sleeper();
  const outcome = await run("fast", { fetchImpl, sleepImpl, log: quiet });
  assert.deepEqual(slept, []);
  assert.equal(calls.filter((c) => c.url === HOME).length, 1);
  assert.equal(homeResults(outcome).find((r) => !r.ok)?.observed, "HTTP 503");
});

test("the re-check covers the redirect loop too, keyed by redirect mode — not only single-URL checks", async () => {
  const redirected = "https://standpoint.ch/storybuilding-book";
  let firstManual = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === redirected && options.follow === false && firstManual) {
      firstManual = false;
      return REFUSED();
    }
    return OK;
  };
  const { sleepImpl, slept } = sleeper();
  const outcome = await run("daily", { fetchImpl, sleepImpl, log: quiet });
  assert.deepEqual(slept, [60_000]);
  assert.ok(outcome.recovered.some((r) => r.url === redirected), JSON.stringify(outcome.recovered));
});

test("the CLEAR ping body is empty on an ordinary run and names each blip otherwise", () => {
  assert.equal(clearBody({ recovered: [] }, "fast"), "");
  assert.equal(clearBody({}, "fast"), "");
  const body = clearBody({ recovered: [{ key: "home", status: 200, firstError: "REFUSED [ECONNREFUSED] x" }] }, "fast");
  assert.match(body, /clean, after 1 re-check/);
  assert.match(body, /RECOVERED {2}home: answered HTTP 200/);
  assert.match(body, /first pass: REFUSED \[ECONNREFUSED\]/);
});

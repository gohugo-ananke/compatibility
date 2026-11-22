import assert from "node:assert/strict";
import test from "node:test";
import { recordSnapshot, renderTable, validateFacts, type Snapshot } from "../../scripts/compatibility/facts.ts";
import { resultSchema } from "../../scripts/compatibility/model.ts";

const snapshot: Snapshot = {
  discoveredAt: "2026-11-21T00:00:00Z", latestStableHugo: "v0.170.1", platform: "linux/amd64", profiles: ["baseline"],
  releases: [{ tag: "v2.22.0", commit: "commit", releasedAt: null, declaredHugoMinimum: "0.160.0", requirements: [], extendedDeclared: false,
    historicalExample: false, shippedFixture: false, outcomes: [{ edition: "standard", compatibilityIntervals: [{ minimum: "v0.170.1", maximum: "v0.170.1", latestTested: true }],
      maximumIsConfirmed: false, testedHugoMinimum: "v0.170.1", testedHugoMaximum: "v0.170.1", counts: { PASS: 1 }, versions: { "v0.170.1": "PASS" }, evidence: {} }] }],
};
const result = resultSchema.parse({ schemaVersion: 1, key: "input", anankeVersion: "v2.22.0", anankeCommit: "commit", hugoVersion: "v0.170.1",
  edition: "standard", fixture: "baseline", status: "PASS", reason: "Built", testedAt: "2026-11-21T00:00:00Z", durationMs: 1, exitCode: 0,
  warnings: [], errors: [], warningCount: 0, errorCount: 0, binary: "/binary", binarySha256: "binary", versionOutput: "hugo version", runnerRevision: "runner",
  fixtureRevision: "fixture", command: [], logs: "runs/example", outputs: [] });

test("targeted updates preserve earlier evidence and leave new versions untested", () => {
  const prior = recordSnapshot(undefined, snapshot, [result], "test", "first", "v24");
  const next = structuredClone(snapshot);
  next.latestStableHugo = "v0.171.0";
  next.releases[0]!.outcomes[0]!.versions = { "v0.170.1": "NOT_TESTED", "v0.171.0": "NOT_TESTED" };
  next.releases.push({ ...structuredClone(next.releases[0]!), tag: "v2.23.0", commit: "new" });
  const fresh = { ...result, key: "new-input", anankeVersion: "v2.23.0", anankeCommit: "new", hugoVersion: "v0.171.0", testedAt: "2026-11-22T00:00:00Z" };
  next.releases[1]!.outcomes[0]!.versions["v0.171.0"] = "PASS";
  const merged = recordSnapshot(prior, next, [fresh], "test", "second", "v24");
  const old = merged.snapshot.releases.find(release => release.tag === "v2.22.0")!.outcomes[0]!;
  assert.equal(old.versions["v0.170.1"], "PASS");
  assert.equal(old.versions["v0.171.0"], "NOT_TESTED");
  assert.equal(old.evidence["v0.170.1"], "first");
  assert.equal(old.compatibilityIntervals[0]!.latestTested, false);
});

test("facts cannot claim an interval through a failed patch", () => {
  const facts = recordSnapshot(undefined, snapshot, [result], "test", "first", "v24");
  facts.snapshot.releases[0]!.outcomes[0]!.versions["v0.170.1"] = "FAIL";
  assert.throws(() => validateFacts(facts), /Invalid intervals/);
});

test("a release commit cannot change silently", () => {
  const facts = recordSnapshot(undefined, snapshot, [result], "test", "first", "v24");
  const changed = structuredClone(snapshot);
  changed.releases[0]!.commit = "different";
  assert.throws(() => recordSnapshot(facts, changed, [result], "test", "second", "v24"), /commit changed/);
});

test("the table shows one row per release across editions", () => {
  const facts = recordSnapshot(undefined, snapshot, [result], "test", "first", "v24");
  const release = facts.snapshot.releases[0]!;
  const versions = { "v0.169.0": "PASS", "v0.170.0": "NOT_APPLICABLE", "v0.170.1": "NOT_APPLICABLE" } as const;
  release.outcomes.push({ ...structuredClone(release.outcomes[0]!), edition: "extended", versions: { ...versions },
    evidence: { "v0.169.0": "first", "v0.170.0": "first", "v0.170.1": "first" } });
  release.outcomes[0]!.versions = { "v0.169.0": "FAIL", "v0.170.0": "PASS", "v0.170.1": "PASS" };
  release.outcomes[0]!.evidence = { "v0.169.0": "first", "v0.170.0": "first", "v0.170.1": "first" };
  const [table, footnotes] = renderTable(facts).split("\n\n");
  const rows = table!.split("\n").slice(2);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /\| v0\.169\.0 \| v0\.170\.1 \(latest tested\) \| \[1\] \[2\] \|$/);
  assert.match(footnotes!, /<p><sup>1<\/sup> Declared minimum Hugo version: 0\.160\.0\.<\/p>\n<p><sup>2<\/sup> Requires Hugo Extended for v0\.169\.0\.<\/p>/);
});

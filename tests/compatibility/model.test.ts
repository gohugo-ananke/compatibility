import assert from "node:assert/strict";
import test from "node:test";
import { classify, compareVersions, intervals, resultSchema, verifiedDownload } from "../../scripts/compatibility/model.ts";

test("patch versions sort numerically", () => {
  assert.ok(compareVersions("v0.128.10", "0.128.9") > 0);
});
test("unknown releases and failures break intervals; recoveries remain visible", () => {
  const versions = ["v0.128.0", "v0.128.1", "v0.129.0", "v0.130.0", "v0.131.0"];
  assert.deepEqual(intervals(versions, new Map([
    [versions[0]!, "PASS"], [versions[1]!, "PASS_WITH_WARNINGS"],
    [versions[2]!, "FAIL"], [versions[4]!, "PASS"],
  ])), [
    { minimum: "v0.128.0", maximum: "v0.128.1", latestTested: false },
    { minimum: "v0.131.0", maximum: "v0.131.0", latestTested: true },
  ]);
});
test("timeouts and network failures cannot become compatibility failures", () => {
  assert.equal(classify(null, "Runner timeout", true).status, "INFRA_ERROR");
  assert.equal(classify(1, "error building site: dial tcp: no such host").status, "INFRA_ERROR");
  assert.equal(classify(1, "ERROR deprecated: .Site.Social was deprecated").status, "FAIL");
  assert.equal(classify(1, "unknown failure").status, "INFRA_ERROR");
  assert.equal(classify(1, "TOCSS: this feature is not available").status, "FAIL");
});
test("successful builds retain and normalise warning diagnostics", () => {
  assert.deepEqual(classify(0, "WARN deprecated function\nWARN deprecated function"), {
    status: "PASS_WITH_WARNINGS", warnings: ["WARN deprecated function"], errors: [],
  });
});
test("invalid persisted results are rejected", () => {
  assert.equal(resultSchema.safeParse({ schemaVersion: 1, status: "PASS" }).success, false);
});

test("resuming cannot trust a download that skipped checksum verification", () => {
  assert.equal(verifiedDownload("Extracting standard Hugo v0.170.1..."), true);
  assert.equal(verifiedDownload("Warning: could not fetch checksums; skipping verification.\nExtracting standard Hugo v0.170.1..."), false);
  assert.equal(verifiedDownload("Skipping standard v0.170.1, executable already exists."), false);
  assert.equal(verifiedDownload("Error: checksum mismatch\nExtracting extended Hugo v0.169.0..."), false);
});

test("release checks select minimum, latest, and adjacent known boundaries", async () => {
  const { releaseVersions } = await import("../../scripts/compatibility/model.ts");
  const versions = ["v0.157.0", "v0.158.0", "v0.159.0", "v0.160.0", "v0.160.1", "v0.161.0", "v0.168.0", "v0.169.0", "v0.170.0", "v0.170.1"];
  assert.deepEqual(releaseVersions(versions, "0.160.0", ["v0.158.0", "v0.169.0"]), versions.filter(version => version !== "v0.161.0"));
  assert.throws(() => releaseVersions(versions, "0.180.0"), /newer than every/);
});

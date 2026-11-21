import { z } from "zod";

export const compareVersions = (a: string, b: string): number => {
  const left = a.replace(/^v/, "").split(".").map(Number);
  const right = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
};
export const statusSchema = z.enum([
  "PASS", "PASS_WITH_WARNINGS", "FAIL", "INFRA_ERROR",
  "NOT_APPLICABLE", "NOT_TESTED",
]);
export const releaseSchema = z.object({
  tag_name: z.string(), published_at: z.string().nullable(),
  draft: z.boolean(), prerelease: z.boolean(), body: z.string().nullable(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});
export const resultSchema = z.object({
  schemaVersion: z.literal(1), key: z.string(), anankeVersion: z.string(),
  anankeCommit: z.string(), hugoVersion: z.string(),
  edition: z.enum(["standard", "extended"]), fixture: z.string(),
  status: statusSchema, reason: z.string(), testedAt: z.string(),
  durationMs: z.number(), exitCode: z.number().nullable(),
  warnings: z.array(z.string()), errors: z.array(z.string()),
  warningCount: z.number(), errorCount: z.number(),
  binary: z.string(), binarySha256: z.string(), versionOutput: z.string(),
  runnerRevision: z.string(), fixtureRevision: z.string(),
  command: z.array(z.string()), logs: z.string(),
  outputs: z.array(z.string()),
});
export type Result = z.infer<typeof resultSchema>;
export const passing = (status: string): boolean =>
  status === "PASS" || status === "PASS_WITH_WARNINGS";

// Break intervals at EVERY untested, unavailable, or unsuccessful patch release.
// A later recovery starts a new interval; endpoint evidence never fills gaps.
export function intervals(versions: string[], statuses: Map<string, string>) {
  const ranges: { minimum: string; maximum: string; latestTested: boolean }[] = [];
  let active: (typeof ranges)[number] | undefined;
  for (const version of [...versions].sort(compareVersions)) {
    if (!passing(statuses.get(version) ?? "NOT_TESTED")) {
      active = undefined;
      continue;
    }
    if (active) active.maximum = version;
    else {
      active = { minimum: version, maximum: version, latestTested: false };
      ranges.push(active);
    }
  }
  for (const range of ranges) range.latestTested = range.maximum === versions.at(-1);
  return ranges;
}

export function classify(exitCode: number | null, output: string, executionError = false) {
  const warnings = [...new Set(output.split(/\r?\n/).filter(line => /\b(warn(?:ing)?|deprecated)\b/i.test(line)))];
  const errors = [...new Set(output.split(/\r?\n/).filter(line => /\b(error|failed|panic|timeout)\b/i.test(line)))];
  if (executionError || /dial tcp|no such host|TLS handshake|connection refused|proxyconnect|context deadline|failed to download|module.*not found|permission denied|no space left/i.test(output)) {
    return { status: "INFRA_ERROR" as const, warnings, errors };
  }
  // Unknown failures require investigation before they can become confirmed FAIL.
  if (exitCode !== 0) {
    const compatibleDiagnostic = /ERROR deprecated:|function .*not defined|can't evaluate field|cannot evaluate field|error calling (?:ToCSS|Build)|TOCSS:|requires Hugo|not compatible with this Hugo|failed to extract shortcode|template.*(?:not found|removed)|has been removed|error building site.*(?:render|template)/i.test(output);
    return { status: compatibleDiagnostic ? "FAIL" as const : "INFRA_ERROR" as const, warnings, errors };
  }
  return { status: warnings.length ? "PASS_WITH_WARNINGS" as const : "PASS" as const, warnings, errors };
}

// hugov can return zero after skipping checksum verification. Require extraction
// evidence and reject every verification fallback, including on resumed runs.
export function verifiedDownload(log: string): boolean {
  return /Extracting (?:standard|extended) Hugo v[\d.]+/.test(log)
    && !/skipping verification|skipping checksum|no checksum|checksum mismatch|Error:/i.test(log);
}

export function releaseVersions(versions: string[], declaredMinimum: string | null, boundaries: string[] = []): string[] {
  const sorted = [...versions].sort(compareVersions);
  if (!sorted.length) throw new Error("No Hugo versions discovered");
  const selected = new Set<string>([sorted.at(-1)!]);
  const floorIndex = declaredMinimum ? sorted.findIndex(version => compareVersions(version, declaredMinimum) >= 0) : 0;
  if (floorIndex < 0) throw new Error(`Declared minimum ${declaredMinimum} is newer than every discovered Hugo release`);
  const anchors = [sorted[floorIndex]!, ...boundaries];
  for (const anchor of anchors) {
    const index = sorted.findIndex(version => compareVersions(version, anchor) === 0);
    if (index >= 0) for (const version of sorted.slice(Math.max(0, index - 1), index + 2)) selected.add(version);
  }
  return [...selected].sort(compareVersions);
}

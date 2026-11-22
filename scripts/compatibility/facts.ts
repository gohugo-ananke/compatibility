import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareVersions, intervals, passing, statusSchema, type Result } from "./model.ts";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const factsPath = path.join(projectRoot, "data/compatibility.json");
const countsSchema = z.record(z.string(), z.number().int().nonnegative());
const rangeSchema = z.object({ minimum: z.string(), maximum: z.string(), latestTested: z.boolean() });
const outcomeSchema = z.object({
  edition: z.enum(["standard", "extended"]), compatibilityIntervals: z.array(rangeSchema),
  maximumIsConfirmed: z.literal(false), testedHugoMinimum: z.string().nullable(),
  testedHugoMaximum: z.string().nullable(), counts: countsSchema,
  versions: z.record(z.string(), statusSchema), evidence: z.record(z.string(), z.string()).default({}),
});
const releaseFactSchema = z.object({
  tag: z.string(), commit: z.string(), releasedAt: z.string().nullable(),
  declaredHugoMinimum: z.string().nullable(), requirements: z.array(z.string()),
  extendedDeclared: z.boolean().nullable(), historicalExample: z.boolean(),
  shippedFixture: z.boolean(), outcomes: z.array(outcomeSchema),
});
export const snapshotSchema = z.object({
  discoveredAt: z.string(), latestStableHugo: z.string(), platform: z.literal("linux/amd64"),
  profiles: z.array(z.string()), releases: z.array(releaseFactSchema),
});
const auditSchema = z.object({
  origin: z.string(), startedAt: z.string(), completedAt: z.string(),
  runnerRevision: z.string(), fixtureRevision: z.string(), detailsSha256: z.string(),
  resultCount: z.number().int().positive(), counts: countsSchema,
  node: z.string(), binaries: z.array(z.object({ hugo: z.string(), edition: z.string(), sha256: z.string(), versionOutput: z.string() })),
});
export const factsSchema = z.object({
  schemaVersion: z.literal(1), snapshot: snapshotSchema,
  audits: z.record(z.string(), auditSchema),
});
export type Facts = z.infer<typeof factsSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function atomicWrite(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

export function validateFacts(value: unknown): Facts {
  const facts = factsSchema.parse(value);
  for (const release of facts.snapshot.releases) for (const outcome of release.outcomes) {
    const versions = Object.keys(outcome.versions).sort(compareVersions);
    const expected = intervals(versions, new Map(Object.entries(outcome.versions)));
    if (JSON.stringify(expected) !== JSON.stringify(outcome.compatibilityIntervals)) throw new Error(`Invalid intervals: ${release.tag}/${outcome.edition}`);
    for (const [version, status] of Object.entries(outcome.versions)) {
      if (status !== "NOT_TESTED" && !facts.audits[outcome.evidence[version] ?? ""]) throw new Error(`Missing audit evidence: ${release.tag}/${outcome.edition}/${version}`);
    }
  }
  return facts;
}
export async function readFacts(file = factsPath): Promise<Facts | undefined> {
  try { return validateFacts(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function recordSnapshot(prior: Facts | undefined, snapshot: Snapshot, results: Result[], origin: string, detailsSha256: string, node: string): Facts {
  if (!results.length) { if (prior) return prior; throw new Error("No execution evidence to record"); }
  const runnerRevisions = new Set(results.map(result => result.runnerRevision));
  const fixtureRevisions = new Set(results.map(result => result.fixtureRevision));
  if (runnerRevisions.size !== 1 || fixtureRevisions.size !== 1) throw new Error("An audit must contain one runner and fixture revision");
  const auditId = detailsSha256;
  const timestamps = results.map(result => result.testedAt).sort();
  const binaries = new Map<string, z.infer<typeof auditSchema>["binaries"][number]>();
  for (const result of results) if (result.versionOutput) binaries.set(`${result.hugoVersion}/${result.edition}`, {
    hugo: result.hugoVersion, edition: result.edition, sha256: result.binarySha256, versionOutput: result.versionOutput,
  });
  const audits = { ...prior?.audits, [auditId]: {
    origin, startedAt: timestamps[0]!, completedAt: timestamps.at(-1)!,
    runnerRevision: results[0]!.runnerRevision, fixtureRevision: results[0]!.fixtureRevision,
    detailsSha256, node, resultCount: results.length,
    counts: Object.fromEntries(statusSchema.options.map(status => [status, results.filter(result => result.status === status).length])),
    binaries: [...binaries.values()],
  } };
  const changed = new Set(results.map(result => `${result.anankeVersion}/${result.edition}/${result.hugoVersion}`));
  const releases = new Map(prior?.snapshot.releases.map(release => [release.tag, structuredClone(release)]));
  for (const incoming of snapshot.releases) {
    const previous = releases.get(incoming.tag);
    if (previous && previous.commit !== incoming.commit) throw new Error(`Historical release commit changed: ${incoming.tag}`);
    const release = structuredClone(incoming);
    for (const outcome of release.outcomes) {
      const old = previous?.outcomes.find(item => item.edition === outcome.edition);
      const statuses = { ...old?.versions, ...outcome.versions };
      const evidence = { ...old?.evidence };
      for (const version of Object.keys(statuses)) {
        if (changed.has(`${release.tag}/${outcome.edition}/${version}`)) evidence[version] = auditId;
        else statuses[version] = old?.versions[version] ?? "NOT_TESTED";
      }
      outcome.versions = statuses;
      outcome.evidence = evidence;
      release.outcomes[release.outcomes.indexOf(outcome)] = outcome;
    }
    releases.set(release.tag, release);
  }
  // A new Hugo discovery leaves older Ananke releases explicitly untested there.
  const versions = [...new Set([...releases.values()].flatMap(release => release.outcomes.flatMap(outcome => Object.keys(outcome.versions))))].sort(compareVersions);
  for (const release of releases.values()) for (const outcome of release.outcomes) {
    outcome.versions = Object.fromEntries(versions.map(version => [version, outcome.versions[version] ?? "NOT_TESTED"]));
    outcome.compatibilityIntervals = intervals(versions, new Map(Object.entries(outcome.versions)));
    outcome.testedHugoMinimum = outcome.compatibilityIntervals[0]?.minimum ?? null;
    outcome.testedHugoMaximum = outcome.compatibilityIntervals.at(-1)?.maximum ?? null;
    outcome.counts = Object.fromEntries(statusSchema.options.map(status => [status, Object.values(outcome.versions).filter(value => value === status).length]));
  }
  return validateFacts({ schemaVersion: 1, snapshot: { ...snapshot, releases: [...releases.values()].sort((a, b) => compareVersions(b.tag, a.tag)) }, audits });
}

export async function saveFacts(facts: Facts, file = factsPath) {
  await atomicWrite(file, `${JSON.stringify(validateFacts(facts), null, 2)}\n`);
}
const spans = (ranges: { minimum: string; maximum: string }[]) =>
  ranges.map(range => range.minimum === range.maximum ? range.minimum : `${range.minimum} to ${range.maximum}`).join(", ");

// One row per release: a Hugo version counts when any edition passes it.
export function renderTable(facts: Facts): string {
  const lines = ["| Ananke | Minimum tested Hugo | Maximum tested Hugo | Notes |", "| --- | --- | --- | --- |"];
  const footnotes: string[] = [];
  for (const release of facts.snapshot.releases) {
    const versions = [...new Set(release.outcomes.flatMap(outcome => Object.keys(outcome.versions)))].sort(compareVersions);
    const edition = (name: string) => release.outcomes.find(outcome => outcome.edition === name)?.versions ?? {};
    const standard = edition("standard");
    const extended = edition("extended");
    const merged = new Map(versions.map(version => [version, release.outcomes.some(outcome => passing(outcome.versions[version] ?? "NOT_TESTED")) ? "PASS" : "NOT_TESTED"]));
    const ranges = intervals(versions, merged);
    // Gaps are reported separately, so only passing versions split the Extended note.
    const covered = versions.filter(version => merged.get(version) === "PASS");
    const extendedOnly = intervals(covered, new Map(covered.map(version => [version, passing(extended[version] ?? "NOT_TESTED") && !passing(standard[version] ?? "NOT_TESTED") ? "PASS" : "NOT_TESTED"])));
    const warnings = release.outcomes.some(outcome => Object.values(outcome.versions).includes("PASS_WITH_WARNINGS"));
    // A gap is described by its evidence: failed builds, versions without a result (untested or unavailable), or both.
    const gaps = { failed: [] as string[], untested: [] as string[], mixed: [] as string[] };
    ranges.slice(1).forEach((range, index) => {
      const lower = ranges[index]!.maximum;
      const inside = versions.filter(version => compareVersions(version, lower) > 0 && compareVersions(version, range.minimum) < 0);
      const failed = inside.filter(version => release.outcomes.some(outcome => outcome.versions[version] === "FAIL")).length;
      const kind = failed === 0 ? "untested" : failed === inside.length ? "failed" : "mixed";
      gaps[kind].push(`${lower} and ${range.minimum}`);
    });
    const notes = [
      `Declared minimum Hugo version: ${release.declaredHugoMinimum ?? "unknown"}.`,
      ...(extendedOnly.length ? [`Requires Hugo Extended for ${spans(extendedOnly)}.`] : []),
      ...(warnings ? ["Builds with warnings."] : []),
      ...(gaps.failed.length ? [`Fails between ${gaps.failed.join(", and between ")}.`] : []),
      ...(gaps.mixed.length ? [`Fails or has no test result between ${gaps.mixed.join(", and between ")}.`] : []),
      ...(gaps.untested.length ? [`No test result between ${gaps.untested.join(", and between ")}.`] : []),
    ];
    // Each distinct note becomes one numbered footnote, in order of first use.
    const markers = notes.map(note => {
      if (!footnotes.includes(note)) footnotes.push(note);
      return footnotes.indexOf(note) + 1;
    });
    const first = ranges[0];
    const last = ranges.at(-1);
    lines.push(`| [${release.tag}](https://github.com/gohugo-ananke/ananke/releases/tag/${release.tag}) | ${first?.minimum ?? "None established"} | ${last ? `${last.maximum}${last.latestTested ? " (latest tested)" : ""}` : "Unknown"} | ${markers.sort((a, b) => a - b).map(marker => `[${marker}]`).join(" ")} |`);
  }
  // The documentation styles .docs-footnotes; the HTML is limited to this block.
  const notes = footnotes.map((note, index) => `<p><sup>${index + 1}</sup> ${note}</p>`).join("\n");
  return `${lines.join("\n")}\n\n<!-- markdownlint-disable MD033 -->\n<div class="docs-footnotes">\n${notes}\n</div>\n<!-- markdownlint-enable MD033 -->`;
}
export async function generatePage(facts: Facts, output: string) {
  const template = await readFile(path.join(projectRoot, "documentation/compatibility.md"), "utf8");
  const marker = "<!-- compatibility:table -->";
  if (template.split(marker).length !== 2) throw new Error("Documentation template must contain exactly one table marker");
  const verifiedAt = Object.values(facts.audits).map(audit => audit.completedAt).sort().at(-1);
  const table = `Last execution: ${verifiedAt}. Release discovery: ${facts.snapshot.discoveredAt}. Latest stable Hugo in this snapshot: ${facts.snapshot.latestStableHugo}. Platform: ${facts.snapshot.platform}.\n\n${renderTable(facts)}`;
  await atomicWrite(output, template.replace(marker, table));
}

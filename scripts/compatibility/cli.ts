import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import { classify, compareVersions, intervals, passing, verifiedDownload, releaseSchema, resultSchema, type Result, releaseVersions } from "./model.ts";

import { factsPath, generatePage, readFacts, recordSnapshot, saveFacts, sha256, snapshotSchema } from "./facts.ts";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml") as { parse: (value: string) => Record<string, unknown>; stringify: (value: object) => string };
if (Number(process.versions.node.split(".")[0]) < 24 || process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This initial runner requires Node.js 24+ on Linux/amd64");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = parseArgs({ options: {
  workspace: { type: "string", default: path.join(root, "scratch/ananke-compatibility") },
  repository: { type: "string", default: path.resolve(root, "../ananke") },
  hugov: { type: "string", default: path.join(homedir(), "github.com/davidsneighbour/hugov/hugov") },
  binaries: { type: "string", default: path.join(homedir(), "github.com/davidsneighbour/hugov/executables") },
  "release-check": { type: "boolean" }, "ananke-version": { type: "string" }, "hugo-version": { type: "string" },
  edition: { type: "string", default: "both" }, concurrency: { type: "string", default: "2" },
  timeout: { type: "string", default: "120" }, resume: { type: "boolean" },
  force: { type: "boolean" }, "report-only": { type: "boolean" },
  discover: { type: "boolean" }, download: { type: "boolean" },
  "recheck-failures": { type: "boolean" }, "retry-infra": { type: "boolean" }, "refresh": { type: "boolean" },
  strategy: { type: "string", default: "exhaustive" },
  window: { type: "string", default: "2" },
  "docs-export": { type: "string" }, help: { type: "boolean" },
} }).values;
if (options.help) {
  console.log(`Ananke historical build compatibility (documentation issue #59)
Usage: npm run compat -- [options]
--workspace PATH       All sources, caches, logs, and results (default scratch/ananke-compatibility)
--repository PATH      Read-only Ananke Git repository (default ../ananke)
--release-check        Test minimum, latest, and nearby known boundaries for one tag
--hugov PATH           Existing hugov script; downloads use an isolated copy
--binaries PATH        Installed hugov binary directory (read-only)
--ananke-version LIST  Comma-separated release tags
--hugo-version LIST    Comma-separated Hugo versions, with or without v
--edition EDITION     standard, extended, or both (default both)
--concurrency N        Parallel builds (default 2)
--timeout SECONDS      Per-command timeout (default 120)
--strategy MODE        exhaustive, discovery, or verify (default exhaustive)
--window N             Patch releases either side of transitions in verify mode
--recheck-failures      Repeat previously failed combinations in fresh run directories
--discover             Inventory only; no builds
--download             Download missing published binaries through isolated hugov
--resume               Reuse validated results with identical input hashes
--retry-infra          Re-run infrastructure errors when resuming
--force                Re-test selected combinations; old logs remain
--refresh              Refresh GitHub metadata (otherwise use recorded snapshot)
--report-only          Generate reports from saved results without network or builds
--docs-export PATH     Write generated compatibility Markdown and compact JSON to docs copy
--help                Show this help`);
  process.exit(0);
}
if (options["report-only"]) {
  const facts = await readFacts();
  if (!facts) throw new Error(`No recorded facts at ${factsPath}`);
  const output = options["docs-export"]
    ? path.join(path.resolve(options["docs-export"]), "content/get-started/compatibility.md")
    : path.join(path.resolve(options.workspace), "report/compatibility.md");
  await generatePage(facts, output);
  console.log(`Generated ${output}`);
  process.exit(0);
}
if (options["release-check"] && (!options["ananke-version"] || options["ananke-version"].includes(","))) {
  throw new Error("Release checks require one --ananke-version TAG");
}
const priorFacts = await readFacts();
const config = z.object({
  edition: z.enum(["both", "standard", "extended"]),
  concurrency: z.coerce.number().int().min(1).max(32),
  timeout: z.coerce.number().positive().max(3600),
  strategy: z.enum(["exhaustive", "discovery", "verify"]),
  window: z.coerce.number().int().min(1).max(50),
}).parse(options);
const workspace = path.resolve(options.workspace);
const repository = path.resolve(options.repository);
await mkdir(workspace, { recursive: true });
await mkdir(path.join(workspace, "tmp"), { recursive: true });
const exists = async (file: string) => access(file).then(() => true, () => false);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fileHash(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
async function treeHash(directory: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    parts.push(`${entry.name}:${entry.isDirectory() ? await treeHash(file) : await fileHash(file)}`);
  }
  return hash(parts.join("\n"));
}
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  await writeFile(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}
const activeChildren = new Set<number>();
process.on("exit", () => {
  for (const pid of activeChildren) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ } }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  for (const pid of activeChildren) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already exited. */ } }
  process.exit(signal === "SIGINT" ? 130 : 143);
});
type Execution = { code: number | null; stdout: string; stderr: string; error: boolean; durationMs: number };
async function execute(binary: string, args: string[], cwd = workspace, env: NodeJS.ProcessEnv = {}): Promise<Execution> {
  const start = performance.now();
  return new Promise(resolve => {
    let stdout = "", stderr = "", error = false;
    const child = spawn(binary, args, { cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HUGO_") && !["GOFLAGS", "GOWORK", "GOMODCACHE", "GOPATH"].includes(key))), TMPDIR: path.join(workspace, "tmp"), ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) activeChildren.add(child.pid);
    const stop = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Process already ended. */ } }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      error = true;
      stderr += "\nRunner timeout\n";
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 2000);
    }, config.timeout * 1000);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", failure => { error = true; stderr += failure.message; });
    child.on("close", code => {
      if (child.pid) activeChildren.delete(child.pid);
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, error, durationMs: performance.now() - start });
    });
  });
}
async function checked(binary: string, args: string[], cwd = workspace) {
  const result = await execute(binary, args, cwd);
  if (result.error || result.code !== 0) throw new Error(`${binary} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
async function releases(repo: string, cache: string) {
  const file = path.join(workspace, cache);
  if (options.refresh || !await exists(file)) {
    const raw = await checked("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]);
    await atomic(file, (JSON.parse(raw) as unknown[][]).flat());
  }
  return z.array(releaseSchema).parse(JSON.parse(await readFile(file, "utf8")))
    .filter(release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => compareVersions(a.tag_name, b.tag_name));
}
const inventorySchema = z.object({
  schemaVersion: z.literal(1), discoveredAt: z.string(),
  ananke: z.array(z.object({ tag: z.string(), commit: z.string(), releasedAt: z.string().nullable(),
    declaredHugoMinimum: z.string().nullable(), requirements: z.array(z.object({ source: z.string(), text: z.string() })),
    extendedDeclared: z.boolean().nullable(), historicalExample: z.boolean(), shippedFixture: z.boolean(),
  })),
  hugo: z.array(z.object({ tag: z.string(), releasedAt: z.string().nullable(),
    editions: z.object({ standard: z.boolean(), extended: z.boolean() }),
  })),
  installed: z.array(z.string()), hugovSha256: z.string(),
});
type Inventory = z.infer<typeof inventorySchema>;
const inventoryFile = path.join(workspace, "inventory.json");
const selected = (filter: string | undefined, version: string) => !filter || filter.split(",").some(part => `v${part.replace(/^v/, "")}` === version);

async function discover(): Promise<Inventory> {
  const ananke = (await releases("gohugo-ananke/ananke", "ananke-releases.json")).filter(release => compareVersions(release.tag_name, "v2.10.0") >= 0);
  const hugo = (await releases("gohugoio/hugo", "hugo-releases.json")).filter(release => compareVersions(release.tag_name, "v0.128.0") >= 0);
  const records: Inventory["ananke"] = [];
  for (const release of ananke) {
    const commit = await checked("git", ["-C", repository, "rev-parse", `${release.tag_name}^{commit}`]);
    const source = path.join(workspace, "sources", release.tag_name);
    if (!await exists(path.join(source, ".compat-source.json"))) {
      await mkdir(source, { recursive: true });
      const archive = path.join(workspace, "sources", `${release.tag_name}.tar`);
      await checked("git", ["-C", repository, "archive", "--format=tar", `--output=${archive}`, commit]);
      await checked("tar", ["-xf", archive, "-C", source]);
      await atomic(path.join(source, ".compat-source.json"), { commit });
    }
    const stored = JSON.parse(await readFile(path.join(source, ".compat-source.json"), "utf8")) as { commit: string };
    if (stored.commit !== commit) throw new Error(`Source mismatch: ${release.tag_name}`);
    const compared = await execute("tar", ["--compare", "-f", path.join(workspace, "sources", `${release.tag_name}.tar`), "-C", source]);
    const differences = (compared.stdout + compared.stderr).split("\n").filter(line => line && !/: (?:Uid|Gid) differs$/.test(line));
    if (compared.error || (compared.code !== 0 && compared.code !== 1) || differences.length) throw new Error(`Historical source changed: ${differences.join("\n")}`);
    const requirements: { source: string; text: string }[] = [];
    let minimum: string | null = null, extended: boolean | null = null;
    for (const name of ["config/_default/module.toml", "config.toml", "hugo.toml", "theme.toml", "go.mod"]) {
      if (!await exists(path.join(source, name))) continue;
      const text = await readFile(path.join(source, name), "utf8");
      requirements.push({ source: `${name}@${commit}`, text });
      if (name.endsWith(".toml")) {
        const parsed = TOML.parse(text);
        const module = parsed["module"] as Record<string, unknown> | undefined;
        const requirement = (parsed["hugoVersion"] ?? module?.["hugoVersion"]) as { min?: string; extended?: boolean } | undefined;
        const candidate = requirement?.min ?? (name === "theme.toml" ? parsed["min_version"] as string | undefined : undefined);
        if (candidate && (!minimum || compareVersions(candidate, minimum) > 0)) minimum = candidate;
        if (requirement?.extended !== undefined) extended = requirement.extended || extended === true;
      }
    }
    requirements.push({ source: `https://github.com/gohugo-ananke/ananke/releases/tag/${release.tag_name}`, text: release.body ?? "" });
    // Release-note prose is retained for review; only explicit version requirements affect the floor.
    for (const match of (release.body ?? "").matchAll(/(?:minimum Hugo(?: version)?|requires Hugo(?: version)?)\s*[:=]?\s*v?(0\.\d+\.\d+)/gi)) {
      const candidate = match[1];
      if (candidate && (!minimum || compareVersions(candidate, minimum) > 0)) minimum = candidate;
    }
    records.push({ tag: release.tag_name, commit, releasedAt: release.published_at,
      declaredHugoMinimum: minimum, extendedDeclared: extended, requirements,
      historicalExample: await exists(path.join(source, "exampleSite")),
      shippedFixture: await exists(path.join(source, "tests/fixtures/site")),
    });
  }
  const installed = await checked(options.hugov, ["--list"]);
  const result = inventorySchema.parse({ schemaVersion: 1, discoveredAt: new Date().toISOString(), ananke: records,
    hugo: hugo.map(release => ({ tag: release.tag_name, releasedAt: release.published_at,
      editions: { standard: release.assets.some(asset => /^hugo_[\d.]+_linux-amd64\.tar\.gz$/.test(asset.name)),
        extended: !hugo.some(previous => compareVersions(previous.tag_name, release.tag_name) <= 0 && /extended edition of Hugo is gone|extended edition.*(?:removed|discontinued)/i.test((previous.body ?? "").replace(/[*_]/g, ""))) && release.assets.some(asset => /^hugo_extended_[\d.]+_linux-amd64\.tar\.gz$/.test(asset.name)) } })),
    installed: installed.split("\n"), hugovSha256: await fileHash(options.hugov),
  });
  await atomic(inventoryFile, result);
  return result;
}
const inventory = await discover();
if (options.discover) {
  console.log(`Inventoried ${inventory.ananke.length} Ananke releases and ${inventory.hugo.length} Hugo releases in ${workspace}`);
  process.exit(0);
}
const selectedReleases = inventory.ananke.filter(release => selected(options["ananke-version"], release.tag));
if (!selectedReleases.length) throw new Error("No matching stable Ananke release; check --ananke-version");
let releaseCandidates: Set<string> | undefined;
if (options["release-check"]) {
  const release = selectedReleases[0]!;
  const neighbouring = priorFacts?.snapshot.releases.find(item => item.tag === release.tag)
    ?? priorFacts?.snapshot.releases.find(item => compareVersions(item.tag, release.tag) < 0);
  const boundaries = neighbouring?.outcomes.flatMap(outcome => outcome.compatibilityIntervals.flatMap(range => [range.minimum, range.maximum])) ?? [];
  releaseCandidates = new Set(releaseVersions(inventory.hugo.map(item => item.tag), release.declaredHugoMinimum, boundaries));
}
const selectedHugo = (version: string) => selected(options["hugo-version"], version) && (!releaseCandidates || releaseCandidates.has(version));
if (!inventory.hugo.some(release => selectedHugo(release.tag))) throw new Error("No matching stable Hugo release; check --hugo-version");
const editions: ("standard" | "extended")[] = config.edition === "both" ? ["standard", "extended"] : [config.edition];
const profiles = ["baseline", "historical-example"];
const baseline = path.join(root, "tests/compatibility/baseline");
const runnerRevision = hash(`${await treeHash(path.join(root, "scripts/compatibility"))}\n${await fileHash(path.join(root, "package-lock.json"))}\n${process.version}\nlinux-amd64\nproduction --minify`);
const fixtureRevision = await treeHash(baseline);
const resultDirectory = path.join(workspace, "results");
await mkdir(resultDirectory, { recursive: true });
const saved: Result[] = [];
for (const name of await readdir(resultDirectory)) {
  if (name.endsWith(".json") && /^[a-f0-9]{64}\.json$/.test(name)) saved.push(resultSchema.parse(JSON.parse(await readFile(path.join(resultDirectory, name), "utf8"))));
}
const current = new Map(saved.map(result => [result.key, result]));
let infrastructureErrors = 0;
if (!options["report-only"]) {
  const binaryCache = new Map<string, { binary: string; digest: string; version: string; available: boolean; error: string }>();
  for (const release of inventory.hugo.filter(release => selectedHugo(release.tag))) {
    for (const edition of editions) {
      const name = `hugo-${release.tag}${edition === "extended" ? "-extended" : ""}`;
      let binary = path.join(path.resolve(options.binaries), name);
      const isolated = path.join(workspace, "hugov", "executables", name);
      let downloadLog = "";
      const downloadLogPath = path.join(workspace, "downloads", `${name}.log`);
      if (!await exists(binary) && await exists(isolated) && await exists(downloadLogPath)) {
        downloadLog = await readFile(downloadLogPath, "utf8");
        if (verifiedDownload(downloadLog)) binary = isolated;
      }
      if (!await exists(binary) && release.editions[edition] && options.download) {
        const script = path.join(workspace, "hugov", "hugov");
        await mkdir(path.dirname(isolated), { recursive: true });
        if (!await exists(script)) await cp(options.hugov, script);
        const downloaded = await execute("bash", [script, "--download", release.tag, `--${edition}`], workspace, { TMPDIR: path.join(workspace, "tmp") });
        downloadLog = downloaded.stdout + downloaded.stderr;
        await atomic(path.join(workspace, "downloads", `${name}.log`), downloadLog);
        if (downloaded.code === 0 && !downloaded.error && verifiedDownload(downloadLog) && await exists(isolated)) binary = isolated;
      }
      const available = release.editions[edition];
      if (!available) {
        binaryCache.set(name, { binary, digest: "unavailable", version: "", available, error: "Edition not published for linux-amd64 in GitHub release assets" });
        continue;
      }
      if (!await exists(binary)) {
        binaryCache.set(name, { binary, digest: "missing", version: "", available, error: `Published binary missing or download unverified: ${downloadLog}` });
        continue;
      }
      const version = await execute(binary, ["version"]);
      const help = await execute(binary, ["--help"]);
      const supportedFlags = ["source", "destination", "themesDir", "cacheDir", "environment", "minify"].every(flag => help.stdout.includes(`--${flag}`));
      await atomic(path.join(workspace, "binaries", `${name}.json`), { binary, version: version.stdout, help: help.stdout, sha256: await fileHash(binary), integrity: binary === isolated ? "hugov checksum-verified download; see download log" : "existing binary fingerprinted; original archive checksum not independently verified" });
      const extended = /\+extended/.test(version.stdout);
      const valid = supportedFlags && help.code === 0 && version.code === 0 && version.stdout.includes(release.tag) && extended === (edition === "extended") && /linux\/amd64/.test(version.stdout);
      binaryCache.set(name, { binary, digest: await fileHash(binary), version: version.stdout.trim(), available,
        error: valid ? "" : `Binary identity mismatch: ${version.stdout}${version.stderr}` });
    }
  }
  const jobs: (() => Promise<void>)[] = [];
  for (const release of selectedReleases) {
    let hugoReleases = inventory.hugo.filter(hugo => selectedHugo(hugo.tag));
    if (config.strategy === "discovery") {
      const candidates = new Set<string>();
      for (let i = 0; i < inventory.hugo.length; i++) {
        const item = inventory.hugo[i];
        if (!item) continue;
        if (item.tag.split(".")[1] !== inventory.hugo[i + 1]?.tag.split(".")[1]) candidates.add(item.tag);
        if (release.declaredHugoMinimum && compareVersions(item.tag, release.declaredHugoMinimum) === 0) {
          for (const adjacent of inventory.hugo.slice(Math.max(0, i - 1), i + 2)) candidates.add(adjacent.tag);
        }
      }
      hugoReleases = hugoReleases.filter(item => candidates.has(item.tag));
    }
    if (config.strategy === "verify") {
      const candidates = new Set<string>();
      let transitions = 0;
      for (const edition of editions) {
        const observations = inventory.hugo.map(hugo => {
          const observations = saved.filter(result => result.anankeVersion === release.tag && result.hugoVersion === hugo.tag && result.edition === edition && result.fixture === "baseline")
            .sort((a, b) => b.testedAt.localeCompare(a.testedAt));
          return observations[0];
        });
        let previous: Result | undefined;
        for (let i = 0; i < observations.length; i++) {
          const observation = observations[i];
          if (!observation || !["PASS", "PASS_WITH_WARNINGS", "FAIL"].includes(observation.status)) continue;
          if (previous && passing(previous.status) !== passing(observation.status)) {
            transitions++;
            const previousIndex = inventory.hugo.findIndex(item => item.tag === previous?.hugoVersion);
            for (const item of inventory.hugo.slice(Math.max(0, previousIndex - config.window), i + config.window + 1)) candidates.add(item.tag);
          }
          previous = observation;
        }
      }
      // Multiple transitions imply recovery: expand to an exhaustive release sweep.
      if (transitions > 2) for (const item of inventory.hugo) candidates.add(item.tag);
      if (!candidates.size) throw new Error(`No observed transition for ${release.tag}; use discovery or exhaustive first`);
      hugoReleases = hugoReleases.filter(item => candidates.has(item.tag));
    }
    for (const hugo of hugoReleases) for (const edition of editions) for (const fixture of profiles) {
      jobs.push(async () => {
        const identity = binaryCache.get(`hugo-${hugo.tag}${edition === "extended" ? "-extended" : ""}`);
        if (!identity) throw new Error("Missing binary inventory");
        const key = hash(JSON.stringify({ commit: release.commit, hugo: hugo.tag, edition, fixture, runnerRevision, fixtureRevision, binary: identity.digest, timeout: config.timeout }));
        const previous = current.get(key);
        if (options["recheck-failures"] && previous?.status !== "FAIL") return;
        if (previous && options.resume && !options.force && !(options["retry-infra"] && previous.status === "INFRA_ERROR")) return;
        const run = path.join(workspace, "runs", release.tag, `${hugo.tag}-${edition}-${fixture}`, randomUUID());
        await mkdir(run, { recursive: true });
        const result: Result = { schemaVersion: 1, key, anankeVersion: release.tag, anankeCommit: release.commit,
          hugoVersion: hugo.tag, edition, fixture, status: "NOT_TESTED", reason: "", testedAt: new Date().toISOString(),
          durationMs: 0, exitCode: null, warnings: [], errors: [], warningCount: 0, errorCount: 0,
          binary: identity.binary, binarySha256: identity.digest, versionOutput: identity.version, runnerRevision, fixtureRevision,
          command: [], logs: path.relative(workspace, run), outputs: [] };
        if (fixture === "historical-example" && !release.historicalExample) {
          result.status = "NOT_APPLICABLE"; result.reason = "No exampleSite shipped in this release";
        } else if (!identity.available) {
          result.status = "NOT_APPLICABLE"; result.reason = identity.error;
        } else if (identity.error) {
          result.status = "INFRA_ERROR"; result.reason = identity.error;
        } else {
          const site = path.join(run, "site");
          const source = path.join(workspace, "sources", release.tag);
          await cp(fixture === "baseline" ? baseline : path.join(source, "exampleSite"), site, { recursive: true });
          // Local theme loading, with no dependency downloads and no historical source edits.
          const themeDirectory = path.join(run, "themes");
          await mkdir(themeDirectory);
          await symlink(source, path.join(themeDirectory, "ananke"), "dir");
          const originalConfig = fixture === "baseline" ? "hugo.toml" : "config.toml";
          const configPath = path.join(site, originalConfig);
          if (!await exists(configPath)) throw new Error(`Fixture configuration requires investigation: ${configPath}`);
          const configuration = TOML.parse(await readFile(configPath, "utf8"));
          configuration["theme"] = ["ananke"];
          configuration["resourceDir"] = path.join(run, "resources");
          configuration["module"] = { imports: [] };
          if (fixture === "baseline" && compareVersions(hugo.tag, "v0.128.0") === 0) configuration["paginate"] = 2;
          await writeFile(configPath, TOML.stringify(configuration));
          await mkdir(path.join(run, "tmp"));
          const args = ["--source", site, "--destination", path.join(run, "public"), "--themesDir", themeDirectory,
            "--cacheDir", path.join(run, "cache"), "--environment", "production", "--minify"];
          result.command = [identity.binary, ...args];
          const environment = { TZ: "UTC", LC_ALL: "C.UTF-8", GOCACHE: path.join(run, "go-build"), TMPDIR: path.join(run, "tmp"), HUGO_RESOURCEDIR: path.join(run, "resources"),
            GOPATH: path.join(run, "go"), GOMODCACHE: path.join(run, "go/pkg/mod"), GOPROXY: "off", GOWORK: "off", HUGO_CACHEDIR: path.join(run, "cache") };
          const build = await execute(identity.binary, args, site, environment);
          await writeFile(path.join(run, "stdout.log"), build.stdout);
          await writeFile(path.join(run, "stderr.log"), build.stderr);
          const classified = classify(build.code, build.stdout + build.stderr, build.error);
          Object.assign(result, classified, { exitCode: build.code, durationMs: build.durationMs,
            warningCount: classified.warnings.length, errorCount: classified.errors.length,
            reason: classified.status === "FAIL" ? "Build diagnostic indicates template/API compatibility failure; inspect logs" : classified.status === "INFRA_ERROR" ? "Execution, dependency, or unclassified failure; inspect logs" : "Production build completed" });
          if (passing(result.status)) {
            for (const output of ["index.html", "posts/index.html", "posts/post-1/index.html", "tags/compatibility/index.html", "fr/index.html", "index.xml", "sitemap.xml", "posts/page/2/index.html"]) {
              if (await exists(path.join(run, "public", output))) result.outputs.push(output);
            }
            const css = path.join(run, "public/ananke/css");
            const cssBuilt = await exists(css) && (await readdir(css)).some(name => name.endsWith(".css"));
            if (fixture === "baseline" && (result.outputs.length !== 8 || !cssBuilt)) {
              result.status = "INFRA_ERROR"; result.reason = "Baseline output assertions failed; inspect fixture before claiming compatibility";
            }
          }
        }
        if (result.status === "INFRA_ERROR") infrastructureErrors++;
        resultSchema.parse(result);
        await atomic(path.join(resultDirectory, `${key}.json`), result);
        current.set(key, result);
        console.log(`${release.tag} ${hugo.tag} ${edition} ${fixture}: ${result.status}`);
      });
    }
  }
  let position = 0;
  await Promise.all(Array.from({ length: config.concurrency }, async () => {
    while (position < jobs.length) { const job = jobs[position++]; if (job) await job(); }
  }));
}
// Use the newest result per combination. Historical executions remain on disk.
const latest = new Map<string, Result>();
for (const result of current.values()) {
  if (result.runnerRevision !== runnerRevision || result.fixtureRevision !== fixtureRevision) continue;
  const combination = `${result.anankeVersion}/${result.hugoVersion}/${result.edition}/${result.fixture}`;
  const previous = latest.get(combination);
  if (!previous || previous.testedAt < result.testedAt) latest.set(combination, result);
}
const orderedResults = [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
const versions = inventory.hugo.map(release => release.tag);
const rows = inventory.ananke.map(release => {
  const outcomes = (["standard", "extended"] as const).map(edition => {
    const statuses = new Map<string, string>();
    for (const version of versions) {
      const results = profiles.map(fixture => latest.get(`${release.tag}/${version}/${edition}/${fixture}`));
      const applicable = results.filter((result): result is Result => !!result && !(result.fixture === "historical-example" && !release.historicalExample));
      let status = "NOT_TESTED";
      if (applicable.length === (release.historicalExample ? 2 : 1)) {
        if (applicable.every(result => passing(result.status))) status = applicable.some(result => result.status === "PASS_WITH_WARNINGS") ? "PASS_WITH_WARNINGS" : "PASS";
        else if (applicable.some(result => result.status === "INFRA_ERROR")) status = "INFRA_ERROR";
        else if (applicable.some(result => result.status === "FAIL")) status = "FAIL";
        else if (applicable.every(result => result.status === "NOT_APPLICABLE")) status = "NOT_APPLICABLE";
      }
      statuses.set(version, status);
    }
    const compatibilityIntervals = intervals(versions, statuses);
    return { edition, compatibilityIntervals, maximumIsConfirmed: false,
      testedHugoMinimum: compatibilityIntervals[0]?.minimum ?? null,
      testedHugoMaximum: compatibilityIntervals.at(-1)?.maximum ?? null,
      counts: Object.fromEntries([...new Set(statuses.values())].map(status => [status, [...statuses.values()].filter(value => value === status).length])),
      versions: Object.fromEntries(statuses),
    };
  });
  return { ...release, requirements: release.requirements.map(requirement => requirement.source), outcomes };
}).reverse();
const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), discoveredAt: inventory.discoveredAt,
  latestStableHugo: versions.at(-1), platform: "linux/amd64", profiles, releases: rows,
  resultCount: latest.size, counts: Object.fromEntries(resultSchema.shape.status.options.map(status => [status, orderedResults.filter(result => result.status === status).length])) };
await atomic(path.join(resultDirectory, "summary.json"), summary);
await atomic(path.join(resultDirectory, "details.json"), { schemaVersion: 1, results: orderedResults });
await atomic(path.join(resultDirectory, "result.schema.json"), z.toJSONSchema(resultSchema));
const facts = latest.size
  ? recordSnapshot(priorFacts, snapshotSchema.parse(summary), orderedResults, "compatibility-runner", sha256(await readFile(path.join(resultDirectory, "details.json"))), process.version)
  : priorFacts;
if (!facts) throw new Error("No results available to report");
await saveFacts(facts);
const report = path.join(workspace, "report/compatibility.md");
await generatePage(facts, report);
if (options["docs-export"]) await generatePage(facts, path.join(path.resolve(options["docs-export"]), "content/get-started/compatibility.md"));
console.log(`Report: ${report} (${latest.size} current-runner results; historical facts retained)`);
if (infrastructureErrors) process.exitCode = 1;

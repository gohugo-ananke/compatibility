# Ananke Hugo compatibility

Build compatibility checks for [Ananke](https://github.com/gohugo-ananke/ananke), maintained separately from the theme. This repository implements [documentation issue #59](https://github.com/gohugo-ananke/documentation/issues/59).

## Check a release

Use Node.js 24 or later on Linux/amd64, npm, Git, tar, the authenticated GitHub CLI, and the existing `hugov` installation. Keep the Ananke checkout next to this repository, with its release tags available.

```bash
npm ci
npm run check:release -- --ananke-version v2.22.0
```

Replace the tag with the stable Ananke release to check. This command refreshes GitHub release discovery, downloads missing published binaries through an isolated copy of `hugov`, and checks both editions where available. It selects the declared minimum, latest stable Hugo, and adjacent patches around the minimum and recorded boundaries. It does not run the full historical matrix. Missing or unknown release filters fail explicitly.

The check writes compact facts to `data/compatibility.json`. Review changes before committing. Compatibility failures are recorded as results; infrastructure failures make the command exit with an error. The runner never switches the Ananke branch, changes release tags, updates historical dependencies, or publishes anything.

## Generate the documentation page

```bash
npm run report
npm run report -- --output ../documentation/content/get-started/compatibility.md
```

The first command writes a preview to `scratch/report/compatibility.md`. The second writes the single public page into the sibling documentation checkout. Generation validates the compact facts and uses `documentation/compatibility.md` as its prose template. It needs no Hugo binary, network, historical site, or raw logs. Normal documentation builds read only this Markdown page.

## Maintenance commands

```bash
npm run compat -- --help
npm run compat -- --discover
npm run compat -- --ananke-version v2.10.0 --edition extended --resume
npm run compat -- --strategy discovery --ananke-version v2.22.0
npm run compat -- --strategy verify --ananke-version v2.22.0 --window 2
npm run compat -- --download --resume
npm run compat -- --recheck-failures
npm run compat -- --resume --retry-infra
npm run import:audit -- --workspace ../ananke/scratch/ananke-compatibility
npm run check
```

The unfiltered `compat -- --download --resume` command is an explicit full historical sweep. Default concurrency is two; `--concurrency 4` permits four builds. `--timeout 120` sets a per-command timeout in seconds. `--workspace PATH` overrides `scratch/ananke-compatibility/`. `--repository PATH`, `--hugov PATH`, and `--binaries PATH` override local tooling locations. Version filters accept comma-separated complete versions. `--force` repeats selected tests; `--refresh` refreshes cached GitHub metadata.

`import:audit` validates a complete existing audit and replaces the compact facts file. Use it only for a deliberate full import. Normal runs merge new evidence. Full execution results remain in the workspace, with atomic JSON writes and separate stdout and stderr logs. Cache keys include source, binary, fixture, runner, dependency, Node version, and build settings. A changed input cannot silently reuse an old pass.

The full result schema is in `scripts/compatibility/model.ts`; compact facts and validation are in `scripts/compatibility/facts.ts`. `npm run check` performs strict TypeScript checking and unit tests. No automatic release or publication workflow is configured.

## Method and limits

The audit starts at Ananke v2.10.0 and Hugo v0.128.0, ignores prereleases, and enumerates stable patches. Each execution invokes the actual binary in production mode with minification, and has its own site copy, output, resources, cache, Go module cache, and temporary directory. Required flags and binary identity are checked. Existing local binaries are fingerprinted; their original archive checksums are not independently reverified. New downloads require an accepted checksum-verification log, including on resume.

The baseline covers home, list, single, taxonomy, navigation, summaries, static images, a built-in shortcode, multilingual content, pagination, RSS, sitemap, and CSS output. Historical examples also run where present. Modern release-specific fixtures are inventoried but remain outside this initial profile. Module downloads are disabled during builds; future releases with external dependencies need a pinned preparation step.

PASS and PASS_WITH_WARNINGS establish build compatibility for these profiles. FAIL identifies recognised compatibility diagnostics. Unknown failures remain INFRA_ERROR until reviewed. Missing editions or fixtures are NOT_APPLICABLE. Untested versions are NOT_TESTED. Failed, unavailable, and untested patches break an interval. Two consecutive failures never stop an exhaustive sweep; a later recovery creates another interval. Latest tested does not promise future compatibility.

Hugo v0.170.0 removed Extended; its compatibility archive aliases do not represent another edition. The initial snapshot has no Linux/amd64 assets for Hugo v0.139.5. Browser behaviour, complete feature correctness, installation methods, accessibility, and image transformations are outside this build audit.

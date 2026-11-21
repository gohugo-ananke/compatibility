import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { resultSchema } from "./compatibility/model.ts";
import { factsPath, recordSnapshot, saveFacts, sha256, snapshotSchema } from "./compatibility/facts.ts";

const { values } = parseArgs({ options: { workspace: { type: "string" }, output: { type: "string", default: factsPath } } });
if (!values.workspace) throw new Error("Use --workspace PATH to import an existing audit");
const workspace = path.resolve(values.workspace);
const bytes = await readFile(path.join(workspace, "results/details.json"));
const results = z.object({ results: z.array(resultSchema) }).parse(JSON.parse(bytes.toString())).results;
const snapshot = snapshotSchema.parse(JSON.parse(await readFile(path.join(workspace, "results/summary.json"), "utf8")));
const environment = z.object({ node: z.string() }).parse(JSON.parse(await readFile(path.join(workspace, "runner-environment.json"), "utf8")));
await saveFacts(recordSnapshot(undefined, snapshot, results, "historical-audit-import", sha256(bytes), environment.node), path.resolve(values.output));
console.log(`Imported ${results.length} executions into ${values.output}; raw artefacts remain in ${workspace}`);

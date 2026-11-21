import path from "node:path";
import { parseArgs } from "node:util";
import { factsPath, generatePage, projectRoot, readFacts } from "./compatibility/facts.ts";

const { values } = parseArgs({ options: {
  output: { type: "string", default: path.join(projectRoot, "scratch/report/compatibility.md") },
  facts: { type: "string", default: factsPath },
} });
const facts = await readFacts(values.facts);
if (!facts) throw new Error(`No compatibility facts at ${values.facts}`);
await generatePage(facts, path.resolve(values.output));
console.log(`Generated ${path.resolve(values.output)}`);

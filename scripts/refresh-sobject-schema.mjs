import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sObjects = [];
let targetOrg;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if ((arg === "--target-org" || arg === "-o") && args[index + 1]) {
    targetOrg = args[index + 1];
    index += 1;
    continue;
  }

  sObjects.push(arg);
}

if (sObjects.length === 0) {
  sObjects.push("Account");
}

for (const sObjectName of sObjects) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(__c)?$/.test(sObjectName)) {
    fail(`Invalid sObject API name: ${sObjectName}`);
  }
}

if (targetOrg && !/^[A-Za-z0-9_.@+-]+$/.test(targetOrg)) {
  fail(`Invalid target org alias or username: ${targetOrg}`);
}

const outputDir = path.join(root, ".apexx", "schema", "sobjects");
fs.mkdirSync(outputDir, { recursive: true });

for (const sObjectName of sObjects) {
  const describeArgs = [
    "sobject",
    "describe",
    "--sobject",
    sObjectName,
    "--json",
  ];

  if (targetOrg) {
    describeArgs.push("--target-org", targetOrg);
  }

  const describe = sfJson(describeArgs);
  const result = describe.result;

  if (!result) {
    fail(`Salesforce describe returned no result for ${sObjectName}.`);
  }

  const fields = (result.fields ?? [])
    .map(fieldInfo => ({
      name: fieldInfo.name,
      type: fieldInfo.type,
      label: fieldInfo.label,
      custom: fieldInfo.custom,
      referenceTo: fieldInfo.referenceTo,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const schema = {
    name: result.name ?? sObjectName,
    label: result.label,
    refreshedAt: new Date().toISOString(),
    fields,
  };
  const outputPath = path.join(outputDir, `${schema.name}.json`);

  fs.writeFileSync(`${outputPath}.tmp`, JSON.stringify(schema, null, 2), "utf8");
  fs.renameSync(`${outputPath}.tmp`, outputPath);

  console.log(`Wrote ${path.relative(root, outputPath)} (${fields.length} fields)`);
}

// The Salesforce CLI reports failures as JSON on stdout, so the exit status is
// read rather than thrown on. execFileSync would surface a Node stack trace and
// bury the actual CLI message.
function sfJson(args) {
  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "sf";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", "sf", ...args] : args;

  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    fail(`Unable to run Salesforce CLI: ${result.error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(result.stderr || result.stdout || "Salesforce CLI returned no JSON output.");
  }

  if (result.status !== 0 || parsed.status !== 0) {
    const actions = (parsed.actions ?? []).map(action => `\n  ${action}`).join("");
    fail(
      (parsed.message || result.stderr || `Salesforce CLI exited with ${result.status}.`) +
        actions,
    );
  }

  return parsed;
}

function fail(message) {
  console.error(`ApexX schema refresh failed: ${message}`);
  process.exit(1);
}

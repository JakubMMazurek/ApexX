import { execFileSync } from "node:child_process";
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
    throw new Error(`Invalid sObject API name: ${sObjectName}`);
  }
}

if (targetOrg && !/^[A-Za-z0-9_.@+-]+$/.test(targetOrg)) {
  throw new Error(`Invalid target org alias or username: ${targetOrg}`);
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

  const rawDescribe = runSf(describeArgs);
  const describe = JSON.parse(rawDescribe);

  if (describe.status !== 0) {
    throw new Error(`Salesforce describe failed for ${sObjectName}`);
  }

  const result = describe.result;
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

function runSf(args) {
  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "sf";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", "sf", ...args] : args;

  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

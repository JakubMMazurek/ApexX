import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetOrg = argumentValue("--target-org") ?? "apexx";

if (!/^[A-Za-z0-9_.@-]+$/.test(targetOrg)) {
  fail(`Invalid target-org value: ${targetOrg}`);
}

const requiredGeneratedFiles = [
  "AccountService.cls",
  "AccountServiceTest.cls",
  "AccountSignalProvider.cls",
  "AccountSignalConsumer.cls",
  "PortfolioRuleProvider.cls",
  "ApexXTuples.cls",
  "ApexXFuncs.cls",
];

for (const fileName of requiredGeneratedFiles) {
  const filePath = path.join(
    root,
    "force-app",
    "main",
    "default",
    "classes",
    fileName,
  );

  if (!fs.existsSync(filePath)) {
    fail(`Generated artifact is missing: ${fileName}. Run npm run apexx -- build.`);
  }
}

const generatedClassesDirectory = path.join(
  root,
  "force-app",
  "main",
  "default",
  "classes",
);
const legacyStructuralFiles = fs.readdirSync(generatedClassesDirectory).filter(
  fileName => /^ApexX(?:Func|Tuple)_[0-9a-f]{12}\.cls$/i.test(fileName),
);
if (legacyStructuralFiles.length > 0) {
  fail(
    `Legacy one-file-per-signature artifacts remain: ${legacyStructuralFiles.join(", ")}.`,
  );
}

const org = sfJson(["org", "display", "--target-org", targetOrg, "--json"]);
const username = org.result?.username ?? "authenticated user";

const accountCount = queryCount(
  "SELECT count() FROM Account WHERE Name LIKE 'ApexX Demo%'",
);
const contactCount = queryCount(
  "SELECT count() FROM Contact WHERE Account.Name LIKE 'ApexX Demo%'",
);

if (accountCount !== 4 || contactCount !== 4) {
  fail(
    `Demo data is not deterministic (found ${accountCount} accounts and ${contactCount} contacts). Run npm run sf:seed -- --target-org ${targetOrg}.`,
  );
}

console.log("ApexX demo readiness check passed.");
console.log(`  Org: ${targetOrg} (${username})`);
console.log("  Generated contracts: ApexXFuncs + ApexXTuples registries present");
console.log(`  Demo data: ${accountCount} accounts, ${contactCount} contacts`);
console.log("  Local compiler, smoke, and editor checks passed before this org check");

function queryCount(query) {
  const response = sfJson([
    "data",
    "query",
    "--query",
    query,
    "--target-org",
    targetOrg,
    "--json",
  ]);
  return Number(response.result?.totalSize ?? response.result?.records?.[0]?.expr0 ?? -1);
}

function sfJson(args) {
  const invocation = sfInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
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
    fail(parsed.message || result.stderr || `Salesforce CLI exited with ${result.status}.`);
  }

  return parsed;
}

function sfInvocation(args) {
  if (process.platform !== "win32") {
    return { command: "sf", args };
  }

  const lookup = spawnSync("where.exe", ["sf.ps1"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const scriptPath = lookup.stdout?.split(/\r?\n/).find(Boolean);

  if (!scriptPath) {
    fail("Salesforce CLI was not found on PATH.");
  }

  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ],
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`ApexX demo readiness check failed: ${message}`);
  process.exit(1);
}

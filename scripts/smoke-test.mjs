import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

execFileSync(
  process.execPath,
  ["packages/cli/dist/index.js", "build"],
  { cwd: root, stdio: "inherit" },
);

const accountOutput = fs.readFileSync(
  path.join(
    root,
    "generated",
    "force-app",
    "main",
    "default",
    "classes",
    "AccountService.cls",
  ),
  "utf8",
);
const plainOutput = fs.readFileSync(
  path.join(
    root,
    "generated",
    "force-app",
    "main",
    "default",
    "classes",
    "PlainApex.cls",
  ),
  "utf8",
);
const accountMetadata = fs.readFileSync(
  path.join(
    root,
    "generated",
    "force-app",
    "main",
    "default",
    "classes",
    "AccountService.cls-meta.xml",
  ),
  "utf8",
);

assert.match(accountOutput, /List<Account> apexxFilter0 = new List<Account>\(\);/);
assert.match(accountOutput, /for \(Account a : accounts\)/);
assert.match(accountOutput, /return apexxFilter0;/);
assert.match(plainOutput, /public with sharing class PlainApex/);
assert.match(
  accountMetadata,
  /<ApexClass xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata">/,
);
assert.match(accountMetadata, /<status>Active<\/status>/);

const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "apexx-sfdx-"));
try {
  fs.writeFileSync(
    path.join(tempProject, "sfdx-project.json"),
    JSON.stringify(
      {
        packageDirectories: [{ path: "force-app", default: true }],
        sourceApiVersion: "66.0",
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.mkdirSync(path.join(tempProject, "apexx", "classes"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "apexx", "classes", "AccountService.clsx"),
    path.join(tempProject, "apexx", "classes", "AccountService.clsx"),
  );

  execFileSync(
    process.execPath,
    [path.join(root, "packages", "cli", "dist", "index.js"), "build"],
    { cwd: tempProject, stdio: "inherit" },
  );

  const sfdxMetadata = fs.readFileSync(
    path.join(
      tempProject,
      "force-app",
      "main",
      "default",
      "classes",
      "AccountService.cls-meta.xml",
    ),
    "utf8",
  );
  assert.match(sfdxMetadata, /<apiVersion>66\.0<\/apiVersion>/);
} finally {
  fs.rmSync(tempProject, { recursive: true, force: true });
}

console.log("Smoke test passed.");

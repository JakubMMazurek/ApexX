import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

execFileSync(
  process.execPath,
  ["packages/cli/dist/index.js", "build", "examples", "--out", "generated"],
  { cwd: root, stdio: "inherit" },
);

const accountOutput = fs.readFileSync(
  path.join(root, "generated", "AccountService.cls"),
  "utf8",
);
const plainOutput = fs.readFileSync(
  path.join(root, "generated", "PlainApex.cls"),
  "utf8",
);

assert.match(accountOutput, /List<Account> apexxFilter0 = new List<Account>\(\);/);
assert.match(accountOutput, /for \(Account a : accounts\)/);
assert.match(accountOutput, /return apexxFilter0;/);
assert.match(plainOutput, /public with sharing class PlainApex/);

console.log("Smoke test passed.");

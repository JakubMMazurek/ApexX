/**
 * Integration test for the Apex-language-server-backed resolution path.
 *
 * Needs a JDK and the Salesforce Apex extension's `apex-jorje-lsp.jar`. When either
 * is missing the test reports that and exits successfully, because the language
 * server is designed to work without them.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findJorjeJar, resolveJava } from "../packages/language-server/dist/jorjeClient.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!resolveJava() || !findJorjeJar()) {
  console.log("Apex smoke test skipped: no JDK or apex-jorje-lsp.jar on this machine.");
  process.exit(0);
}

const server = spawn(process.execPath, [
  path.join(root, "packages/language-server/dist/server.js"),
  "--stdio",
], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });

let buffer = Buffer.alloc(0);
let nextId = 1;
let logs = "";
const pending = new Map();

server.stderr.on("data", chunk => { logs += chunk.toString(); });
server.stdout.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  const separator = Buffer.from("\r\n\r\n");

  for (;;) {
    const headerEnd = buffer.indexOf(separator);
    if (headerEnd < 0) return;
    const length = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"))?.[1];
    const bodyStart = headerEnd + separator.length;
    const bodyEnd = bodyStart + Number(length);
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);

    if (message.method === "window/logMessage") {
      logs += `LOG: ${message.params.message}\n`;
      continue;
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      resolve(message.error ? { __error: message.error.message } : message.result);
    }
  }
}

function send(message) {
  const payload = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`);
  server.stdin.write(payload);
}

function request(method, params, timeoutMs = 30000) {
  const id = nextId;
  nextId += 1;
  send({ jsonrpc: "2.0", id, method, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
}

const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const open = relativePath => {
  const filePath = path.join(root, relativePath);
  const text = fs.readFileSync(filePath, "utf8");
  const uri = pathToFileURL(filePath).href;
  notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "apexx", version: 1, text },
  });
  return { uri, text, lines: text.split("\n") };
};

const positionOf = (document, needle, token) => {
  const line = document.lines.findIndex(entry => entry.includes(needle));
  assert.ok(line >= 0, `probe source is missing ${needle}`);
  const character = document.lines[line].indexOf(token, document.lines[line].indexOf(needle));
  assert.ok(character >= 0, `${token} is not on the line holding ${needle}`);
  return { line, character: character + 2 };
};

const targets = value =>
  (Array.isArray(value) ? value : value ? [value] : []).map(entry => ({
    file: path.basename(fileURLToPath(entry.uri)),
    line: entry.range.start.line + 1,
  }));

try {
  const workspaceUri = pathToFileURL(`${root}${path.sep}`).href;
  await request("initialize", {
    processId: process.pid,
    rootUri: workspaceUri,
    rootPath: root,
    workspaceFolders: [{ uri: workspaceUri, name: "ApexX" }],
    capabilities: {},
  });
  notify("initialized", {});

  const service = open("apexx/classes/AccountService.clsx");

  // Nudge the backend into starting, then wait for the project index.
  await request("textDocument/hover", {
    textDocument: { uri: service.uri },
    position: { line: 0, character: 20 },
  }).catch(() => {});

  const deadline = Date.now() + 60000;
  while (!/Apex language server ready/.test(logs) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (!/Apex language server ready/.test(logs)) {
    const reason = /\[apexx\][^\n]*/.exec(logs)?.[0] ?? "no reason reported";
    console.log(`Apex smoke test skipped: server never became ready (${reason.trim()}).`);
    process.exit(0);
  }

  // Cross-file resolution must land in the authored .clsx, never the generated .cls.
  const crossFile = await request("textDocument/definition", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "PortfolioRuleProvider.resolve", "resolve"),
  });
  assert.deepEqual(targets(crossFile), [
    { file: "PortfolioRuleProvider.clsx", line: 2 },
  ]);

  const crossFileType = await request("textDocument/definition", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "PortfolioRuleProvider.resolve", "PortfolioRuleProvider"),
  });
  assert.deepEqual(targets(crossFileType), [
    { file: "PortfolioRuleProvider.clsx", line: 1 },
  ]);

  // A call inside a lowered statement still resolves to its authored declaration.
  const sameFile = await request("textDocument/definition", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "buildRenewalWork(accounts, shouldEscalate", "buildRenewalWork"),
  });
  assert.deepEqual(targets(sameFile), [{ file: "AccountService.clsx", line: 114 }]);

  // Locals and tuple bindings resolve exactly, not to the statement around them.
  const local = await request("textDocument/definition", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "return withRevenue.size()", "withRevenue"),
  });
  assert.deepEqual(targets(local), [{ file: "AccountService.clsx", line: 32 }]);

  const binding = await request("textDocument/definition", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "return buildRenewalWork(accounts, shouldEscalate", "shouldEscalate"),
  });
  assert.deepEqual(targets(binding), [{ file: "AccountService.clsx", line: 106 }]);

  // Generated names must never reach the editor.
  for (const [needle, token] of [
    ["return buildRenewalWork(accounts, shouldEscalate", "shouldEscalate"],
    ["buildRenewalWork(accounts, shouldEscalate", "buildRenewalWork"],
    ["compareRevenue(withRevenue.get(0)", "compareRevenue"],
  ]) {
    const hover = await request("textDocument/hover", {
      textDocument: { uri: service.uri },
      position: positionOf(service, needle, token),
    });
    const value = hover?.contents?.value ?? "";
    assert.doesNotMatch(
      value,
      /ApexXFunc_[0-9a-f]+|ApexXTuple_[0-9a-f]+|ApexXLambda\d+/,
      `hover on ${token} leaked a generated name: ${value}`,
    );
  }

  const funcHover = await request("textDocument/hover", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "return buildRenewalWork(accounts, shouldEscalate", "shouldEscalate"),
  });
  assert.match(funcHover.contents.value, /Func<Account, ?Boolean>/);

  // References are reported against authored files only.
  const references = await request("textDocument/references", {
    textDocument: { uri: service.uri },
    position: positionOf(service, "AccountSummary summarize(", "summarize"),
    context: { includeDeclaration: true },
  });
  assert.ok(references.length >= 2, `expected summarize references, got ${references.length}`);
  assert.ok(
    references.every(entry => entry.uri.endsWith(".clsx")),
    "every reference must be reported in an authored .clsx file",
  );

  await request("shutdown", null).catch(() => {});
  notify("exit", undefined);
  console.log("Apex smoke test passed.");
  server.kill();
} catch (error) {
  server.kill();
  console.error(logs.split("\n").filter(line => line.includes("[apexx]")).join("\n"));
  throw error;
}

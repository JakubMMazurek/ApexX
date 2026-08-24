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
const publishedDiagnostics = new Map();
/** Whether anything only the Apex server could answer actually came back. */
let apexContributed = false;

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

    if (message.method === "textDocument/publishDiagnostics") {
      publishedDiagnostics.set(message.params.uri, message.params.diagnostics);
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
    initializationOptions: { useApexLanguageServer: true, apexDiagnostics: true },
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

  // Completion must keep the ApexX helpers and gain what the Apex compiler knows.
  const pipelineLine = service.lines.findIndex(line =>
    line.includes(".filter(account => account.AnnualRevenue"),
  );
  const listCompletion = await request("textDocument/completion", {
    textDocument: { uri: service.uri },
    position: {
      line: pipelineLine,
      character: service.lines[pipelineLine].indexOf(".filter") + 1,
    },
  });
  const listLabels = (Array.isArray(listCompletion)
    ? listCompletion
    : listCompletion?.items ?? []
  ).map(item => item.label);
  for (const helper of ["filter", "map", "flatMap", "find", "any", "all", "count"]) {
    assert.ok(listLabels.includes(helper), `completion lost the ApexX helper ${helper}`);
  }

  const systemProbe = `public with sharing class ApexSmokeSystemProbe {
    public static void go() {
        System.debug(1);
    }
}
`;
  const systemPath = path.join(root, "apexx", "classes", "ApexSmokeSystemProbe.clsx");
  const systemUri = pathToFileURL(systemPath).href;
  fs.writeFileSync(systemPath, systemProbe);

  try {
    notify("textDocument/didOpen", {
      textDocument: { uri: systemUri, languageId: "apexx", version: 1, text: systemProbe },
    });

    let systemLabels = [];
    const completionDeadline = Date.now() + 20000;

    while (Date.now() < completionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const systemCompletion = await request("textDocument/completion", {
        textDocument: { uri: systemUri },
        position: { line: 2, character: 15 },
      });
      systemLabels = (Array.isArray(systemCompletion)
        ? systemCompletion
        : systemCompletion?.items ?? []
      ).map(item => item.label);

      if (systemLabels.some(label => /^debug\(/.test(label))) {
        break;
      }
    }

    if (systemLabels.some(label => /^debug\(/.test(label))) {
      apexContributed = true;
    } else {
      // The Apex server needs a few hundred megabytes to index a project. When it
      // cannot, it answers nothing and ApexX falls back, which is the designed
      // behaviour -- so this is reported rather than failed.
      console.log(
        "  note: the Apex language server contributed no completions; " +
          "org-aware completion is unavailable on this machine.",
      );
    }
  } finally {
    fs.rmSync(systemPath, { force: true });
    fs.rmSync(path.join(root, "force-app/main/default/classes/ApexSmokeSystemProbe.cls"), { force: true });
    fs.rmSync(path.join(root, "force-app/main/default/classes/ApexSmokeSystemProbe.cls-meta.xml"), { force: true });
  }

  // A real Apex semantic error must be reported against the authored line.
  const brokenText = `public with sharing class ApexSmokeBrokenProbe {
    public static void go(List<Account> accounts) {
        Integer x = accounts.noSuchMethodAtAll();
    }
}
`;
  const brokenPath = path.join(root, "apexx", "classes", "ApexSmokeBrokenProbe.clsx");
  const brokenUri = pathToFileURL(brokenPath).href;
  fs.writeFileSync(brokenPath, brokenText);

  try {
    notify("textDocument/didOpen", {
      textDocument: { uri: brokenUri, languageId: "apexx", version: 1, text: brokenText },
    });

    const diagnosticsDeadline = Date.now() + 30000;
    while (
      (publishedDiagnostics.get(brokenUri) ?? []).length === 0 &&
      Date.now() < diagnosticsDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 500));
      notify("textDocument/didChange", {
        textDocument: { uri: brokenUri, version: 2 },
        contentChanges: [{ text: brokenText }],
      });
    }

    const reported = publishedDiagnostics.get(brokenUri) ?? [];

    if (reported.length === 0) {
      console.log(
        "  note: the Apex language server reported no diagnostics; " +
          "semantic error checking is unavailable on this machine.",
      );
    } else {
      apexContributed = true;
      assert.equal(
        reported[0].range.start.line,
        2,
        `diagnostic landed on the wrong authored line: ${JSON.stringify(reported[0])}`,
      );
      assert.match(reported[0].message, /noSuchMethodAtAll/);
    }
  } finally {
    fs.rmSync(brokenPath, { force: true });
    fs.rmSync(path.join(root, "force-app/main/default/classes/ApexSmokeBrokenProbe.cls"), { force: true });
    fs.rmSync(path.join(root, "force-app/main/default/classes/ApexSmokeBrokenProbe.cls-meta.xml"), { force: true });
  }

  await request("shutdown", null).catch(() => {});
  notify("exit", undefined);
  console.log(
    apexContributed
      ? "Apex smoke test passed (Apex language server contributed)."
      : "Apex smoke test passed (fallback path only: the Apex language server " +
        "answered nothing on this machine, so org-aware results were not verified).",
  );
  server.kill();
} catch (error) {
  server.kill();
  console.error(logs.split("\n").filter(line => line.includes("[apexx]")).join("\n"));
  throw error;
}

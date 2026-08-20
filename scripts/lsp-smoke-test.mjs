import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "packages", "language-server", "dist", "server.js");
const workspaceUri = pathToFileURL(`${root}${path.sep}`).href;

const server = spawn(process.execPath, [serverPath, "--stdio"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdoutBuffer = Buffer.alloc(0);
let stderr = "";
const pending = new Map();

server.stderr.on("data", chunk => {
  stderr += chunk.toString("utf8");
});

server.stdout.on("data", chunk => {
  stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
  readMessages();
});

server.on("exit", code => {
  for (const { reject } of pending.values()) {
    reject(new Error(`Language server exited with code ${code}. ${stderr}`));
  }
  pending.clear();
});

try {
  await request("initialize", {
    processId: process.pid,
    rootUri: workspaceUri,
    workspaceFolders: [{ uri: workspaceUri, name: "ApexX" }],
    capabilities: {},
  });
  notify("initialized", {});

  const listMembers = await completionsFor(
    "ListMemberProbe",
    withCursor(`public with sharing class ListMemberProbe {
    public static List<String> accountNames(List<Account> accounts) {
        accounts.__CURSOR__
        return new List<String>();
    }
}
`),
  );
  assertHasLabels(listMembers, ["filter", "map", "flatMap", "find", "any", "all", "count", "add"]);

  const mapInputMembers = await completionsFor(
    "MapInputProbe",
    withCursor(`public with sharing class MapInputProbe {
    public static List<String> accountNames(List<Account> accounts) {
        List<String> names = accounts.map(a => a.__CURSOR__);
        return names;
    }
}
`),
  );
  assertHasLabels(mapInputMembers, ["AccountNumber", "Name", "Rating"]);

  const filterMapMembers = await completionsFor(
    "FilterMapProbe",
    withCursor(`public with sharing class FilterMapProbe {
    public static List<String> hotAccountNames(List<Account> accounts) {
        return accounts.filter(a => a.Rating == 'Hot')
            .map(a => a.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(filterMapMembers, ["AccountNumber", "Name", "Rating"]);

  const multilineChainMembers = await completionsFor(
    "MultilineChainProbe",
    withCursor(`public with sharing class MultilineChainProbe {
    public static List<String> hotAccountNames(List<Account> accounts) {
        List<String> names = accounts
            .filter(account => account.Rating == 'Hot')
            .map(selected => selected.__CURSOR__);
        return names;
    }
}
`),
  );
  assertHasLabels(multilineChainMembers, ["AccountNumber", "Name", "Rating"]);
  assertNoLabels(multilineChainMembers, ["contains", "toUpperCase"]);

  const mappedValueMembers = await completionsFor(
    "MappedValueProbe",
    withCursor(`public with sharing class MappedValueProbe {
    public static List<String> accountNumbers(List<Account> accounts) {
        return accounts.map(a => a.AccountNumber)
            .filter(value => value.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(mappedValueMembers, ["contains", "length", "toUpperCase"]);
  assertNoLabels(mappedValueMembers, ["AccountNumber", "Rating"]);

  const assignmentMappedValueMembers = await completionsFor(
    "AssignmentMappedValueProbe",
    withCursor(`public with sharing class AssignmentMappedValueProbe {
    public static List<String> accountNumbers(List<Account> accounts) {
        List<String> accountNumbers = accounts
            .map(a => a.AccountNumber)
            .filter(accountNumber => accountNumber.__CURSOR__);
        return accountNumbers;
    }
}
`),
  );
  assertHasLabels(assignmentMappedValueMembers, ["contains", "length", "toUpperCase"]);
  assertNoLabels(assignmentMappedValueMembers, ["AccountNumber", "Rating"]);

  const secondMapStringMembers = await completionsFor(
    "SecondMapStringProbe",
    withCursor(`public with sharing class SecondMapStringProbe {
    public static List<String> upperAccountNumbers(List<Account> accounts) {
        return accounts
            .map(a => a.AccountNumber)
            .map(accountNumber => accountNumber.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(secondMapStringMembers, ["contains", "length", "toUpperCase"]);
  assertNoLabels(secondMapStringMembers, ["AccountNumber", "Rating"]);

  const secondMapDateMembers = await completionsFor(
    "SecondMapDateProbe",
    withCursor(`public with sharing class SecondMapDateProbe {
    public static List<Integer> createdYears(List<Account> accounts) {
        return accounts
            .map(a => a.CreatedDate.date())
            .map(createdDate => createdDate.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(secondMapDateMembers, ["addDays", "month", "year"]);
  assertNoLabels(secondMapDateMembers, ["AccountNumber", "Rating", "toUpperCase"]);

  const anyMembers = await completionsFor(
    "AnyProbe",
    withCursor(`public with sharing class AnyProbe {
    public static Boolean hasHot(List<Account> accounts) {
        return accounts.any(account => account.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(anyMembers, ["AccountNumber", "Name", "Rating"]);

  const findMembers = await completionsFor(
    "FindProbe",
    withCursor(`public with sharing class FindProbe {
    public static Account firstHot(List<Account> accounts) {
        return accounts.find(account => account.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(findMembers, ["AccountNumber", "Name", "Rating"]);

  const flatMapMembers = await completionsFor(
    "FlatMapProbe",
    withCursor(`public with sharing class FlatMapProbe {
    public static List<Contact> contacts(List<Account> accounts) {
        return accounts.flatMap(account => account.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(flatMapMembers, ["Contacts", "AccountNumber", "Name"]);

  const flatMappedContactMembers = await completionsFor(
    "FlatMappedContactProbe",
    withCursor(`public with sharing class FlatMappedContactProbe {
    public static List<String> contactEmails(List<Account> accounts) {
        return accounts.flatMap(account => account.Contacts)
            .map(contact => contact.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(flatMappedContactMembers, ["Email", "FirstName", "LastName"]);
  assertNoLabels(flatMappedContactMembers, ["AccountNumber", "Rating"]);

  const intermediateListMembers = await completionsFor(
    "IntermediateListProbe",
    withCursor(`public with sharing class IntermediateListProbe {
    public static List<String> hotAccountNames(List<Account> accounts) {
        List<Account> hotAccounts = accounts.filter(a => a.Rating == 'Hot');
        return hotAccounts.map(account => account.__CURSOR__);
    }
}
`),
  );
  assertHasLabels(intermediateListMembers, ["AccountNumber", "Name", "Rating"]);
  assertNoLabels(intermediateListMembers, ["contains", "toUpperCase"]);

  const blockMapInputMembers = await completionsFor(
    "BlockMapInputProbe",
    withCursor(`public with sharing class BlockMapInputProbe {
    public static List<AccountWorkItem> buildWork(List<Account> accounts, Func<Account, Boolean> shouldEscalate) {
        return accounts.map(account => {
            Boolean escalate = shouldEscalate(account);
            String name = account.__CURSOR__;
            return new AccountWorkItem(account.Id, name, escalate ? 'High' : 'Normal');
        });
    }
}
`),
  );
  assertHasLabels(blockMapInputMembers, ["AccountNumber", "Name", "Rating"]);
  assertNoLabels(blockMapInputMembers, ["contains", "toUpperCase"]);

  const funcParameterMembers = await completionsFor(
    "FuncParameterProbe",
    withCursor(`public with sharing class FuncParameterProbe {
    public static List<AccountWorkItem> buildWork(List<Account> accounts, Func<Account, Boolean> shouldEscalate) {
        shouldEscalate.__CURSOR__
        return new List<AccountWorkItem>();
    }
}
`),
  );
  assertHasLabels(funcParameterMembers, ["invoke"]);

  const reassignedFuncLambdaMembers = await completionsFor(
    "ReassignedFuncLambdaProbe",
    withCursor(`public with sharing class ReassignedFuncLambdaProbe {
    public static List<AccountWorkItem> buildWork(List<Account> accounts, String mode) {
        Func<Account, Boolean> shouldEscalate;
        if (mode == 'Revenue') {
            shouldEscalate = (account) => account.__CURSOR__;
        }
        return new List<AccountWorkItem>();
    }
}
`),
  );
  assertHasLabels(reassignedFuncLambdaMembers, ["AnnualRevenue", "AccountNumber", "Rating"]);

  await request("shutdown", null);
  notify("exit", undefined);
  console.log("LSP smoke test passed.");
} catch (error) {
  server.kill();
  throw error;
}

function readMessages() {
  const separator = Buffer.from("\r\n\r\n");

  while (true) {
    const headerEnd = stdoutBuffer.indexOf(separator);
    if (headerEnd < 0) {
      return;
    }

    const header = stdoutBuffer.slice(0, headerEnd).toString("ascii");
    const contentLength = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
    if (!contentLength) {
      throw new Error(`Missing Content-Length in LSP response: ${header}`);
    }

    const bodyStart = headerEnd + separator.length;
    const bodyEnd = bodyStart + Number(contentLength);
    if (stdoutBuffer.length < bodyEnd) {
      return;
    }

    const body = stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    stdoutBuffer = stdoutBuffer.slice(bodyEnd);
    const message = JSON.parse(body);

    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timeout } = pending.get(message.id);
      clearTimeout(timeout);
      pending.delete(message.id);

      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    }
  }
}

function request(method, params) {
  const id = nextId;
  nextId += 1;
  send({ jsonrpc: "2.0", id, method, params });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. ${stderr}`));
    }, 5000);

    pending.set(id, { resolve, reject, timeout });
  });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function send(message) {
  const payload = JSON.stringify(message);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`);
  server.stdin.write(payload);
}

async function completionsFor(name, probe) {
  const uri = pathToFileURL(
    path.join(root, "apexx", "classes", `${name}.clsx`),
  ).href;

  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "apexx",
      version: 1,
      text: probe.text,
    },
  });

  const result = await request("textDocument/completion", {
    textDocument: { uri },
    position: probe.position,
  });

  return Array.isArray(result) ? result : result.items;
}

function withCursor(source) {
  const marker = "__CURSOR__";
  const offset = source.indexOf(marker);
  assert.notEqual(offset, -1, "Probe is missing cursor marker.");

  const text = source.replace(marker, "");
  return {
    text,
    position: offsetToPosition(text, offset),
  };
}

function offsetToPosition(source, offset) {
  const lines = source.slice(0, offset).split(/\n/);

  return {
    line: lines.length - 1,
    character: lines.at(-1).replace(/\r$/, "").length,
  };
}

function assertHasLabels(items, expectedLabels) {
  const labels = new Set(items.map(item => item.label));

  for (const label of expectedLabels) {
    assert.ok(labels.has(label), `Expected completion '${label}'.`);
  }
}

function assertNoLabels(items, unexpectedLabels) {
  const labels = new Set(items.map(item => item.label));

  for (const label of unexpectedLabels) {
    assert.ok(!labels.has(label), `Did not expect completion '${label}'.`);
  }
}

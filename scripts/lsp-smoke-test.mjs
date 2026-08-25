import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
const publishedDiagnostics = new Map();
const diagnosticWaiters = new Set();

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
  const { capabilities } = await request("initialize", {
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

  const blockFuncLambdaMembers = await completionsFor(
    "BlockFuncLambdaProbe",
    withCursor(`public with sharing class BlockFuncLambdaProbe {
    public static Func<Account, Boolean> resolve(Decimal threshold) {
        Func<Account, Boolean> matches = (account) => {
            Decimal revenue = account.AnnualRevenue == null ? 0 : account.AnnualRevenue;
            Boolean selected = account.__CURSOR__;
            return revenue >= threshold && selected;
        };
        return matches;
    }
}
`),
  );
  assertHasLabels(blockFuncLambdaMembers, ["AnnualRevenue", "AccountNumber", "Rating"]);

  const funcHoverProbe = withCursor(`public with sharing class HoverProbe {
    public static void inspect() {
        Func__CURSOR__<Account, Boolean> matches;
    }
}
`);
  const hoverUri = pathToFileURL(
    path.join(root, "apexx", "classes", "HoverProbe.clsx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri: hoverUri,
      languageId: "apexx",
      version: 1,
      text: funcHoverProbe.text,
    },
  });
  const funcHover = await request("textDocument/hover", {
    textDocument: { uri: hoverUri },
    position: funcHoverProbe.position,
  });
  assert.match(funcHover.contents.value, /strongly typed function value/i);

  // Language-service features built on the offset-preserving Apex projection.
  const serviceSource = `public with sharing class ServiceProbe {
    private static Decimal LIMIT_VALUE = 10;

    @UserFriendlyError
    public static List<Account> pick(List<Account> accounts, String mode = 'Revenue') {
        List<Account> chosen = accounts.filter(a => a.AnnualRevenue > LIMIT_VALUE);
        return summarise(chosen, mode);
    }

    public static List<Account> summarise(List<Account> rows, String mode) {
        return rows;
    }
}
`;
  const serviceUri = pathToFileURL(
    path.join(root, "apexx", "classes", "ServiceProbe.clsx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: serviceUri, languageId: "apexx", version: 1, text: serviceSource },
  });

  const serviceLines = serviceSource.split("\n");
  const locate = (needle, offset = 1) => {
    for (let line = 0; line < serviceLines.length; line += 1) {
      const character = serviceLines[line].indexOf(needle);

      if (character >= 0) {
        return { line, character: character + offset };
      }
    }

    throw new Error(`probe source is missing ${needle}`);
  };

  const outline = await request("textDocument/documentSymbol", {
    textDocument: { uri: serviceUri },
  });
  assert.equal(outline.length, 1, "expected a single top-level type in the outline");
  assert.equal(outline[0].name, "ServiceProbe");
  const outlineChildren = (outline[0].children ?? []).map(child => child.name);
  for (const expected of ["LIMIT_VALUE", "pick", "summarise"]) {
    assert.ok(
      outlineChildren.includes(expected),
      `outline is missing ${expected}: ${outlineChildren.join(", ")}`,
    );
  }
  assert.match(
    (outline[0].children ?? []).find(child => child.name === "summarise").detail,
    /List<Account> summarise\(List<Account> rows, String mode\)/,
  );

  const definition = await request("textDocument/definition", {
    textDocument: { uri: serviceUri },
    position: locate("return summarise(", 8),
  });
  assert.ok(definition, "expected a definition for summarise");
  assert.equal(
    definition.range.start.line,
    serviceLines.findIndex(line => line.includes("List<Account> summarise(")),
    "definition should land on the summarise declaration",
  );

  const localHover = await request("textDocument/hover", {
    textDocument: { uri: serviceUri },
    position: locate("List<Account> chosen", 15),
  });
  assert.match(localHover.contents.value, /List<Account> chosen/);
  // Hover echoes the declaration only, the way Apex tooling reports it.
  assert.doesNotMatch(localHover.contents.value, /local variable|parameter in/);

  // A lambda parameter must resolve to the lambda that introduces it, and be typed
  // from the receiver list -- not to a same-named parameter of an unrelated method.
  const shadowSource = `public with sharing class ShadowProbe {
    public static Account save(Account account, Boolean validate) {
        return account;
    }

    public static List<Account> withRevenue(List<Account> rows) {
        return rows.filter(account => account.AnnualRevenue != null);
    }
}
`;
  const shadowUri = pathToFileURL(
    path.join(root, "apexx", "classes", "ShadowProbe.clsx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: shadowUri, languageId: "apexx", version: 1, text: shadowSource },
  });

  const shadowLines = shadowSource.split("\n");
  const lambdaLine = shadowLines.findIndex(line => line.includes("rows.filter(account"));
  const lambdaPosition = {
    line: lambdaLine,
    character: shadowLines[lambdaLine].indexOf("account =>") + 3,
  };

  const lambdaHover = await request("textDocument/hover", {
    textDocument: { uri: shadowUri },
    position: lambdaPosition,
  });
  assert.match(
    lambdaHover.contents.value,
    /Account account/,
    "a lambda parameter should be typed from the receiver list",
  );

  const lambdaDefinition = await request("textDocument/definition", {
    textDocument: { uri: shadowUri },
    position: lambdaPosition,
  });
  assert.equal(
    (Array.isArray(lambdaDefinition) ? lambdaDefinition[0] : lambdaDefinition).range.start
      .line,
    lambdaLine,
    "a lambda parameter must not resolve to a parameter of another method",
  );

  // The same name declared in a different method stays independent.
  const otherMethodLine = shadowLines.findIndex(line => line.includes("Account save("));
  const otherHover = await request("textDocument/hover", {
    textDocument: { uri: shadowUri },
    position: {
      line: otherMethodLine,
      character: shadowLines[otherMethodLine].indexOf("Account account") + 9,
    },
  });
  assert.match(otherHover.contents.value, /Account account/);

  const signature = await request("textDocument/signatureHelp", {
    textDocument: { uri: serviceUri },
    position: locate("return summarise(", 25),
  });
  assert.match(signature.signatures[0].label, /summarise\(List<Account> rows, String mode\)/);

  const references = await request("textDocument/references", {
    textDocument: { uri: serviceUri },
    position: locate("List<Account> chosen", 15),
    context: { includeDeclaration: true },
  });
  assert.ok(references.length >= 2, `expected chosen to have references, got ${references.length}`);

  const renamed = await request("textDocument/rename", {
    textDocument: { uri: serviceUri },
    position: locate("List<Account> chosen", 15),
    newName: "selected",
  });
  assert.ok(
    (renamed.changes[serviceUri] ?? []).length >= 2,
    "rename should edit every occurrence",
  );

  // A decorator annotation resolves to the class that implements it, in its own file.
  const decorator = await request("textDocument/definition", {
    textDocument: { uri: serviceUri },
    position: locate("@UserFriendlyError", 3),
  });
  const decoratorTargets = Array.isArray(decorator) ? decorator : [decorator];
  assert.ok(
    decoratorTargets.some(target => target?.uri.endsWith("UserFriendlyError.clsx")),
    "@UserFriendlyError should resolve to UserFriendlyError.clsx",
  );

  // A tuple destructuring binding keeps its whole type: the comma inside
  // Func<Account, Boolean> must not be read as a separator between bindings.
  const tupleSource = `public with sharing class TupleProbe {
    public static String describe(String mode) {
        (
            Func<Account, Boolean> shouldEscalate,
            String escalationReason,
            Decimal _
        ) = PortfolioRuleProvider.resolve(mode);

        return escalationReason;
    }
}
`;
  const tupleUri = pathToFileURL(
    path.join(root, "apexx", "classes", "TupleProbe.clsx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: tupleUri, languageId: "apexx", version: 1, text: tupleSource },
  });

  const tupleLines = tupleSource.split("\n");
  const escalateLine = tupleLines.findIndex(line => line.includes("shouldEscalate,"));
  const tupleHover = await request("textDocument/hover", {
    textDocument: { uri: tupleUri },
    position: {
      line: escalateLine,
      character: tupleLines[escalateLine].indexOf("shouldEscalate") + 3,
    },
  });
  assert.match(
    tupleHover.contents.value,
    /Func<Account, ?Boolean> shouldEscalate/,
    `tuple binding lost part of its type: ${tupleHover.contents.value}`,
  );

  // Cross-file: a static call on a type declared in a different file.
  const consumerPath = path.join(root, "apexx", "classes", "AccountSignalConsumer.clsx");
  const consumerText = readFileSync(consumerPath, "utf8");
  const consumerUri = pathToFileURL(consumerPath).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: consumerUri, languageId: "apexx", version: 1, text: consumerText },
  });

  const consumerLines = consumerText.split("\n");
  const callLine = consumerLines.findIndex(line =>
    line.includes("AccountSignalProvider.calculate"),
  );
  assert.ok(callLine >= 0, "expected AccountSignalConsumer to call AccountSignalProvider");

  const crossFile = await request("textDocument/definition", {
    textDocument: { uri: consumerUri },
    position: {
      line: callLine,
      character: consumerLines[callLine].indexOf("calculate") + 2,
    },
  });
  const crossTargets = Array.isArray(crossFile) ? crossFile : [crossFile];
  assert.ok(
    crossTargets.some(target => target?.uri.endsWith("AccountSignalProvider.clsx")),
    "calculate should resolve into AccountSignalProvider.clsx",
  );

  // A diagnostic has to land on the statement that caused it. Pipeline stages that
  // add or remove lines used to slide the squiggle onto a neighbouring statement.
  const summaryPath = path.join(root, "apexx", "classes", "AccountService.clsx");
  const summaryText = readFileSync(summaryPath, "utf8").replace(
    ".map(account => account.Name);",
    ".map(account => account.Name != null);",
  );
  const summaryUri = pathToFileURL(summaryPath).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: summaryUri, languageId: "apexx", version: 1, text: summaryText },
  });

  const summaryDiagnostics = await waitForDiagnostics(summaryUri, entries =>
    entries.some(entry => /List chain returns List<Boolean>/.test(entry.message)),
  );
  const chainDiagnostic = summaryDiagnostics.find(entry =>
    /List chain returns List<Boolean>/.test(entry.message),
  );
  const summaryLines = summaryText.split("\n");
  assert.equal(
    chainDiagnostic.range.start.character,
    summaryLines[chainDiagnostic.range.start.line].search(/\S/),
    "the squiggle should start on the code, not on its indentation",
  );
  assert.match(
    summaryLines[chainDiagnostic.range.start.line],
    /List<String> names = accounts/,
    `chain diagnostic landed on ${JSON.stringify(summaryLines[chainDiagnostic.range.start.line])}`,
  );
  assert.match(
    summaryLines[chainDiagnostic.range.end.line],
    /\.map\(account => account\.Name != null\);/,
    "chain diagnostic should span the whole chain",
  );
  assert.deepEqual(
    summaryDiagnostics
      .filter(entry => entry.source === "apex-parser")
      .map(entry => entry.message),
    [],
    "a front-end error should not publish cascade parse errors from the generated Apex",
  );

  // A lambda whose body contradicts its Func declaration is reported on the returned
  // expression, in the authored file.
  const lambdaPath = path.join(root, "apexx", "classes", "AccountService.clsx");
  const lambdaText = readFileSync(lambdaPath, "utf8").replace(
    "return account.Rating == 'Hot' && hasNumber;",
    "return 10;",
  );
  assert.notEqual(lambdaText, readFileSync(lambdaPath, "utf8"), "lambda probe did not apply");
  const lambdaUri = pathToFileURL(lambdaPath).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: lambdaUri, languageId: "apexx", version: 2, text: lambdaText },
  });

  const lambdaDiagnostics = await waitForDiagnostics(lambdaUri, entries =>
    entries.some(entry => /must return Boolean/.test(entry.message)),
  );
  const lambdaDiagnostic = lambdaDiagnostics.find(entry =>
    /must return Boolean/.test(entry.message),
  );
  assert.match(
    lambdaDiagnostic.message,
    /Func<Account, Boolean> must return Boolean, but this returns Integer\./,
  );
  const lambdaLines = lambdaText.split("\n");
  assert.equal(
    lambdaLines[lambdaDiagnostic.range.start.line].slice(
      lambdaDiagnostic.range.start.character,
      lambdaDiagnostic.range.end.character,
    ),
    "10",
    "the squiggle should sit on the returned expression",
  );

  // An .apexx script is checked as an anonymous block. The compilation-unit rule
  // would reject every statement in it, so a clean script must publish nothing.
  const scriptUri = pathToFileURL(
    path.join(root, "apexx", "scripts", "DiagnosticProbe.apexx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri: scriptUri,
      languageId: "apexx",
      version: 1,
      text: `List<Account> accounts = [SELECT Id, Name FROM Account LIMIT 5];
List<String> names = accounts.map(account => account.Name);
System.debug(names);
`,
    },
  });
  assert.deepEqual(
    await waitForDiagnostics(scriptUri, () => true),
    [],
    "a valid .apexx script should not be reported against the class grammar",
  );

  // ApexX errors are still reported in the script, at the authored position.
  const brokenScriptUri = pathToFileURL(
    path.join(root, "apexx", "scripts", "BrokenProbe.apexx"),
  ).href;
  const brokenScript = `List<Account> accounts = [SELECT Id, Name FROM Account LIMIT 5];
List<String> names = accounts.map(account => account.Name != null);
System.debug(names);
`;
  notify("textDocument/didOpen", {
    textDocument: {
      uri: brokenScriptUri,
      languageId: "apexx",
      version: 1,
      text: brokenScript,
    },
  });
  const scriptDiagnostics = await waitForDiagnostics(
    brokenScriptUri,
    entries => entries.length > 0,
  );
  assert.ok(
    scriptDiagnostics.some(entry => entry.source !== "apex-parser"),
    `expected an ApexX diagnostic, got ${JSON.stringify(scriptDiagnostics)}`,
  );
  assert.ok(
    scriptDiagnostics.some(entry =>
      /List chain returns List<Boolean>/.test(entry.message),
    ),
    `expected the chain-type error, got ${JSON.stringify(scriptDiagnostics)}`,
  );
  assert.match(
    brokenScript.split("\n")[scriptDiagnostics[0].range.start.line],
    /List<String> names = accounts/,
    "the script diagnostic should land on the authored line",
  );

  // The language service answers a script too. Completion is inferred from the
  // source text, and the symbol model parses the block with the anonymous rule.
  const serviceScript = withCursor(`List<Account> accounts = [SELECT Id, Name, AnnualRevenue FROM Account LIMIT 5];
Decimal threshold = 1000;
List<String> names = accounts.filter(account => account.__CURSOR__AnnualRevenue > threshold).map(account => account.Name);
System.debug(names.size() + threshold);
`);
  const serviceScriptUri = pathToFileURL(
    path.join(root, "apexx", "scripts", "ServiceProbe.apexx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri: serviceScriptUri,
      languageId: "apexx",
      version: 1,
      text: serviceScript.text,
    },
  });

  const scriptMembers = await request("textDocument/completion", {
    textDocument: { uri: serviceScriptUri },
    position: serviceScript.position,
  });
  assertHasLabels(itemsOf(scriptMembers), ["AnnualRevenue", "Name", "AccountNumber"]);

  // Hover on a script local reports its declared type, from the block-level
  // declaration the model now collects.
  const thresholdOffset = serviceScript.text.indexOf("threshold + ") >= 0
    ? serviceScript.text.indexOf("threshold + ")
    : serviceScript.text.lastIndexOf("threshold");
  const thresholdLine = serviceScript.text.slice(0, thresholdOffset).split("\n").length - 1;
  const thresholdCharacter =
    thresholdOffset - (serviceScript.text.lastIndexOf("\n", thresholdOffset - 1) + 1);
  const scriptHover = await request("textDocument/hover", {
    textDocument: { uri: serviceScriptUri },
    position: { line: thresholdLine, character: thresholdCharacter },
  });
  assert.match(
    scriptHover?.contents?.value ?? "",
    /Decimal threshold/,
    `expected the local's declared type, got ${JSON.stringify(scriptHover)}`,
  );

  const scriptOutline = await request("textDocument/documentSymbol", {
    textDocument: { uri: serviceScriptUri },
  });
  assert.ok(
    scriptOutline.some(symbol => symbol.name === "accounts"),
    `expected the script's declarations in the outline, got ${JSON.stringify(scriptOutline)}`,
  );

  // Definition, references and rename resolve against the block's own scope.
  const scriptDefinition = await request("textDocument/definition", {
    textDocument: { uri: serviceScriptUri },
    position: { line: thresholdLine, character: thresholdCharacter },
  });
  assert.equal(scriptDefinition.uri, serviceScriptUri);
  assert.equal(
    serviceScript.text.split("\n")[scriptDefinition.range.start.line].slice(
      scriptDefinition.range.start.character,
      scriptDefinition.range.end.character,
    ),
    "threshold",
    "definition should land on the script's own declaration",
  );

  const scriptReferences = await request("textDocument/references", {
    textDocument: { uri: serviceScriptUri },
    position: { line: thresholdLine, character: thresholdCharacter },
    context: { includeDeclaration: true },
  });
  assert.equal(
    scriptReferences.length,
    3,
    `expected the declaration and both uses, got ${JSON.stringify(scriptReferences)}`,
  );

  const scriptRename = await request("textDocument/rename", {
    textDocument: { uri: serviceScriptUri },
    position: { line: thresholdLine, character: thresholdCharacter },
    newName: "minimum",
  });
  assert.equal(scriptRename.changes[serviceScriptUri].length, 3);

  // A script can navigate into an authored class it calls.
  const crossFileScript = `(Func<Account, Boolean> rule, String reason, Decimal threshold) = PortfolioRuleProvider.resolve('Revenue Exposure');
System.debug(reason + threshold);
`;
  const crossFileUri = pathToFileURL(
    path.join(root, "apexx", "scripts", "CrossFileProbe.apexx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri: crossFileUri,
      languageId: "apexx",
      version: 1,
      text: crossFileScript,
    },
  });
  const crossFileDefinition = await request("textDocument/definition", {
    textDocument: { uri: crossFileUri },
    position: {
      line: 0,
      character: crossFileScript.indexOf("resolve('Revenue"),
    },
  });
  const crossFileTargets = Array.isArray(crossFileDefinition)
    ? crossFileDefinition
    : [crossFileDefinition];
  assert.ok(
    crossFileTargets.some(target =>
      target?.uri?.endsWith("PortfolioRuleProvider.clsx"),
    ),
    `expected a jump into PortfolioRuleProvider.clsx, got ${JSON.stringify(crossFileDefinition)}`,
  );

  // A coded diagnostic arrives as data, not as a message prefix, so the editor can
  // show the code and link it to its documentation. An uncoded one carries neither.
  const codedPath = path.join(root, "apexx", "classes", "CodedProbe.clsx");
  const codedUri = pathToFileURL(codedPath).href;
  const codedText = `public with sharing class CodedProbe {
    public static (Decimal, Integer) split() {
        return ('nope', 2);
    }

    public static void run(List<Account> accounts) {
        Func<Account, Boolean> rule = (account) => account.Name;
        System.debug(rule);
        System.debug(split());
    }
}
`;
  notify("textDocument/didOpen", {
    textDocument: { uri: codedUri, languageId: "apexx", version: 1, text: codedText },
  });

  const codedDiagnostics = await waitForDiagnostics(codedUri, entries =>
    entries.length >= 2,
  );
  const tupleEntry = codedDiagnostics.find(entry => entry.code === "APXX2412");
  assert.ok(
    tupleEntry,
    `expected a diagnostic carrying code APXX2412, got ${JSON.stringify(codedDiagnostics)}`,
  );
  assert.equal(
    tupleEntry.message,
    "Tuple element 1 expects Decimal, but received String.",
    "the code should not be repeated inside the message",
  );
  assert.match(tupleEntry.codeDescription?.href ?? "", /#diagnostic-reference$/);

  const lambdaEntry = codedDiagnostics.find(entry => /must return Boolean/.test(entry.message));
  assert.ok(lambdaEntry, "expected the lambda diagnostic too");
  assert.equal(lambdaEntry.code, undefined, "an uncoded diagnostic must not invent one");
  assert.equal(lambdaEntry.codeDescription, undefined);

  // Completion in the places that used to return nothing: a static receiver, an
  // annotation name, and an annotation's arguments. Checked in a script and in a class,
  // because the Apex-language-server path that could otherwise cover a static receiver
  // is optional and never available to a script.
  for (const [label, file] of [["script", "apexx/scripts/CompletionProbe.apexx"], ["class", "apexx/classes/CompletionProbe.clsx"]]) {
    const statics = await completionsAt(file, "Datetime t = Datetime.", "Datetime.");
    assert.ok(
      statics.some(item => item.label === "now"),
      `${label}: Datetime. should offer statics, got ${JSON.stringify(statics.map(i => i.label))}`,
    );
    assert.ok(
      !statics.some(item => item.label === "addDays"),
      `${label}: a static receiver must not offer instance members`,
    );

    const annotations = await completionsAt(file, "@", "@");
    assert.ok(
      annotations.some(item => item.label === "UserFriendlyError"),
      `${label}: @ should offer the workspace decorators`,
    );
    assert.ok(
      annotations.some(item => item.label === "AuraEnabled"),
      `${label}: @ should offer the native annotations`,
    );

    const parameters = await completionsAt(file, "@UserFriendlyError(", "@UserFriendlyError(");
    assert.deepEqual(
      parameters.map(item => item.label).sort(),
      ["expectedTypes", "message"],
      `${label}: decorator parameters come from the keys it reads`,
    );

    const native = await completionsAt(file, "@AuraEnabled(", "@AuraEnabled(");
    assert.ok(
      native.some(item => item.label === "cacheable"),
      `${label}: @AuraEnabled( should offer cacheable`,
    );

    // An instance receiver still resolves to instance members.
    const instance = await completionsAt(file, "Datetime t = Datetime.now();\nInteger h = t.", "h = t.");
    assert.ok(
      instance.some(item => item.label === "addDays"),
      `${label}: an instance receiver should still offer instance members`,
    );
  }

  // Where an identifier is expected, the offer has to be the same shape the Apex
  // extension gives a .cls file: what is in scope, then the types, then keywords.
  // Checked in a script and in a class, because a script never gets the optional
  // Apex language server and so is served entirely by ApexX's own tables.
  for (const [label, file, text] of [
    [
      "script",
      "apexx/scripts/IdentifierProbe.apexx",
      "Datetime t = Datetime.now();\nSys",
    ],
    [
      "class",
      "apexx/classes/IdentifierProbe.clsx",
      `public with sharing class IdentifierProbe {
    public static void run() {
        Datetime t = Datetime.now();
        Sys
    }
}
`,
    ],
  ]) {
    const globals = await completionsAt(file, text, "Sys");
    assertHasLabels(globals, [
      "System",
      "Schema",
      "Set",
      "SObject",
      "String",
    ]);
    assert.ok(
      globals.some(item => item.label === "t"),
      `${label}: a local in scope should be offered, got ${JSON.stringify(
        globals.map(item => item.label),
      ).slice(0, 400)}`,
    );
    assertHasLabels(globals, ["Math", "JSON", "Database", "Map", "List", "Integer"]);
    // The workspace's own types are identifiers too.
    assertHasLabels(globals, ["AccountService"]);
    // And the sObjects the cached schema describes.
    assertHasLabels(globals, ["Account", "Contact"]);
    // And the keywords.
    assertHasLabels(globals, ["return", "if", "for", "new"]);

    // Locals come before types, which come before keywords.
    const rank = name => globals.find(item => item.label === name)?.sortText ?? "";
    assert.ok(
      rank("t") < rank("System"),
      `${label}: a local should sort before a global type`,
    );
    assert.ok(
      rank("System") < rank("return"),
      `${label}: a type should sort before a keyword`,
    );
  }

  // Collections and primitives carry their own member tables, so a Map receiver is
  // no longer answered with nothing.
  const mapMembers = await completionsAt(
    "apexx/scripts/MapProbe.apexx",
    "Map<Id, Account> byId = new Map<Id, Account>();\nbyId.",
    "byId.",
  );
  assertHasLabels(mapMembers, ["get", "put", "keySet", "values", "containsKey", "size"]);

  const setMembers = await completionsAt(
    "apexx/scripts/SetProbe.apexx",
    "Set<Id> ids = new Set<Id>();\nids.",
    "ids.",
  );
  assertHasLabels(setMembers, ["add", "contains", "retainAll", "size"]);
  assertNoLabels(setMembers, ["keySet"]);

  const decimalMembers = await completionsAt(
    "apexx/scripts/DecimalProbe.apexx",
    "Decimal amount = 1.5;\namount.",
    "amount.",
  );
  assertHasLabels(decimalMembers, ["setScale", "intValue", "round"]);

  // A type declared in the workspace resolves to its own members, statically and
  // as an instance, rather than falling through to an empty sObject.
  const workspaceStatics = await completionsAt(
    "apexx/scripts/WorkspaceStaticProbe.apexx",
    "AccountService.",
    "AccountService.",
  );
  assert.ok(
    workspaceStatics.some(item => item.label === "priorityAccounts"),
    `a workspace class should offer its statics, got ${JSON.stringify(
      workspaceStatics.map(item => item.label),
    )}`,
  );

  // `this.` is the enclosing type, which no type-name lookup can find.
  const thisMembers = await completionsAt(
    "apexx/classes/ThisProbe.clsx",
    `public with sharing class ThisProbe {
    private String label;
    private String helper() {
        return 'x';
    }
    public String describe() {
        return this.
    }
}
`,
    "return this.",
  );
  assertHasLabels(thisMembers, ["label", "helper", "describe"]);

  // A query literal is its own language. Each clause is answered from the sObject
  // schema, and a bind variable steps back out into Apex scope.
  const soqlFields = await completionsAt(
    "apexx/scripts/SoqlProbe.apexx",
    "List<Account> rows = [SELECT ",
    "SELECT ",
  );
  assertHasLabels(soqlFields, ["Name", "AnnualRevenue", "Rating", "FROM", "COUNT"]);

  const soqlFrom = await completionsAt(
    "apexx/scripts/SoqlFromProbe.apexx",
    "List<Account> rows = [SELECT Id FROM ",
    "FROM ",
  );
  assertHasLabels(soqlFrom, ["Account", "Contact"]);
  assertNoLabels(soqlFrom, ["Name", "AnnualRevenue"]);

  const soqlWhere = await completionsAt(
    "apexx/scripts/SoqlWhereProbe.apexx",
    "List<Account> rows = [SELECT Id FROM Account WHERE ",
    "WHERE ",
  );
  assertHasLabels(soqlWhere, ["Rating", "LAST_N_DAYS:n", "ORDER BY", "LIMIT"]);

  const soqlOrder = await completionsAt(
    "apexx/scripts/SoqlOrderProbe.apexx",
    "List<Account> rows = [SELECT Id FROM Account ORDER BY ",
    "ORDER BY ",
  );
  assertHasLabels(soqlOrder, ["Name", "DESC", "NULLS LAST"]);

  // `:value` binds an Apex expression, so the local is offered again.
  const soqlBinding = await completionsAt(
    "apexx/scripts/SoqlBindProbe.apexx",
    "String wanted = 'Hot';\nList<Account> rows = [SELECT Id FROM Account WHERE Rating = :",
    "Rating = :",
  );
  assertHasLabels(soqlBinding, ["wanted"]);
  assertNoLabels(soqlBinding, ["ORDER BY"]);

  // A relationship walks the schema: Contact.Account resolves through the lookup.
  const soqlRelationship = await completionsAt(
    "apexx/scripts/SoqlRelationshipProbe.apexx",
    "List<Contact> rows = [SELECT Account.",
    "SELECT Account.",
  );
  assertHasLabels(soqlRelationship, ["AnnualRevenue", "Rating"]);

  // A list index is also written with brackets, and must not be read as a query.
  const indexExpression = await completionsAt(
    "apexx/scripts/IndexProbe.apexx",
    "List<Account> rows = new List<Account>();\nAccount first = rows[",
    "rows[",
  );
  assertNoLabels(indexExpression, ["FROM", "SELECT"]);

  // An sObject constructor takes named fields.
  const constructorFields = await completionsAt(
    "apexx/scripts/ConstructorProbe.apexx",
    "Account fresh = new Account(",
    "new Account(",
  );
  assertHasLabels(constructorFields, ["Name", "Rating", "AnnualRevenue"]);

  // `implements` names a type, and never a value.
  const implemented = await completionsAt(
    "apexx/classes/ImplementsProbe.clsx",
    "public with sharing class ImplementsProbe implements ",
    "implements ",
  );
  assertHasLabels(implemented, ["Queueable", "Schedulable", "Database.Batchable<SObject>"]);
  assertNoLabels(implemented, ["return", "System"]);

  // Every item carries the range of the identifier being typed. Without it the editor
  // has nothing to match against, stops filtering, and offers everything.
  const ranged = await completionsAt(
    "apexx/scripts/RangeProbe.apexx",
    "Datetime t = Datetime.now();\nSyst",
    "Syst",
  );
  const system = ranged.find(item => item.label === "System");
  assert.ok(system, "expected System to be offered");
  assert.deepEqual(
    system.textEdit?.range,
    { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
    `an item should replace the typed identifier, got ${JSON.stringify(system.textEdit)}`,
  );
  assert.equal(system.textEdit?.newText, "System");
  // A snippet keeps its body in the edit rather than in insertText.
  const debugItem = (
    await completionsAt(
      "apexx/scripts/RangeSnippetProbe.apexx",
      "System.deb",
      "System.deb",
    )
  ).find(item => item.label === "debug");
  assert.ok(debugItem, "expected System.debug to be offered");
  // The parameter name comes from whichever source answered -- the platform's own
  // standard library when it is installed, ApexX's table otherwise -- so what matters
  // here is that the snippet body travels in the edit rather than in insertText.
  assert.match(debugItem.textEdit?.newText ?? "", /^debug\(\$\{1:\w+\}\)$/);
  assert.equal(debugItem.insertText, undefined);
  assert.deepEqual(debugItem.textEdit?.range, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 10 },
  });

  // A member access is still one once the member name has been started, which is when
  // the offer is most useful.
  const partialStatic = await completionsAt(
    "apexx/scripts/PartialStaticProbe.apexx",
    "System.deb",
    "System.deb",
  );
  assertHasLabels(partialStatic, ["debug"]);

  const partialInstance = await completionsAt(
    "apexx/scripts/PartialInstanceProbe.apexx",
    "Datetime t = Datetime.now();\nInteger h = t.addD",
    "t.addD",
  );
  assertHasLabels(partialInstance, ["addDays"]);
  assertNoLabels(partialInstance, ["System", "return"]);

  const partialField = await completionsAt(
    "apexx/scripts/PartialFieldProbe.apexx",
    "List<Account> rows = new List<Account>();\nString name = rows.filter(a => a.Ann",
    "a.Ann",
  );
  assertHasLabels(partialField, ["AnnualRevenue"]);

  // The Apex standard library, read from the Salesforce Apex extension when the user
  // has it. Skipped when it is absent, because then ApexX is answering from its own
  // curated table and the counts below do not apply.
  if (hasStandardApexLibrary()) {
    // A namespace offers its statics, its instance methods and the types it contains.
    const messaging = await completionsAt(
      "apexx/scripts/LibraryProbe.apexx",
      "Messaging.",
      "Messaging.",
    );
    assertHasLabels(messaging, ["sendEmail", "SingleEmailMessage", "InboundEmail"]);

    // Members whose name is a DML keyword only parse once the declaration is rewritten,
    // so their presence is what proves that rewrite still works.
    const database = await completionsAt(
      "apexx/scripts/LibraryDmlProbe.apexx",
      "Database.",
      "Database.",
    );
    assertHasLabels(database, ["insert", "update", "upsert", "delete", "undelete", "merge"]);
    // A leaked parameter would show up as a member named after its type.
    assertNoLabels(database, ["Boolean", "recordToDelete", "SObject"]);

    // Real signatures and the platform's own descriptions.
    const abs = (
      await completionsAt("apexx/scripts/LibraryDocProbe.apexx", "Math.", "Math.")
    ).find(item => item.label === "abs");
    assert.ok(abs, "expected Math.abs");
    assert.match(abs.detail ?? "", /^Decimal Math\.abs\(Decimal \w+\)$/);
    assert.match(String(abs.documentation ?? ""), /absolute value/i);

    // The library reaches far past the curated table: Limits has dozens of counters.
    const limits = await completionsAt(
      "apexx/scripts/LibraryLimitsProbe.apexx",
      "Limits.",
      "Limits.",
    );
    assert.ok(
      limits.length > 30,
      `the whole library should answer Limits., got ${limits.length}`,
    );

    // An instance of a library type resolves to its instance members.
    const email = await completionsAt(
      "apexx/scripts/LibraryInstanceProbe.apexx",
      "Messaging.SingleEmailMessage message = new Messaging.SingleEmailMessage();\nmessage.",
      "\nmessage.",
    );
    assertHasLabels(email, ["setToAddresses", "setSubject", "setPlainTextBody"]);

    // ApexX's pipeline methods still come first on a List, ahead of the platform's.
    const listMembers = await completionsAt(
      "apexx/scripts/LibraryListProbe.apexx",
      "List<Account> rows = new List<Account>();\nrows.",
      "\nrows.",
    );
    assertHasLabels(listMembers, ["filter", "map", "flatMap", "add", "size", "sort"]);
    const rank = label =>
      listMembers.findIndex(item => item.label === label);
    assert.ok(
      rank("filter") < rank("add"),
      "ApexX's pipeline methods should be offered before the platform's List members",
    );

    // An identifier position reaches library types, and says the answer is partial so
    // the editor asks again as the prefix grows.
    const typed = await completionsRaw(
      "apexx/scripts/LibraryTypeProbe.apexx",
      "HttpReq",
      "HttpReq",
    );
    assertHasLabels(typed.items, ["HttpRequest"]);
    assert.equal(
      typed.isIncomplete,
      true,
      "an identifier answer that consulted the library is partial",
    );

    // A member list is complete, and must not be marked otherwise.
    const complete = await completionsRaw(
      "apexx/scripts/LibraryCompleteProbe.apexx",
      "Math.",
      "Math.",
    );
    assert.notEqual(complete.isIncomplete, true, "a member list is complete");

    // Hover reads the same archive, so a standard member explains itself.
    const mathHover = await hoverAt(
      "apexx/scripts/LibraryHoverProbe.apexx",
      "Decimal d = Math.abs(-1);",
      "Math.abs",
    );
    assert.match(mathHover, /Decimal Math\.abs\(Decimal \w+\)/);
    assert.match(mathHover, /absolute value/i);

    const stringHover = await hoverAt(
      "apexx/scripts/LibraryStringHoverProbe.apexx",
      "String s = 'x';\nString u = s.toUpperCase();",
      "s.toUpperCase",
    );
    assert.match(stringHover, /String String\.toUpperCase\(\)/);

    // A local is explained by its declaration, not by a same-named library member.
    const localHoverText = await hoverAt(
      "apexx/scripts/LibraryLocalHoverProbe.apexx",
      "Integer size = 5;\nInteger copy = size;",
      "= size",
    );
    assert.match(localHoverText, /Integer size/);
    assert.doesNotMatch(localHoverText, /List\.size/);
  } else {
    console.log("Apex extension not installed: standard library checks skipped.");
  }

  // `@` opens an annotation. Without it as a trigger character the offer exists but is
  // unreachable: `@` is not a word character, so nothing else asks for it.
  assert.deepEqual(
    capabilities.completionProvider.triggerCharacters,
    [".", "@"],
    "a member list and an annotation are the two things a character opens",
  );
  assert.deepEqual(capabilities.codeActionProvider, { codeActionKinds: ["quickfix"] });
  assert.equal(capabilities.foldingRangeProvider, true);
  assert.equal(capabilities.implementationProvider, true);

  // Folding by structure: braces, comments and region markers, rather than the
  // indentation VS Code falls back to when nothing answers.
  const foldSource = `public with sharing class FoldProbe {
    /**
     * A block comment.
     * Second line.
     */
    public Boolean applies(Account record) {
        return record != null;
    }

    // #region helpers
    public String describe() {
        return 'probe';
    }
    // #endregion
}
`;
  const foldUri = pathToFileURL(
    path.join(root, "apexx", "classes", "FoldProbe.clsx"),
  ).href;
  notify("textDocument/didOpen", {
    textDocument: { uri: foldUri, languageId: "apexx", version: 1, text: foldSource },
  });
  const folds = await request("textDocument/foldingRange", {
    textDocument: { uri: foldUri },
  });
  const foldLine = line => folds.find(range => range.startLine === line - 1);

  assert.ok(foldLine(1), "the class body should fold");
  assert.ok(foldLine(6), "a method body should fold");
  const blockComment = foldLine(2);
  assert.ok(blockComment, "a block comment should fold");
  assert.equal(blockComment.kind, "comment");
  assert.equal(blockComment.endLine, 4, "a comment folds to its closing line");
  const region = folds.find(range => range.kind === "region");
  assert.ok(region, "a #region marker should fold");
  assert.equal(region.startLine, 9);
  assert.equal(region.endLine, 13);
  // A brace inside a string must not close a region.
  assert.ok(
    folds.every(range => range.endLine > range.startLine),
    "a folding range has to span more than one line",
  );

  // Go to implementation: the other direction from go to definition.
  const ruleSource = `public interface RuleProbe {
    Boolean applies(Account record);
}
`;
  const ruleImplSource = `public with sharing class RuleProbeImpl implements RuleProbe {
    public Boolean applies(Account record) {
        return record != null;
    }
}
`;
  const rulePath = path.join(root, "apexx", "classes", "RuleProbe.clsx");
  const ruleImplPath = path.join(root, "apexx", "classes", "RuleProbeImpl.clsx");
  writeFileSync(rulePath, ruleSource);
  writeFileSync(ruleImplPath, ruleImplSource);

  try {
    const ruleUri = pathToFileURL(rulePath).href;
    notify("textDocument/didOpen", {
      textDocument: { uri: ruleUri, languageId: "apexx", version: 1, text: ruleSource },
    });

    const typeImplementations = await request("textDocument/implementation", {
      textDocument: { uri: ruleUri },
      position: { line: 0, character: 18 },
    });
    assert.equal(
      typeImplementations.length,
      1,
      `expected the implementing class, got ${JSON.stringify(typeImplementations)}`,
    );
    assert.match(typeImplementations[0].uri, /RuleProbeImpl\.clsx$/);

    // On a member, the same member on each implementor -- which needs the interface's
    // own methods to be in the symbol model at all.
    const memberImplementations = await request("textDocument/implementation", {
      textDocument: { uri: ruleUri },
      position: { line: 1, character: 14 },
    });
    assert.equal(
      memberImplementations.length,
      1,
      `expected the implementing method, got ${JSON.stringify(memberImplementations)}`,
    );
    assert.equal(memberImplementations[0].range.start.line, 1);

    // An interface's methods are a separate grammar rule, so they need their own hook;
    // without it the interface's outline is empty.
    const ruleOutline = await request("textDocument/documentSymbol", {
      textDocument: { uri: ruleUri },
    });
    assert.deepEqual(
      (ruleOutline[0]?.children ?? []).map(child => child.name),
      ["applies"],
      "an interface's methods belong in its outline",
    );
  } finally {
    rmSync(rulePath, { force: true });
    rmSync(ruleImplPath, { force: true });
  }

  // Signature help used to search only the file being edited, so a qualified call, a
  // call into another .clsx, and every standard method had no signature at all.
  const signatureAt = async (file, text, marker) => {
    const uri = pathToFileURL(path.join(root, `${file}`)).href;
    notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "apexx",
        version: (signatureAt.version = (signatureAt.version ?? 0) + 1),
        text,
      },
    });

    const offset = text.indexOf(marker) + marker.length;
    const before = text.slice(0, offset);
    const result = await request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: {
        line: before.split("\n").length - 1,
        character: offset - (before.lastIndexOf("\n") + 1),
      },
    });

    return (result?.signatures ?? []).map(signature => signature.label);
  };

  // A static call into another file in the workspace.
  const crossFileSignature = await signatureAt(
    "apexx/scripts/SignatureCrossFileProbe.apexx",
    "List<Account> rows = AccountService.priorityAccounts(",
    "priorityAccounts(",
  );
  assert.ok(
    crossFileSignature.some(label => /priorityAccounts\(List<Account>/.test(label)),
    `a call into another file should have a signature, got ${JSON.stringify(crossFileSignature)}`,
  );

  if (hasStandardApexLibrary()) {
    // Completion collapses overloads; signature help is where they belong.
    const overloads = await signatureAt(
      "apexx/scripts/SignatureOverloadProbe.apexx",
      "Decimal d = Math.max(",
      "Math.max(",
    );
    assert.ok(
      overloads.length >= 4,
      `Math.max has four overloads, got ${JSON.stringify(overloads)}`,
    );
    assert.ok(overloads.every(label => /^\w+ Math\.max\(/.test(label)));
    // Simplest first, so the default offer is the one most often meant.
    const counts = overloads.map(label => label.split(",").length);
    assert.deepEqual(
      counts,
      [...counts].sort((left, right) => left - right),
      "overloads should be offered fewest parameters first",
    );

    // An instance receiver resolves through its declared type.
    const instance = await signatureAt(
      "apexx/scripts/SignatureInstanceProbe.apexx",
      "String s = 'x';\nBoolean b = s.contains(",
      "s.contains(",
    );
    assert.ok(
      instance.some(label => /String\.contains\(String/.test(label)),
      `an instance call should resolve, got ${JSON.stringify(instance)}`,
    );
  }

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

    if (message.method === "textDocument/publishDiagnostics") {
      publishedDiagnostics.set(message.params.uri, message.params.diagnostics);

      for (const waiter of [...diagnosticWaiters]) {
        if (waiter.uri === message.params.uri && waiter.matches(message.params.diagnostics)) {
          diagnosticWaiters.delete(waiter);
          waiter.resolve(message.params.diagnostics);
        }
      }
    }

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

function waitForDiagnostics(uri, matches) {
  const current = publishedDiagnostics.get(uri);

  if (current && matches(current)) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    const waiter = { uri, matches, resolve };
    diagnosticWaiters.add(waiter);
    setTimeout(() => {
      if (diagnosticWaiters.delete(waiter)) {
        reject(
          new Error(
            `Timed out waiting for diagnostics on ${uri}. Last published: ${JSON.stringify(
              publishedDiagnostics.get(uri),
            )} ${stderr}`,
          ),
        );
      }
    }, 5000);
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

/** Completion at the end of `marker` within `text`, for an arbitrary workspace path. */
async function completionsAt(file, text, marker) {
  const uri = pathToFileURL(path.join(root, `${file}`)).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "apexx",
      version: (completionsAt.version = (completionsAt.version ?? 0) + 1),
      text,
    },
  });

  const offset = text.indexOf(marker) + marker.length;
  assert.notEqual(offset, marker.length - 1, `marker ${marker} not found`);
  const before = text.slice(0, offset);
  const result = await request("textDocument/completion", {
    textDocument: { uri },
    position: {
      line: before.split("\n").length - 1,
      character: offset - (before.lastIndexOf("\n") + 1),
    },
  });

  return Array.isArray(result) ? result : result?.items ?? [];
}

/** Hover text at the end of `marker` within `text`. */
async function hoverAt(file, text, marker) {
  const uri = pathToFileURL(path.join(root, `${file}`)).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "apexx",
      version: (hoverAt.version = (hoverAt.version ?? 0) + 1),
      text,
    },
  });

  // One before the end, so the position is inside the word rather than after it.
  const offset = text.indexOf(marker) + marker.length - 1;
  const before = text.slice(0, offset);
  const result = await request("textDocument/hover", {
    textDocument: { uri },
    position: {
      line: before.split("\n").length - 1,
      character: offset - (before.lastIndexOf("\n") + 1),
    },
  });

  return result?.contents?.value ?? "";
}

/** Whether the Apex extension is installed, and so whether the library can answer. */
function hasStandardApexLibrary() {
  const extensions = path.join(os.homedir(), ".vscode", "extensions");

  if (!existsSync(extensions)) {
    return false;
  }

  return readdirSync(extensions).some(
    entry =>
      /^salesforce\.apex-language-server-extension-\d/.test(entry) &&
      existsSync(
        path.join(extensions, entry, "resources", "StandardApexLibrary.zip"),
      ),
  );
}

/** Like completionsAt, but keeps the isIncomplete flag the list arrived with. */
async function completionsRaw(file, text, marker) {
  const uri = pathToFileURL(path.join(root, `${file}`)).href;
  notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "apexx",
      version: (completionsRaw.version = (completionsRaw.version ?? 0) + 1),
      text,
    },
  });

  const offset = text.indexOf(marker) + marker.length;
  const before = text.slice(0, offset);
  const result = await request("textDocument/completion", {
    textDocument: { uri },
    position: {
      line: before.split("\n").length - 1,
      character: offset - (before.lastIndexOf("\n") + 1),
    },
  });

  return Array.isArray(result)
    ? { items: result, isIncomplete: false }
    : { items: result?.items ?? [], isIncomplete: result?.isIncomplete };
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

/** A completion response is a list or a bare array, depending on completeness. */
function itemsOf(result) {
  return Array.isArray(result) ? result : (result?.items ?? []);
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

/**
 * Checks the ApexX grammar against the Apex one, with the real TextMate engine.
 *
 * ApexX is a superset of Apex, and its grammar is built from Apex's by
 * scripts/build-grammar.mjs, so the bar is exact: source that is legal Apex must
 * tokenise to the same scopes under both grammars. That is the property that makes a
 * .clsx file look like a .cls file instead of approximating it, and it is the one the
 * previous hand-written grammar failed -- it matched first with coarser scopes and
 * replaced Apex's precise ones, which no assertion about ApexX's own scope names could
 * have caught.
 *
 * The ApexX-only constructs are then checked on their own, and the demo sources are
 * checked for tokens that reached no rule at all.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// vscode-textmate is CommonJS, so its exports arrive on the default import.
import textmate from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const { Registry, parseRawGrammar, INITIAL } = textmate;
const { loadWASM, createOnigScanner, createOnigString } = oniguruma;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "packages", "vscode-extension");

await loadWASM(fs.readFileSync(
  path.join(root, "node_modules", "vscode-oniguruma", "release", "onig.wasm"),
));

// Both grammars come from this repo: the Apex one is vendored, so the comparison does
// not depend on the Salesforce extension being installed.
const files = {
  "source.apexx": path.join(extension, "syntaxes", "apexx.tmLanguage.json"),
  "source.apex": path.join(extension, "grammars", "apex.tmLanguage.json"),
};

const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
  loadGrammar: async scopeName => {
    const file = files[scopeName];
    return file ? parseRawGrammar(fs.readFileSync(file, "utf8"), file) : null;
  },
});

const apexx = await registry.loadGrammar("source.apexx");
const apex = await registry.loadGrammar("source.apex");
assert.ok(apexx, "the ApexX grammar should load");
assert.ok(apex, "the vendored Apex grammar should load");

/** Every non-blank token of `source`, as `{ line, start, text, scopes }`. */
function tokenize(grammar, source) {
  const tokens = [];
  let ruleStack = INITIAL;

  source.split("\n").forEach((line, lineIndex) => {
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;

    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);

      if (text.trim().length > 0) {
        tokens.push({
          line: lineIndex + 1,
          start: token.startIndex,
          text,
          scopes: token.scopes,
        });
      }
    }
  });

  return tokens;
}

/** The scope that decides a token's colour is the most specific one it carries. */
const scopeOf = token => token.scopes.at(-1);

function findAll(tokens, text, line) {
  return tokens.filter(
    token => token.text === text && (line === undefined || token.line === line),
  );
}

function findOne(tokens, text, line) {
  const matches = findAll(tokens, text, line);
  assert.ok(
    matches.length >= 1,
    `expected a token ${JSON.stringify(text)}${line ? ` on line ${line}` : ""}`,
  );
  return matches[0];
}

// ---------------------------------------------------------------------------
// Apex-legal source must tokenise identically under both grammars.
// ---------------------------------------------------------------------------

// Deliberately broad: the constructs whose colour a reader notices first, and the ones
// the old grammar got wrong -- SOQL, strings, annotations, DML, generics, control flow.
const apexLegal = `public with sharing class AccountService implements Queueable {
    private static final Decimal MIN_REVENUE_PER_EMPLOYEE = 10000;

    @AuraEnabled(cacheable=true)
    public static List<Account> loadPriorityAccounts(Integer limitSize) {
        List<Account> accounts = [
            SELECT Id, Name, AnnualRevenue
            FROM Account
            WHERE Name LIKE 'ApexX Demo%' AND AnnualRevenue != null
            ORDER BY Name
        ];
        Map<Id, Account> byId = new Map<Id, Account>(accounts);
        Boolean ok = accounts.size() > 1 && accounts.get(0).AnnualRevenue != null;

        for (Account account : accounts) {
            System.debug('name: ' + account.Name);
        }

        try {
            insert accounts;
        } catch (DmlException error) {
            throw new IllegalArgumentException('bad');
        } finally {
            System.debug(LoggingLevel.ERROR, 'done');
        }

        return ok ? accounts : new List<Account>();
    }
}
`;

const underApex = tokenize(apex, apexLegal);
const underApexx = tokenize(apexx, apexLegal);

assert.equal(
  underApexx.length,
  underApex.length,
  "the two grammars should split Apex-legal source into the same tokens",
);

const divergent = [];

for (const [index, expected] of underApex.entries()) {
  const actual = underApexx[index];

  if (
    actual.text !== expected.text ||
    actual.line !== expected.line ||
    scopeOf(actual) !== scopeOf(expected)
  ) {
    divergent.push(
      `line ${expected.line} ${JSON.stringify(expected.text)}: apex ${scopeOf(expected)}, apexx ${scopeOf(actual)}`,
    );
  }
}

assert.deepEqual(
  divergent,
  [],
  `ApexX must colour Apex-legal source exactly as Apex does:\n  ${divergent.join("\n  ")}`,
);

// The SOQL body specifically, because it was entirely unhighlighted before and is the
// clearest signal that the whole Apex rule set is reaching the text.
assert.match(scopeOf(findOne(underApexx, "SELECT")), /keyword\.operator\.query/);
assert.match(scopeOf(findOne(underApexx, "FROM")), /keyword\.operator\.query/);
assert.equal(scopeOf(findOne(underApexx, "Decimal")), "keyword.type.apex");
assert.equal(scopeOf(findOne(underApexx, "@AuraEnabled")), "storage.type.annotation.apex");
assert.equal(scopeOf(findOne(underApexx, "insert")), "support.function.apex");

// ---------------------------------------------------------------------------
// The ApexX-only constructs.
// ---------------------------------------------------------------------------

const apexxOnly = `public with sharing class ColourProbe {
    public static List<String> names(List<Account> accounts) {
        Func<Account, Boolean> rule = (account) => {
            if (account.Name == null) {
                return false;
            }

            return account.AnnualRevenue > 0;
        };
        Map<Id, (String, Decimal)> carried = new Map<Id, (String, Decimal)>();
        carried.put(accounts.get(0).Id, (accounts.get(0).Name, 1.5));

        return accounts
            .filter(account => rule.invoke(account))
            .map(account => account.Name);
    }
}
`;

const probe = tokenize(apexx, apexxOnly);

assert.equal(scopeOf(findOne(probe, "Func")), "keyword.type.apexx");
for (const arrow of findAll(probe, "=>")) {
  assert.equal(scopeOf(arrow), "keyword.operator.arrow.apexx");
}
for (const helper of ["filter", "map"]) {
  assert.equal(
    scopeOf(findOne(probe, helper)),
    "support.function.collection.apexx",
    `${helper} is an ApexX built-in, not an ordinary call`,
  );
}
assert.equal(
  scopeOf(findOne(probe, "account", 3)),
  "variable.parameter.apexx",
  "a lambda parameter is a parameter",
);

// A tuple type inside a generic argument: the parentheses are tuple punctuation and the
// members keep the scopes Apex gives those types.
const tupleOpen = findAll(probe, "(", 10).map(scopeOf);
assert.ok(
  tupleOpen.includes("punctuation.definition.tuple.begin.apexx"),
  `a tuple type should open with tuple punctuation, got ${tupleOpen.join(", ")}`,
);
for (const member of findAll(probe, "Decimal", 10)) {
  assert.equal(
    scopeOf(member),
    "keyword.type.apex",
    "a built-in type inside a tuple keeps the scope Apex gives it",
  );
}

// A block-bodied lambda is a block: an Apex expression reaching `{` would read it as an
// array initialiser, and `return` inside it would not be a keyword.
assert.equal(
  scopeOf(findOne(probe, "return", 5)),
  "keyword.control.flow.return.apex",
  "a statement inside a lambda body is a statement",
);
assert.equal(scopeOf(findOne(probe, "if", 4)), "keyword.control.conditional.if.apex");

// ---------------------------------------------------------------------------
// Comments and strings win over every ApexX rule.
// ---------------------------------------------------------------------------

const quoted = `public class Quoted {
    public static void run() {
        // @UserFriendlyError => Account .filter(
        String text = '@UserFriendlyError => Account .filter(';
        System.debug(text);
    }
}
`;

for (const token of tokenize(apexx, quoted)) {
  if (token.line === 3) {
    assert.match(
      token.scopes.join(" "),
      /comment/,
      `line 3 is a comment, but ${JSON.stringify(token.text)} was scoped ${scopeOf(token)}`,
    );
  }

  if (token.line === 4 && ["=>", "filter", "@UserFriendlyError"].includes(token.text)) {
    assert.match(
      token.scopes.join(" "),
      /string/,
      `${JSON.stringify(token.text)} is inside a string literal`,
    );
  }
}

// ---------------------------------------------------------------------------
// Nothing in the demo sources falls through to no rule at all.
// ---------------------------------------------------------------------------

for (const relative of ["apexx/scripts/AccountAudit.apexx", "apexx/classes/AccountService.clsx"]) {
  const file = path.join(root, relative);

  if (!fs.existsSync(file)) {
    continue;
  }

  const unscoped = tokenize(apexx, fs.readFileSync(file, "utf8"))
    .filter(token => scopeOf(token) === "source.apexx")
    .map(token => `line ${token.line} ${JSON.stringify(token.text)}`);

  assert.deepEqual(
    unscoped,
    [],
    `${relative} has tokens no rule coloured:\n  ${unscoped.join("\n  ")}`,
  );
}

console.log(
  `Grammar test passed: ${underApex.length} tokens of Apex-legal source scoped identically to Apex, plus the ApexX constructs.`,
);

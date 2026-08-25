import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  mapIdentifierOffset,
  mergeGeneratedSupportClasses,
  transpileApexX,
} from "../packages/transpiler/dist/index.js";
import { parseApex } from "../packages/parser/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const extensionPackage = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages", "vscode-extension", "package.json"),
    "utf8",
  ),
);
const extensionGrammar = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      "packages",
      "vscode-extension",
      "syntaxes",
      "apexx.tmLanguage.json",
    ),
    "utf8",
  ),
);
const extensionSnippets = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages", "vscode-extension", "snippets", "apexx.json"),
    "utf8",
  ),
);

assert.equal(extensionPackage.contributes.languages[0].extensions[0], ".clsx");
assert.equal(extensionPackage.contributes.snippets[0].language, "apexx");
// The grammar is generated from the vendored Apex one by scripts/build-grammar.mjs, so
// what matters is that it still carries Apex's rules, still carries the ApexX ones, and
// is in step with the additions file. A grammar edited by hand instead of regenerated is
// the failure this guards: it would drift from Apex and take the colouring with it.
{
  const apexBase = JSON.parse(
    fs.readFileSync(
      path.join(root, "packages", "vscode-extension", "grammars", "apex.tmLanguage.json"),
      "utf8",
    ),
  );

  assert.equal(extensionGrammar.scopeName, "source.apexx");

  for (const rule of ["soql-query-expression", "annotation-declaration", "string-literal", "block", "statement"]) {
    assert.ok(
      extensionGrammar.repository[rule],
      `the ApexX grammar must keep Apex's #${rule}, or that syntax loses its colour`,
    );
  }

  for (const rule of ["apexx-lambda", "apexx-func-type", "apexx-tuple-type", "apexx-collection-helper"]) {
    assert.ok(extensionGrammar.repository[rule], `the ApexX grammar is missing #${rule}`);
  }

  // Every Apex rule has to survive the derivation, so nothing Apex colours goes dark.
  for (const rule of Object.keys(apexBase.repository)) {
    assert.ok(extensionGrammar.repository[rule], `the derivation dropped Apex's #${rule}`);
  }

  // The ApexX rules only matter if they are reached before the Apex rules that would
  // otherwise claim the same text -- a lambda's `(` before a parenthesised expression,
  // a collection helper before an ordinary invocation.
  const expression = extensionGrammar.repository.expression.patterns.map(p => p.include);
  assert.ok(
    expression.indexOf("#apexx-lambda") < expression.indexOf("#parenthesized-expression"),
    "#apexx-lambda must be tried before #parenthesized-expression",
  );
  assert.ok(
    expression.indexOf("#apexx-collection-helper") < expression.indexOf("#invocation-expression"),
    "#apexx-collection-helper must be tried before #invocation-expression",
  );

  // Regenerating must reproduce the committed grammar exactly, so the checked-in file
  // is always the one the additions describe.
  const rebuilt = execFileSync(process.execPath, [path.join(root, "scripts", "build-grammar.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(rebuilt, /Built /);
  const afterRebuild = fs.readFileSync(
    path.join(root, "packages", "vscode-extension", "syntaxes", "apexx.tmLanguage.json"),
    "utf8",
  );
  assert.equal(
    afterRebuild,
    JSON.stringify(extensionGrammar, null, 2) + "\n",
    "the committed grammar is not what scripts/build-grammar.mjs produces -- run npm run grammar:build",
  );

  // The extension must contribute exactly the one grammar. The old build also injected
  // ApexX rules into `source.apex`, which coloured `count` and `map` in every ordinary
  // .cls file and relabelled Apex's own map-literal `=>`.
  assert.deepEqual(
    extensionPackage.contributes.grammars.map(grammar => grammar.scopeName),
    ["source.apexx"],
    "ApexX must contribute one grammar and inject nothing into source.apex",
  );
}

assert.equal(extensionSnippets["ApexX typed function"].prefix, "apexx-func");
assert.equal(extensionSnippets["ApexX block function"].prefix, "apexx-func-block");
assert.equal(extensionSnippets["ApexX tuple contract"].prefix, "apexx-tuple");
assert.equal(extensionSnippets["ApexX tuple-valued map"].prefix, "apexx-tuple-map");
assert.ok(extensionGrammar.repository["apexx-tuple-type"]);

const arbitraryTupleSource = `public class TupleProbe {
    public static (Decimal, Integer, Boolean, Long) calculate() {
        return (10.5, 2, true, 9);
    }

    public static void consume() {
        (Decimal revenue, Integer count, Boolean active, Long _) =
            calculate();
    }
}`;
const arbitraryTupleResult = transpileApexX(arbitraryTupleSource, {
  sourceFileName: "TupleProbe.clsx",
});
assert.deepEqual(
  arbitraryTupleResult.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);
const arbitraryTupleSupport = arbitraryTupleResult.supportClasses.find(
  supportClass => supportClass.className === "ApexXTuples",
);
assert.ok(arbitraryTupleSupport);
assert.equal(parseApex(arbitraryTupleSupport.source).ok, true);
assert.match(arbitraryTupleResult.output, /public static ApexXTuples\.ApexXTuple_[0-9a-f]{12} calculate\(\)/);
assert.match(arbitraryTupleResult.output, /return new ApexXTuples\.ApexXTuple_[0-9a-f]{12}\(10\.5, 2, true, 9\);/);
assert.match(arbitraryTupleSupport.source, /public Long item3;/);
assert.match(arbitraryTupleResult.output, /Decimal revenue = apexxTuple0\.item0;/);
assert.doesNotMatch(arbitraryTupleResult.output, /Long _|\.item3;/);

const tupleMapSource = `public class AccountSignalProbe {
    public static Map<Id, (Decimal, Boolean)> calculate(List<Account> accounts) {
        Map<Id, (Decimal, Boolean)> signals =
            new Map<Id, (Decimal, Boolean)>();
        for (Account account : accounts) {
            Decimal revenuePerEmployee = account.NumberOfEmployees == null
                || account.NumberOfEmployees == 0
                ? 0
                : account.AnnualRevenue / account.NumberOfEmployees;
            Boolean needsReview = account.AccountNumber == null;
            signals.put(account.Id, (revenuePerEmployee, needsReview));
        }
        return signals;
    }

    public static Boolean consume(Account account) {
        Map<Id, (Decimal, Boolean)> signals = calculate(new List<Account>{ account });
        (Decimal revenuePerEmployee, Boolean needsReview) = signals.get(account.Id);
        return needsReview && revenuePerEmployee < 10000;
    }
}`;
const tupleMapResult = transpileApexX(tupleMapSource, {
  sourceFileName: "AccountSignalProbe.clsx",
});
assert.deepEqual(
  tupleMapResult.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);
assert.match(
  tupleMapResult.output,
  /public static Map<Id, ApexXTuples\.ApexXTuple_[0-9a-f]{12}> calculate/,
);
assert.match(
  tupleMapResult.output,
  /new Map<Id, ApexXTuples\.ApexXTuple_[0-9a-f]{12}>\(\)/,
);
assert.match(
  tupleMapResult.output,
  /signals\.put\(account\.Id, new ApexXTuples\.ApexXTuple_[0-9a-f]{12}\(revenuePerEmployee, needsReview\)\);/,
);
assert.match(tupleMapResult.output, /Decimal revenuePerEmployee = apexxTuple0\.item0;/);
assert.match(tupleMapResult.output, /Boolean needsReview = apexxTuple0\.item1;/);
for (const supportClass of tupleMapResult.supportClasses) {
  assert.equal(parseApex(supportClass.source).ok, true);
}
assert.equal(parseApex(tupleMapResult.output).ok, true);

const funcTupleSource = `public class FuncTupleProbe {
    public static (Func<Account, Boolean>, String) resolve() {
        Func<Account, Boolean> rule = (account) => account.Rating == 'Hot';
        return (rule, 'Hot account');
    }

    public static List<Account> select(List<Account> accounts) {
        (Func<Account, Boolean> rule, String reason) = resolve();
        return accounts.filter(account => rule(account));
    }
}`;
const funcTupleResult = transpileApexX(funcTupleSource, {
  sourceFileName: "FuncTupleProbe.clsx",
});
assert.deepEqual(
  funcTupleResult.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);
const funcTupleSupport = funcTupleResult.supportClasses.find(
  supportClass => supportClass.className === "ApexXTuples",
);
assert.ok(funcTupleSupport);
for (const supportClass of funcTupleResult.supportClasses) {
  assert.equal(parseApex(supportClass.source).ok, true);
}
assert.match(funcTupleSupport.source, /public ApexXFuncs\.ApexXFunc_[0-9a-f]{12} item0;/);
assert.match(funcTupleResult.output, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} rule = apexxTuple0\.item0;/);
assert.match(funcTupleResult.output, /rule\.invoke\(account\)/);

const blockLambdaSource = `public class BlockLambdaProbe {
    public static List<String> select(List<Account> accounts, Decimal threshold) {
        Func<Account, Boolean> isEligible = (account) => {
            Decimal revenue = account.AnnualRevenue == null
                ? 0
                : account.AnnualRevenue;
            return revenue >= threshold && account.Rating == 'Hot';
        };

        return accounts
            .filter(account => {
                Boolean named = account.Name != null;
                return named && isEligible(account);
            })
            .map(account => {
                String label = account.Name.toUpperCase();
                return label;
            });
    }

    public static void inspect(List<Account> accounts) {
        Boolean anyHot = accounts.any(account => {
            Boolean hot = account.Rating == 'Hot';
            return hot;
        });
        Boolean allNamed = accounts.all(account => {
            Boolean named = account.Name != null;
            return named;
        });
        Integer numbered = accounts.count(account => {
            Boolean hasNumber = account.AccountNumber != null;
            return hasNumber;
        });
        Account firstHot = accounts.find(account => {
            Boolean hot = account.Rating == 'Hot';
            return hot;
        });
        List<Contact> contacts = accounts.flatMap(account => {
            List<Contact> related = account.Contacts;
            return related;
        });
    }
}`;
const blockLambdaResult = transpileApexX(blockLambdaSource, {
  sourceFileName: "BlockLambdaProbe.clsx",
});
assert.deepEqual(
  blockLambdaResult.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);
assert.match(blockLambdaResult.output, /Decimal revenue = account\.AnnualRevenue == null/);
assert.match(blockLambdaResult.output, /return revenue >= threshold && account\.Rating == 'Hot';/);
assert.match(blockLambdaResult.output, /Boolean named = account\.Name != null;/);
assert.match(blockLambdaResult.output, /if \(named && isEligible\.invoke\(account\)\) \{/);
assert.match(blockLambdaResult.output, /String label = account\.Name\.toUpperCase\(\);/);
assert.match(blockLambdaResult.output, /apexxMap0\.add\(label\);/);
assert.match(blockLambdaResult.output, /Boolean hot = account\.Rating == 'Hot';\s*if \(hot\) \{\s*apexxAny0 = true;/);
assert.match(blockLambdaResult.output, /Boolean named = account\.Name != null;\s*if \(!\(named\)\) \{\s*apexxAll0 = false;/);
assert.match(blockLambdaResult.output, /Boolean hasNumber = account\.AccountNumber != null;\s*if \(hasNumber\) \{\s*apexxCount0\+\+;/);
assert.match(blockLambdaResult.output, /Account firstHot = apexxFind0;/);
assert.match(blockLambdaResult.output, /List<Contact> related = account\.Contacts;\s*apexxFlatMap0\.addAll\(related\);/);

const crossClassProviderSource = `public class RuleProvider {
    public static (Func<Account, Boolean>, String) resolve() {
        Func<Account, Boolean> rule = (account) => account.Rating == 'Hot';
        return (rule, 'Hot account');
    }
}`;
const crossClassConsumerSource = `public class RuleConsumer {
    public static List<Account> apply(List<Account> accounts) {
        (Func<Account, Boolean> rule, String reason) = RuleProvider.resolve();
        return accounts.filter(account => rule(account));
    }
}`;
const crossClassProvider = transpileApexX(crossClassProviderSource, {
  sourceFileName: "RuleProvider.clsx",
});
const crossClassConsumer = transpileApexX(crossClassConsumerSource, {
  sourceFileName: "RuleConsumer.clsx",
});
const providerTupleType = /ApexXTuples\.ApexXTuple_[0-9a-f]{12}/.exec(crossClassProvider.output)?.[0];
const consumerTupleType = /ApexXTuples\.ApexXTuple_[0-9a-f]{12}/.exec(crossClassConsumer.output)?.[0];
const providerFuncType = /ApexXFuncs\.ApexXFunc_[0-9a-f]{12}/.exec(crossClassProvider.output)?.[0];
const consumerFuncType = /ApexXFuncs\.ApexXFunc_[0-9a-f]{12}/.exec(crossClassConsumer.output)?.[0];
assert.equal(providerTupleType, consumerTupleType);
assert.equal(providerFuncType, consumerFuncType);
assert.ok(providerTupleType);
assert.ok(providerFuncType);
for (const supportClass of [
  ...crossClassProvider.supportClasses,
  ...crossClassConsumer.supportClasses,
]) {
  assert.equal(parseApex(supportClass.source).ok, true);
}
assert.equal(
  crossClassProvider.supportClasses.find(item => item.className === "ApexXTuples")?.source,
  crossClassConsumer.supportClasses.find(item => item.className === "ApexXTuples")?.source,
);
assert.equal(
  crossClassProvider.supportClasses.find(item => item.className === "ApexXFuncs")?.source,
  crossClassConsumer.supportClasses.find(item => item.className === "ApexXFuncs")?.source,
);

const numericFuncResult = transpileApexX(`public class NumericRuleProvider {
    public static Func<Integer, Integer> squareRule() {
        Func<Integer, Integer> square = (value) => value * value;
        return square;
    }
}`, { sourceFileName: "NumericRuleProvider.clsx" });
const mergedStructuralSupport = mergeGeneratedSupportClasses([
  ...arbitraryTupleResult.supportClasses,
  ...funcTupleResult.supportClasses,
  ...numericFuncResult.supportClasses,
]);
assert.equal(
  mergedStructuralSupport.filter(item => item.className === "ApexXFuncs").length,
  1,
);
assert.equal(
  mergedStructuralSupport.filter(item => item.className === "ApexXTuples").length,
  1,
);
const mergedFuncRegistry = mergedStructuralSupport.find(
  item => item.className === "ApexXFuncs",
);
const mergedTupleRegistry = mergedStructuralSupport.find(
  item => item.className === "ApexXTuples",
);
assert.ok(mergedFuncRegistry);
assert.ok(mergedTupleRegistry);
assert.equal(
  [...mergedFuncRegistry.source.matchAll(/public interface ApexXFunc_[0-9a-f]{12}/g)].length,
  2,
);
assert.equal(
  [...mergedTupleRegistry.source.matchAll(/public class ApexXTuple_[0-9a-f]{12}/g)].length,
  2,
);
assert.equal(parseApex(mergedFuncRegistry.source).ok, true);
assert.equal(parseApex(mergedTupleRegistry.source).ok, true);

const invalidTupleResult = transpileApexX(`public class InvalidTupleProbe {
    public static (Decimal, Integer) calculate() {
        return (10);
    }
}`, { sourceFileName: "InvalidTupleProbe.clsx" });
assert.ok(
  invalidTupleResult.diagnostics.some(diagnostic =>
    diagnostic.code === "APXX2406" && diagnostic.message.includes("received 1"),
  ),
);

const auraTupleResult = transpileApexX(`public class AuraTupleProbe {
    @AuraEnabled
    public static (Decimal, Integer) calculate() {
        return (10, 2);
    }
}`, { sourceFileName: "AuraTupleProbe.clsx" });
assert.ok(
  auraTupleResult.diagnostics.some(diagnostic =>
    diagnostic.code === "APXX2403",
  ),
);

execFileSync(
  process.execPath,
  ["packages/cli/dist/index.js", "build"],
  { cwd: root, stdio: "inherit" },
);

const accountOutput = fs.readFileSync(
  path.join(
    root,
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
    "force-app",
    "main",
    "default",
    "classes",
    "AccountService.cls-meta.xml",
  ),
    "utf8",
);
const supportOutput = fs.readFileSync(
  path.join(
    root,
    "force-app",
    "main",
    "default",
    "classes",
    "ApexX.cls",
  ),
  "utf8",
);
const userFriendlyErrorOutput = fs.readFileSync(
  path.join(
    root,
    "force-app",
    "main",
    "default",
    "classes",
    "UserFriendlyError.cls",
  ),
  "utf8",
);
const lwcUtilOutput = fs.readFileSync(
  path.join(
    root,
    "force-app",
    "main",
    "default",
    "classes",
    "LwcUtil.cls",
  ),
  "utf8",
);

assert.match(accountOutput, /List<Account> apexxFilter0 = new List<Account>\(\);/);
assert.match(accountOutput, /public static List<Account> loadPriorityAccounts\(\)/);
assert.match(accountOutput, /public static List<String> loadNormalizedContactEmails\(\)/);
assert.match(accountOutput, /public static List<AccountWorkItem> loadRenewalWork\(\)/);
assert.match(accountOutput, /public static AccountSummary loadAccountSummary\(\)/);
assert.match(accountOutput, /public static Boolean loadRevenueComparison\(\)/);
assert.match(accountOutput, /public static void triggerUserFriendlyError\(\)/);
assert.match(accountOutput, /public static void triggerRawError\(\)/);
assert.match(accountOutput, /public static ShowcaseOverview loadShowcaseOverview\(\)/);
assert.match(accountOutput, /public static EmailPipelineResult runEmailPipeline\(\)/);
assert.match(accountOutput, /public static StrategyResult runRenewalStrategy\(String mode\)/);
assert.match(
  accountOutput,
  /public static RevenueComparisonResult runRevenueComparison\(\s*Decimal absoluteTolerance,\s*Decimal percentageTolerance\s*\)/,
);
assert.match(accountOutput, /public static PortfolioBriefing runPortfolioBriefing\(String mode, Decimal minimumRevenue\)/);
assert.match(accountOutput, /public static PortfolioBriefing buildPortfolioBriefing\(List<Account> accounts, String mode\)/);
assert.match(accountOutput, /new UserFriendlyError\(\)\.handle\(new ApexX\.Invocation\('AccountService', 'loadPriorityAccounts'/);
assert.match(accountOutput, /'message' => 'The operation failed safely\. Internal details were hidden\.'/);
assert.match(accountOutput, /MIN_REVENUE_PER_EMPLOYEE = 10000/);
assert.match(accountOutput, /account\.NumberOfEmployees > 0/);
assert.match(accountOutput, /account\.AnnualRevenue \/ account\.NumberOfEmployees >= MIN_REVENUE_PER_EMPLOYEE/);
assert.match(accountOutput, /contact\.Email\.contains\('@'\)/);
assert.match(accountOutput, /contact\.Email\.trim\(\)\.toLowerCase\(\)/);
assert.doesNotMatch(accountOutput, /account\.AccountNumber != null\)\s*\{\s*apexxFilter\d+\.add\(account\);\s*\}\s*\}\s*List<Account> apexxFilter\d+/s);
assert.match(
  accountOutput,
  /public static List<AccountWorkItem> buildRenewalWork\(\s*List<Account> accounts,\s*ApexXFuncs\.ApexXFunc_[0-9a-f]{12} shouldEscalate,\s*String escalationReason\s*\)/,
);
assert.match(
  accountOutput,
  /ApexXTuples\.ApexXTuple_[0-9a-f]{12} apexxTuple\d+ = PortfolioRuleProvider\.resolve\(mode\);\s*ApexXFuncs\.ApexXFunc_[0-9a-f]{12} shouldEscalate = apexxTuple\d+\.item0;/,
);
assert.match(accountOutput, /Boolean escalate = shouldEscalate\.invoke\(account\);/);
assert.match(accountOutput, /apexxMap\d+\.add\(new AccountWorkItem\(/);
assert.match(accountOutput, /new Map<String, Object>\(\)/);
assert.match(accountOutput, /'message' => 'Unable to save account\.'/);
assert.match(accountOutput, /List<Contact> apexxFlatMap0 = new List<Contact>\(\);/);
assert.match(accountOutput, /Integer apexxCount0 = 0;/);
assert.match(accountOutput, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} isHot = new ApexXLambda\d+\(\);/);
assert.match(accountOutput, /if \(isHot\.invoke\(account\)\) \{/);
assert.match(accountOutput, /Boolean apexxAll0 = true;/);
assert.match(accountOutput, /Account apexxFind0 = null;/);
assert.match(accountOutput, /return compareRevenue\(left, right, 0, 0\);/);
assert.match(
  accountOutput,
  /return compareRevenue\(left, right, absoluteTolerance, 0\);/,
);
assert.doesNotMatch(accountOutput, /isWithinTolerance/);
assert.match(plainOutput, /public with sharing class PlainApex/);
assert.match(plainOutput, /public static String formatStatus\(String subject\)/);
assert.match(plainOutput, /return formatStatus\(subject, false, 'Info'\);/);
assert.match(plainOutput, /apexxMap0\.add\(square\.invoke\(numberValue\)\);/);
assert.match(supportOutput, /public interface Decorator/);
assert.match(userFriendlyErrorOutput, /ctx\.config\.get\('message'\)/);
assert.match(lwcUtilOutput, /DEFAULT_UNEXPECTED_ERROR_MESSAGE = 'Unexpected Error'/);
assert.match(
  accountMetadata,
  /<ApexClass xmlns="http:\/\/soap\.sforce\.com\/2006\/04\/metadata">/,
);
assert.match(accountMetadata, /<status>Active<\/status>/);

const editingSourceWithoutSemicolon = `public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        return accounts.filter(a => a.Rating == 'Hot')
    }
}
`;
const editingResult = transpileApexX(editingSourceWithoutSemicolon, {
  sourceFileName: "AccountService.clsx",
});
const editingErrors = editingResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(editingErrors, []);
assert.match(editingResult.output, /return apexxFilter0;/);

const chainedFilterSource = `public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        return accounts.filter(a => a.AccountNumber == 'Hot')
            .filter(acc => acc.Rating == 'ABC');
    }
}
`;
const chainedFilterResult = transpileApexX(chainedFilterSource, {
  sourceFileName: "AccountService.clsx",
});
const chainedFilterErrors = chainedFilterResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(chainedFilterErrors, []);
assert.match(chainedFilterResult.output, /for \(Account a : accounts\)/);
assert.match(chainedFilterResult.output, /for \(Account acc : apexxFilter0\)/);
assert.match(chainedFilterResult.output, /return apexxFilter1;/);

const expressionFilterSource = `public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        accounts.filter(acc => acc.Rating == 'Hot');
        return accounts.filter(a => a.AccountNumber == 'Hot')
            .filter(acc => acc.AccountNumber != 'ABC');
    }
}
`;
const expressionFilterResult = transpileApexX(expressionFilterSource, {
  sourceFileName: "AccountService.clsx",
});
const expressionFilterErrors = expressionFilterResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(expressionFilterErrors, []);
assert.match(expressionFilterResult.output, /for \(Account acc : accounts\)/);
assert.match(expressionFilterResult.output, /for \(Account a : accounts\)/);
assert.match(expressionFilterResult.output, /for \(Account acc : apexxFilter1\)/);
assert.match(expressionFilterResult.output, /return apexxFilter2;/);
assert.doesNotMatch(expressionFilterResult.output, /Unsupported lambda form/);

// A lambda parameter may be parenthesised. A Func assignment always accepted `(i) =>`,
// while a List<T> method took only the bare `i =>` and rejected the other form outright
// -- the same lambda was legal or not depending on which call it was passed to.
const parenthesizedLambdaSource = `public with sharing class AccountService {
    public static List<String> names(List<Account> accounts) {
        List<Account> withRevenue = accounts.filter((a) => a.AnnualRevenue != null);
        accounts.filter((acc) => acc.Rating == 'Hot');
        return withRevenue
            .filter((a) => a.Name != null)
            .map((a) => a.Name);
    }
}
`;
const parenthesizedLambdaResult = transpileApexX(parenthesizedLambdaSource, {
  sourceFileName: "AccountService.clsx",
});
assert.deepEqual(
  parenthesizedLambdaResult.diagnostics.filter(d => d.severity === "error"),
  [],
  "a parenthesised lambda parameter is legal in a List<T> method",
);
assert.match(parenthesizedLambdaResult.output, /for \(Account a : accounts\)/);
assert.match(parenthesizedLambdaResult.output, /for \(Account acc : accounts\)/);
assert.match(parenthesizedLambdaResult.output, /apexxMap0\.add\(a\.Name\);/);
assert.doesNotMatch(parenthesizedLambdaResult.output, /Unsupported lambda form/);

// The bare and parenthesised forms have to lower to the same Apex, or the choice of
// form would quietly change the generated code.
const bareEquivalent = transpileApexX(
  parenthesizedLambdaSource.replace(/\((\w+)\) =>/g, "$1 =>"),
  { sourceFileName: "AccountService.clsx" },
);
assert.equal(
  parenthesizedLambdaResult.output,
  bareEquivalent.output,
  "`(a) =>` and `a =>` must lower identically",
);

// A chain nested inside another expression is hoisted: the loop is emitted before the
// statement and the chain is replaced by the name holding its result. Without this, the
// most ordinary use of a lambda -- passing the result straight to something else -- was
// a compile error.
const embeddedChainSource = `public with sharing class AccountService {
    public static void log(List<Account> accounts) {
        System.debug(accounts.filter((a) => a.Name != null));
    }

    public static void logNames(List<Account> accounts) {
        System.debug(LoggingLevel.ERROR, 'n=' + accounts.map(a => a.Name).size());
    }

    public static Set<String> uniqueNames(List<Account> accounts) {
        Set<String> names = new Set<String>(accounts.map(a => a.Name));
        return names;
    }
}
`;
const embeddedChainResult = transpileApexX(embeddedChainSource, {
  sourceFileName: "AccountService.clsx",
});
assert.deepEqual(
  embeddedChainResult.diagnostics.filter(d => d.severity === "error"),
  [],
  "a nested List<T> chain should be hoisted, not rejected",
);
assert.match(embeddedChainResult.output, /for \(Account a : accounts\) \{/);
assert.match(embeddedChainResult.output, /System\.debug\(apexxFilter0\);/);
assert.match(embeddedChainResult.output, /System\.debug\(LoggingLevel\.ERROR, 'n=' \+ apexxMap0\.size\(\)\);/);
assert.match(embeddedChainResult.output, /new Set<String>\(apexxMap1\);/);
// The loop has to land above the statement that consumes it, or the temp is used first.
const debugLine = embeddedChainResult.output.split("\n").findIndex(line => line.includes("System.debug(apexxFilter0)"));
const loopLine = embeddedChainResult.output.split("\n").findIndex(line => line.includes("List<Account> apexxFilter0"));
assert.ok(loopLine >= 0 && loopLine < debugLine, "the loop must precede the statement using its result");
// The generated Apex has to be real Apex, not just plausible text.
assert.deepEqual(
  parseApex(embeddedChainResult.output, "AccountService.cls").diagnostics.filter(
    diagnostic => diagnostic.severity === "error",
  ),
  [],
  "hoisting must produce parseable Apex",
);

// Hoisting is refused where it would change when the chain runs, and each refusal says
// which reason applies -- the fix is the same but the cause is not.
for (const [body, expected] of [
  ["        System.debug(flag && accounts.any(a => a.Name != null));", /after '&&', '\|\|' or in a ternary arm/],
  ["        System.debug(flag ? accounts.map(a => a.Name) : null);", /after '&&', '\|\|' or in a ternary arm/],
  ["        if (accounts.any(a => a.Name != null)) { System.debug('x'); }", /header of an if, for, while or switch/],
  ["        System.debug(accounts.map(a => a.Name) + accounts.map(a => a.Id));", /Only one ApexX List<T> call can be nested/],
]) {
  const guarded = transpileApexX(`public with sharing class AccountService {
    public static void run(List<Account> accounts, Boolean flag) {
${body}
    }
}
`, { sourceFileName: "AccountService.clsx" });
  const guardedErrors = guarded.diagnostics.filter(d => d.severity === "error");
  assert.ok(guardedErrors.length >= 1, `expected a refusal for: ${body.trim()}`);
  assert.match(guardedErrors[0].message, expected);
  // A refused chain must be left alone rather than half-lowered into broken Apex.
  assert.doesNotMatch(guarded.output, /apexxAny|apexxMap/);
}

// A single lambda parameter may drop its parentheses, in both directions and in every
// position -- List<T> methods took only the bare form, Func assignments only the
// parenthesised one, so the same lambda was legal or not depending on where it went.
const lambdaParameterShapes = parameter => `public with sharing class AccountService {
    public static List<String> names(List<Account> accounts) {
        Func<Account, Boolean> rule = ${parameter} => a.Name != null;
        Func<Account, Boolean> block = ${parameter} => {
            return a.Name != null;
        };
        rule = ${parameter} => a.AnnualRevenue != null;
        return accounts.filter(${parameter} => rule.invoke(a)).map(${parameter} => a.Name);
    }
}
`;
const bareParameters = transpileApexX(lambdaParameterShapes("a"), {
  sourceFileName: "AccountService.clsx",
});
const parenthesizedParameters = transpileApexX(lambdaParameterShapes("(a)"), {
  sourceFileName: "AccountService.clsx",
});
assert.deepEqual(
  bareParameters.diagnostics.filter(d => d.severity === "error"),
  [],
  "a bare single lambda parameter is legal everywhere a parenthesised one is",
);
assert.deepEqual(
  parenthesizedParameters.diagnostics.filter(d => d.severity === "error"),
  [],
);
assert.equal(
  bareParameters.output,
  parenthesizedParameters.output,
  "`a =>` and `(a) =>` must lower identically",
);
// Two parameters still need their parentheses, as in JS.
assert.deepEqual(
  transpileApexX(`public with sharing class AccountService {
    public static Boolean compare(List<Account> accounts) {
        Func<Account, Account, Boolean> same = (a, b) => a.Name == b.Name;
        return same.invoke(accounts.get(0), accounts.get(1));
    }
}
`, { sourceFileName: "AccountService.clsx" }).diagnostics.filter(d => d.severity === "error"),
  [],
);

// A chain the statement continues past is hoisted, not claimed by the statement pass.
// Claiming it spliced the trailing call away and reported a bogus type mismatch.
const trailingCallResult = transpileApexX(`public with sharing class AccountService {
    public static Integer hotCount(List<Account> accounts) {
        Integer total = accounts.filter(a => a.Rating == 'Hot').size();
        return total;
    }
}
`, { sourceFileName: "AccountService.clsx" });
assert.deepEqual(
  trailingCallResult.diagnostics.filter(d => d.severity === "error"),
  [],
  "a chain followed by another call should hoist",
);
assert.match(trailingCallResult.output, /Integer total = apexxFilter0\.size\(\);/);
assert.deepEqual(
  parseApex(trailingCallResult.output, "AccountService.cls").diagnostics.filter(
    diagnostic => diagnostic.severity === "error",
  ),
  [],
);

// A block lambda body is found by matching braces, not by regex. The regex anchored the
// closing brace at the start of a line, so a one-line block body was not a lambda at all.
for (const [name, body] of [
  ["one line", "        Func<Account, Boolean> f = a => { return a.Name != null; };"],
  ["one line, parenthesised", "        Func<Account, Boolean> f = (a) => { return a.Name != null; };"],
  ["one line, nested braces", "        Func<Account, Boolean> f = a => { if (a.Name == null) { return false; } return true; };"],
  ["one line, reassigned", "        Func<Account, Boolean> f = a => true;\n        f = a => { return a.Name != null; };"],
  ["multi line", "        Func<Account, Boolean> f = a => {\n            return a.Name != null;\n        };"],
]) {
  const blockResult = transpileApexX(`public with sharing class AccountService {
    public static Boolean run(List<Account> accounts) {
${body}
        return f.invoke(accounts.get(0));
    }
}
`, { sourceFileName: "AccountService.clsx" });
  assert.deepEqual(
    blockResult.diagnostics.filter(d => d.severity === "error"),
    [],
    `a block lambda written ${name} should compile`,
  );
  assert.match(blockResult.output, /class ApexXLambda0 implements ApexXFuncs\./);
  assert.deepEqual(
    parseApex(blockResult.output, "AccountService.cls").diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    ),
    [],
    `a block lambda written ${name} should generate parseable Apex`,
  );
}

// A Func type argument may itself be generic. `[^>]+?` stopped at the inner `>`, so
// `Func<List<Account>, Integer>` was read as `Func<List<Account` and the generated line
// came out as `ApexXFuncs.ApexXFunc_..., Integer> f = ...` -- corrupt, not merely wrong.
for (const [funcType, parameter, expectedSignature] of [
  ["Func<List<Account>, Integer>", "xs => xs.size()", /public Integer invoke\(List<Account> xs\)/],
  ["Func<Map<Id, String>, Boolean>", "m => m.isEmpty()", /public Boolean invoke\(Map<Id,\s?String> m\)/],
  ["Func<Account, Boolean>", "a => a.Name != null", /public Boolean invoke\(Account a\)/],
]) {
  const genericResult = transpileApexX(`public with sharing class AccountService {
    public static void run() {
        ${funcType} f = ${parameter};
    }
}
`, { sourceFileName: "AccountService.clsx" });
  assert.deepEqual(
    genericResult.diagnostics.filter(d => d.severity === "error"),
    [],
    `${funcType} should compile`,
  );
  assert.match(genericResult.output, expectedSignature);
  assert.doesNotMatch(
    genericResult.output,
    /ApexXFunc_[0-9a-f]+,/,
    `${funcType} must not leak a split type argument into the generated line`,
  );
  assert.deepEqual(
    parseApex(genericResult.output, "AccountService.cls").diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    ),
    [],
  );
}

// Each unsupported shape has to be reported as the thing that is actually wrong. A
// receiver the element-type lookup cannot resolve was previously reported as a nesting
// problem, which sends the reader to move code that was never the issue.
for (const [body, expected] of [
  ["        wrapper.accounts.filter(a => a.Name != null);", /receiver of an ApexX List<T> call/],
  ["        getAccounts().filter(a => a.Name != null);", /receiver of an ApexX List<T> call/],
  ["        for (Account a : accounts.filter(x => x.Name != null)) { System.debug(a); }", /header of an if, for, while or switch/],
  ["        System.debug(flag && accounts.any(a => a.Name != null));", /after '&&', '\|\|' or in a ternary arm/],
]) {
  const reported = transpileApexX(`public with sharing class AccountService {
    public static void run(List<Account> accounts, Boolean flag, Wrapper wrapper) {
${body}
    }

    public static List<Account> getAccounts() {
        return null;
    }
}
`, { sourceFileName: "AccountService.clsx" }).diagnostics.filter(d => d.severity === "error");
  assert.ok(reported.length >= 1, `expected a diagnostic for: ${body.trim()}`);
  assert.match(reported[0].message, expected);
}

// A chain broken across lines is the normal way to write more than one step, and the
// receiver commonly sits on its own line. The embedded pass matched the receiver only
// where it ended exactly at the dot, so a newline before `.filter` read as an
// unresolvable receiver -- while the same chain with the first step on the receiver's
// line compiled.
const multilineEmbedded = transpileApexX(`public with sharing class AccountService {
    public static void run(List<Integer> numbers) {
        System.debug(numbers
            .filter(number => number >= 3)
            .map(number => number * 2)
        );
    }
}
`, { sourceFileName: "AccountService.clsx" });
assert.deepEqual(
  multilineEmbedded.diagnostics.filter(d => d.severity === "error"),
  [],
  "a nested chain split across lines should hoist",
);
// The line breaks the chain occupied must not survive its collapse to a single name.
assert.match(multilineEmbedded.output, /System\.debug\(apexxMap0\);/);
assert.deepEqual(
  parseApex(multilineEmbedded.output, "AccountService.cls").diagnostics.filter(
    diagnostic => diagnostic.severity === "error",
  ),
  [],
);
// Where the receiver sits must not change the generated Apex.
const sameLineEmbedded = transpileApexX(`public with sharing class AccountService {
    public static void run(List<Integer> numbers) {
        System.debug(numbers.filter(number => number >= 3).map(number => number * 2));
    }
}
`, { sourceFileName: "AccountService.clsx" });
assert.equal(
  multilineEmbedded.output,
  sameLineEmbedded.output,
  "breaking a chain across lines must not change what it compiles to",
);

const mapAssignmentSource = `public with sharing class AccountService {
    public static List<String> accountNames(List<Account> accounts) {
        List<String> names = accounts.map(a => a.Name);
        return names;
    }
}
`;
const mapAssignmentResult = transpileApexX(mapAssignmentSource, {
  sourceFileName: "AccountService.clsx",
});
const mapAssignmentErrors = mapAssignmentResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(mapAssignmentErrors, []);
assert.match(mapAssignmentResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(mapAssignmentResult.output, /for \(Account a : accounts\)/);
assert.match(mapAssignmentResult.output, /apexxMap0\.add\(a\.Name\);/);
assert.match(mapAssignmentResult.output, /List<String> names = apexxMap0;/);

const filterMapReturnSource = `public with sharing class AccountService {
    public static List<String> hotAccountNames(List<Account> accounts) {
        return accounts.filter(a => a.Rating == 'Hot')
            .map(a => a.Name);
    }
}
`;
const filterMapReturnResult = transpileApexX(filterMapReturnSource, {
  sourceFileName: "AccountService.clsx",
});
const filterMapReturnErrors = filterMapReturnResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(filterMapReturnErrors, []);
assert.match(filterMapReturnResult.output, /List<Account> apexxFilter0 = new List<Account>\(\);/);
assert.match(filterMapReturnResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(filterMapReturnResult.output, /for \(Account a : apexxFilter0\)/);
assert.match(filterMapReturnResult.output, /return apexxMap0;/);

const mapFilterReturnSource = `public with sharing class AccountService {
    public static List<String> accountNumbers(List<Account> accounts) {
        return accounts.map(a => a.AccountNumber)
            .filter(value => value != null);
    }
}
`;
const mapFilterReturnResult = transpileApexX(mapFilterReturnSource, {
  sourceFileName: "AccountService.clsx",
});
const mapFilterReturnErrors = mapFilterReturnResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(mapFilterReturnErrors, []);
assert.match(mapFilterReturnResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(mapFilterReturnResult.output, /for \(String value : apexxMap0\)/);
assert.match(mapFilterReturnResult.output, /return apexxFilter0;/);

const multiMapReturnSource = `public with sharing class AccountService {
    public static List<String> upperAccountNumbers(List<Account> accounts) {
        return accounts
            .map(a => a.AccountNumber)
            .map(accountNumber => accountNumber.toUpperCase());
    }
}
`;
const multiMapReturnResult = transpileApexX(multiMapReturnSource, {
  sourceFileName: "AccountService.clsx",
});
const multiMapReturnErrors = multiMapReturnResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(multiMapReturnErrors, []);
assert.match(multiMapReturnResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(multiMapReturnResult.output, /for \(Account a : accounts\)/);
assert.match(multiMapReturnResult.output, /apexxMap0\.add\(a\.AccountNumber\);/);
assert.match(multiMapReturnResult.output, /List<String> apexxMap1 = new List<String>\(\);/);
assert.match(multiMapReturnResult.output, /for \(String accountNumber : apexxMap0\)/);
assert.match(multiMapReturnResult.output, /apexxMap1\.add\(accountNumber\.toUpperCase\(\)\);/);
assert.match(multiMapReturnResult.output, /return apexxMap1;/);

const dateMapReturnSource = `public with sharing class AccountService {
    public static List<Integer> createdYears(List<Account> accounts) {
        return accounts
            .map(a => a.CreatedDate.date())
            .map(createdDate => createdDate.year());
    }
}
`;
const dateMapReturnResult = transpileApexX(dateMapReturnSource, {
  sourceFileName: "AccountService.clsx",
});
const dateMapReturnErrors = dateMapReturnResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(dateMapReturnErrors, []);
assert.match(dateMapReturnResult.output, /List<Date> apexxMap0 = new List<Date>\(\);/);
assert.match(dateMapReturnResult.output, /for \(Date createdDate : apexxMap0\)/);
assert.match(dateMapReturnResult.output, /List<Integer> apexxMap1 = new List<Integer>\(\);/);
assert.match(dateMapReturnResult.output, /return apexxMap1;/);

const staticCallMapSource = `public with sharing class AccountService {
    public static List<String> ownerLabels(List<Account> accounts) {
        return accounts.map(a => String.valueOf(a.OwnerId).toUpperCase());
    }
}
`;
const staticCallMapResult = transpileApexX(staticCallMapSource, {
  sourceFileName: "AccountService.clsx",
});
const staticCallMapErrors = staticCallMapResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(staticCallMapErrors, []);
assert.match(staticCallMapResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(staticCallMapResult.output, /apexxMap0\.add\(String\.valueOf\(a\.OwnerId\)\.toUpperCase\(\)\);/);

const invalidFilterPredicateSource = `public with sharing class AccountService {
    public static List<Account> invalid(List<Account> accounts) {
        return accounts.filter(a => a.Name);
    }
}
`;
const invalidFilterPredicateResult = transpileApexX(invalidFilterPredicateSource, {
  sourceFileName: "AccountService.clsx",
});
assert.match(
  invalidFilterPredicateResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
  /filter\(\.\.\.\) expects a Boolean predicate, but this lambda returns String\./,
);

const mismatchedMapResultSource = `public with sharing class AccountService {
    public static List<Integer> invalid(List<Account> accounts) {
        return accounts.map(a => a.Name);
    }
}
`;
const mismatchedMapResult = transpileApexX(mismatchedMapResultSource, {
  sourceFileName: "AccountService.clsx",
});
assert.match(
  mismatchedMapResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
  /List chain returns List<String>, but the surrounding context expects List<Integer>\./,
);

// Diagnostics are produced against intermediate pipeline text but reported against
// the authored file, so a stage that adds or removes lines above an error used to
// slide its squiggle onto the wrong statement.
const driftSource = `public with sharing class DriftProbe {
    public static (Decimal, Integer) split() {
        return (10.5, 2);
    }

    public static void consume() {
        (Decimal revenue, Integer count) = split();
    }

    @AuraEnabled
    @NoSuchDecorator
    public static void annotated() {
    }

    @NoSuchDecorator
    public void notStatic() {
    }

    public static void badDefaults(Integer first = 1, Integer second) {
    }

    public static List<String> names(List<Account> accounts) {
        return accounts
            .filter(account => account.Name != null)
            .map(account => account.AnnualRevenue);
    }
}
`;
const driftLines = driftSource.split("\n");
const driftResult = transpileApexX(driftSource, { sourceFileName: "DriftProbe.clsx" });
// Each diagnostic has to cover the construct it is about, and nothing more: an
// annotation block used to report against its first line whichever annotation was
// at fault, and a parameter or modifier problem used to underline the whole method.
const driftExpectations = [
  [/List chain returns List<Decimal>/, ".map(account => account.AnnualRevenue);"],
  [/Unknown ApexX annotation @NoSuchDecorator/, "@NoSuchDecorator"],
  [/Default parameter values must be trailing/, "Integer second"],
];

for (const [message, expectedText] of driftExpectations) {
  const diagnostic = driftResult.diagnostics.find(entry => message.test(entry.message));
  assert.ok(diagnostic, `expected a diagnostic matching ${message}`);
  const reported = driftSource.slice(
    diagnostic.range.start.offset,
    diagnostic.range.end.offset,
  );
  assert.ok(
    reported.includes(expectedText),
    `${message} was reported at line ${diagnostic.range.start.line} (${JSON.stringify(
      driftLines[diagnostic.range.start.line - 1],
    )}), which does not cover ${JSON.stringify(expectedText)}`,
  );
  assert.equal(
    diagnostic.range.start.line,
    driftSource.slice(0, diagnostic.range.start.offset).split("\n").length,
    "diagnostic line must match its authored offset",
  );
  assert.equal(
    reported,
    reported.trim(),
    `${message} underlines the whitespace around ${JSON.stringify(reported)}`,
  );
}

// The reported annotation is the faulty one, not whichever one happens to be first
// in the block, and both methods that carry it are reported.
const annotationDiagnostics = driftResult.diagnostics.filter(diagnostic =>
  /Unknown ApexX annotation/.test(diagnostic.message),
);
assert.equal(annotationDiagnostics.length, 2);
for (const diagnostic of annotationDiagnostics) {
  assert.equal(
    driftSource.slice(diagnostic.range.start.offset, diagnostic.range.end.offset),
    "@NoSuchDecorator",
  );
}

// A Func lambda body has to satisfy the return type its declaration promises. The
// lowering drops the body into `invoke()` on a generated class, so without this the
// only complaint comes from the platform compiler, about a class nobody wrote.
const lambdaReturnSource = `public with sharing class LambdaProbe {
    public static void run(List<Account> accounts) {
        Func<Account, Boolean> declared = (account) => account.Name;
        Func<Account, Boolean> rule;
        rule = (account) => {
            Boolean hasNumber = account.AccountNumber != null;
            return 10;
        };
        Func<Account, Decimal> revenue = (account) => 2;
        Func<Account, Boolean> fine = (account) => {
            if (account.Name == null) {
                return false;
            }

            return account.Rating == 'Hot' && account.AccountNumber != null;
        };
        System.debug(declared);
        System.debug(rule);
        System.debug(revenue);
        System.debug(fine);
    }
}
`;
const lambdaReturnResult = transpileApexX(lambdaReturnSource, {
  sourceFileName: "LambdaProbe.clsx",
});
const lambdaReturnErrors = lambdaReturnResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(
  lambdaReturnErrors.map(diagnostic => diagnostic.message),
  [
    "Func<Account, Boolean> must return Boolean, but this returns String.",
    "Func<Account, Boolean> must return Boolean, but this returns Integer.",
  ],
  // `Func<Account, Decimal> = (account) => 2` is legal: Apex widens Integer to
  // Decimal. So is a block lambda with a return in each branch.
  `unexpected lambda diagnostics: ${JSON.stringify(lambdaReturnErrors, null, 2)}`,
);
for (const diagnostic of lambdaReturnErrors) {
  const reported = lambdaReturnSource.slice(
    diagnostic.range.start.offset,
    diagnostic.range.end.offset,
  );
  assert.ok(
    reported === "account.Name" || reported === "10",
    `lambda diagnostic should cover the returned expression, got ${JSON.stringify(reported)}`,
  );
}

// Tuple values and destructuring bindings have to match the tuple contract. A
// mismatch otherwise reaches the platform compiler as an error about a generated
// carrier class, naming none of the types the author wrote.
const tupleTypeSource = `public with sharing class TupleTypeProbe {
    public static (Decimal, Integer) split() {
        return ('nope', 2);
    }

    public static (Decimal, Integer) widened() {
        return (10, 2);
    }

    public static void consume() {
        (String revenue, Integer count) = split();
        (Decimal ok, Integer alsoOk) = widened();
        (Decimal tooMany, Integer second, Boolean third) = widened();
        System.debug(revenue + count + ok + alsoOk + tooMany + second + third);
    }
}
`;
const tupleTypeResult = transpileApexX(tupleTypeSource, {
  sourceFileName: "TupleTypeProbe.clsx",
});
const tupleTypeMessages = tupleTypeResult.diagnostics
  .filter(diagnostic => diagnostic.severity === "error")
  .map(diagnostic => `${diagnostic.code} ${diagnostic.message}`);
assert.deepEqual(
  tupleTypeMessages,
  [
    "APXX2412 Tuple element 1 expects Decimal, but received String.",
    "APXX2414 split(...) returns Decimal here, which does not fit String.",
    "APXX2413 widened(...) returns 2 values, but this destructuring declares 3.",
  ],
  // `return (10, 2)` into `(Decimal, Integer)` is legal widening, and the matching
  // destructuring of it must stay silent.
  `unexpected tuple diagnostics: ${JSON.stringify(tupleTypeMessages, null, 2)}`,
);

// The conditional operator binds loosest of all, so a ternary whose condition holds a
// comparison used to be typed from that comparison -- `cond ? 0 : revenue` read as
// Boolean. Every check that infers an expression type depends on this.
const ternarySource = `public with sharing class TernaryProbe {
    public static List<Decimal> revenues(List<Account> accounts) {
        return accounts.map(account => account.AnnualRevenue == null ? 0 : account.AnnualRevenue);
    }

    public static (Decimal, Integer) split(Account account) {
        return (account.AnnualRevenue == null ? 0 : account.AnnualRevenue, 1);
    }

    public static void lambdas(List<Account> accounts) {
        Func<Account, Decimal> widened = (account) =>
            account.AnnualRevenue == null ? 0 : account.AnnualRevenue;
        Func<Account, String> nullable = (account) =>
            account.Name == null ? null : account.Name;
        Func<Account, Decimal> nested = (account) =>
            account.Rating == 'Hot' ? 1 : account.Rating == 'Warm' ? 2.5 : 0;
        Func<Account, String> guarded = (account) =>
            String.valueOf(account.Name == null ? 0 : 1);
        System.debug(widened);
        System.debug(nullable);
        System.debug(nested);
        System.debug(guarded);
    }
}
`;
assert.deepEqual(
  transpileApexX(ternarySource, {
    sourceFileName: "TernaryProbe.clsx",
    workspaceRoot: root,
  }).diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
  "a ternary should take its type from its branches, not from its condition",
);

// The inference is not merely quiet -- a ternary whose branches really are the wrong
// type is still reported, in an expression body and in a block return alike.
const ternaryErrorSource = `public with sharing class TernaryErrorProbe {
    public static void run(List<Account> accounts) {
        Func<Account, Boolean> expression = (account) =>
            account.Name == null ? 'a' : 'b';
        Func<Account, Boolean> block = (account) => {
            return account.Name == null ? 'a' : 'b';
        };
        System.debug(expression);
        System.debug(block);
    }
}
`;
assert.deepEqual(
  transpileApexX(ternaryErrorSource, {
    sourceFileName: "TernaryErrorProbe.clsx",
    workspaceRoot: root,
  })
    .diagnostics.filter(diagnostic => diagnostic.severity === "error")
    .map(diagnostic => diagnostic.message),
  [
    "Func<Account, Boolean> must return Boolean, but this returns String.",
    "Func<Account, Boolean> must return Boolean, but this returns String.",
  ],
);

// A tuple put into a Map value is checked against the same contract as a return.
const mapTupleValueSource = `public with sharing class MapTupleProbe {
    public static void run() {
        Map<Id, (Decimal, Integer)> byId = new Map<Id, (Decimal, Integer)>();
        byId.put('001000000000000AAA', ('nope', 2));
        byId.put('001000000000001AAA', (10, 2));
        System.debug(byId);
    }
}
`;
assert.deepEqual(
  transpileApexX(mapTupleValueSource, { sourceFileName: "MapTupleProbe.clsx" })
    .diagnostics.filter(diagnostic => diagnostic.severity === "error")
    .map(diagnostic => `${diagnostic.code} ${diagnostic.message}`),
  ["APXX2412 Tuple element 1 expects Decimal, but received String."],
  // The second put widens Integer to Decimal, which Apex does silently.
);

// Every return in a block lambda is checked on its own, and a Func value typed by a
// method parameter is as visible as a local declaration.
const branchingLambdaSource = `public with sharing class BranchingLambdaProbe {
    public static void run(Func<Account, Boolean> injected) {
        Func<Account, Boolean> branching = (account) => {
            if (account.Name == null) {
                return account.Rating == 'Hot';
            }

            if (account.AccountNumber == null) {
                return 'nope';
            }

            return 10;
        };
        injected = (account) => 10;
        System.debug(branching);
        System.debug(injected);
    }
}
`;
const branchingLambdaResult = transpileApexX(branchingLambdaSource, {
  sourceFileName: "BranchingLambdaProbe.clsx",
});
const branchingLambdaErrors = branchingLambdaResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(
  branchingLambdaErrors.map(diagnostic => diagnostic.message),
  [
    "Func<Account, Boolean> must return Boolean, but this returns String.",
    "Func<Account, Boolean> must return Boolean, but this returns Integer.",
    "Func<Account, Boolean> must return Boolean, but this returns Integer.",
  ],
  `unexpected branching lambda diagnostics: ${JSON.stringify(branchingLambdaErrors, null, 2)}`,
);
assert.deepEqual(
  branchingLambdaErrors.map(diagnostic =>
    branchingLambdaSource.slice(
      diagnostic.range.start.offset,
      diagnostic.range.end.offset,
    ),
  ),
  ["'nope'", "10", "10"],
  // The first return of the block is the correct one, so a checker that stopped
  // after it would report nothing here.
  "only the offending returns should be underlined",
);

// These checks report what they can prove and nothing else. A type this compiler
// cannot infer, and a call it cannot resolve to one method, must stay silent --
// a false positive on working code is worse than a missed error.
const quietGuardSource = `public with sharing class QuietGuardProbe {
    public static (Decimal, Integer) split() {
        return (1.0, 2);
    }

    public static (String, Boolean) split(String mode) {
        return (mode, true);
    }

    public static void run(String mode) {
        Func<Account, Boolean> unknown = (account) => SomeOtherClass.helper(account);
        (String label, Boolean flag) = split(mode);
        System.debug(unknown);
        System.debug(label + flag);
    }
}
`;
assert.deepEqual(
  transpileApexX(quietGuardSource, { sourceFileName: "QuietGuardProbe.clsx" })
    .diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);

// A `_` placeholder still declares a type, so it is checked like any other binding.
const placeholderTupleSource = `public with sharing class PlaceholderTupleProbe {
    public static (Decimal, Integer) split() {
        return (1.0, 2);
    }

    public static void run() {
        (String wrong, Integer _) = split();
        System.debug(wrong);
    }
}
`;
assert.deepEqual(
  transpileApexX(placeholderTupleSource, { sourceFileName: "PlaceholderTupleProbe.clsx" })
    .diagnostics.filter(diagnostic => diagnostic.severity === "error")
    .map(diagnostic => `${diagnostic.code} ${diagnostic.message}`),
  ["APXX2414 split(...) returns Decimal here, which does not fit String."],
);

// A call this file cannot resolve is left alone rather than guessed at.
const crossFileTupleSource = `public with sharing class CrossFileTupleProbe {
    public static void consume() {
        (Decimal revenue, Integer count) = OtherClass.somethingElse();
        System.debug(revenue + count);
    }
}
`;
assert.deepEqual(
  transpileApexX(crossFileTupleSource, { sourceFileName: "CrossFileTupleProbe.clsx" })
    .diagnostics.filter(diagnostic => diagnostic.severity === "error"),
  [],
);

// Documentation drifts silently, so the parts of it that are checkable are checked.
// Three editor settings existed for a while with no mention in the README.
{
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const architecture = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");
  const development = fs.readFileSync(path.join(root, "docs", "development.md"), "utf8");

  const settings = Object.keys(extensionPackage.contributes.configuration.properties);
  // Dotted names count too: `apexxLanguageServer.trace.server` is a setting like any
  // other, and a single-segment pattern would let it go undocumented.
  const documented = new Set(
    [...readme.matchAll(/`(apexx[A-Za-z]*(?:\.[A-Za-z]+)+)`/g)].map(match => match[1]),
  );
  assert.deepEqual(
    settings.filter(setting => !documented.has(setting)),
    [],
    "every editor setting must be documented in the README",
  );
  assert.deepEqual(
    [...documented].filter(setting => !settings.includes(setting)),
    [],
    "the README must not document a setting that does not exist",
  );

  // An `npm run x` in the docs has to be a script someone can run.
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const referenced = new Set(
    [...(readme + architecture + development).matchAll(/`npm run ([a-z:-]+)/g)]
      .map(match => match[1]),
  );
  assert.deepEqual(
    [...referenced].filter(script => !packageJson.scripts[script]).sort(),
    [],
    "the docs reference an npm script that does not exist",
  );

  // A link into the README has to land on a heading in it.
  const headings = new Set(
    [...readme.matchAll(/^#+ (.+)$/gm)].map(match =>
      match[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-"),
    ),
  );
  assert.deepEqual(
    [...readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)]
      .map(match => match[1])
      .filter(anchor => !headings.has(anchor)),
    [],
    "a README link points at a heading that is not there",
  );

  // The system types completion claims to serve, and the ones it serves.
  const server = fs.readFileSync(
    path.join(root, "packages", "language-server", "src", "server.ts"),
    "utf8",
  );
  const staticTable = server.slice(
    server.indexOf("const staticMembers"),
    server.indexOf("function pipelineHelperCompletions"),
  );
  const served = [...staticTable.matchAll(/^  ([a-z]+): \(\) => \[/gm)].map(match => match[1]);
  assert.ok(served.length > 0, "the static member table should be found");
  // The whole section, not a prefix of it: the fallback table is described after the
  // standard-library paragraphs, and a window would only measure where it sits.
  const completionSectionStart = readme.indexOf("### What completion offers");
  const nextSection = readme.indexOf("\n### ", completionSectionStart + 1);
  const completionSection = readme
    .slice(
      completionSectionStart,
      nextSection === -1 ? undefined : nextSection,
    )
    .toLowerCase();

  for (const type of served) {
    assert.match(
      completionSection,
      new RegExp(`\`${type}\\.\``),
      `completion serves ${type}. but the README does not list it`,
    );
  }
}

// The language configuration decides whether VS Code ever asks for a completion.
// `getWordAtPosition` returns nothing when `wordPattern` does not match the identifier
// being typed, and auto-triggered suggestions are skipped entirely when it does -- so a
// pattern that matches no identifier silently disables completion while trigger
// characters keep working, which is exactly the failure this guards against.
{
  const languageConfiguration = JSON.parse(
    fs.readFileSync(
      path.join(root, "packages", "vscode-extension", "language-configuration.json"),
      "utf8",
    ),
  );
  const wordPattern = new RegExp(languageConfiguration.wordPattern);

  for (const identifier of [
    "Sys",
    "System",
    "account",
    "accounts",
    "a1",
    "MIN_REVENUE_PER_EMPLOYEE",
    "hotAccounts",
    "_private",
  ]) {
    const match = wordPattern.exec(identifier);
    assert.equal(
      match?.[0],
      identifier,
      `wordPattern must match the whole identifier ${identifier}, or VS Code never asks for completions in an ApexX file`,
    );
  }

  // And it must still stop at the characters that end a word.
  for (const [source, word] of [
    ["accounts.filter", "accounts"],
    ["System.debug", "System"],
    ["a+b", "a"],
    ["foo(bar", "foo"],
  ]) {
    assert.equal(
      new RegExp(languageConfiguration.wordPattern).exec(source)?.[0],
      word,
      `wordPattern should read ${word} out of ${source}`,
    );
  }
}

// Everything the editor derives from language configuration -- where a word ends, when
// to indent, what auto-closes, how folding works -- has to behave the way it does in
// Apex, because an ApexX file is an Apex file with more in it. The Salesforce Apex
// extension ships the authoritative copy, so when it is installed the two are compared
// directly; the behavioural checks above stand on their own when it is not.
{
  const apexConfiguration = findApexLanguageConfiguration();

  if (apexConfiguration) {
    const ours = JSON.parse(
      fs.readFileSync(
        path.join(root, "packages", "vscode-extension", "language-configuration.json"),
        "utf8",
      ),
    );
    const theirs = JSON.parse(fs.readFileSync(apexConfiguration, "utf8"));

    for (const key of Object.keys(theirs)) {
      assert.deepEqual(
        ours[key],
        theirs[key],
        `language configuration '${key}' has drifted from the Apex extension's`,
      );
    }
  } else {
    console.log(
      "Apex extension not installed: language configuration checked behaviourally only.",
    );
  }
}

// Muscle memory is part of the experience: a developer moving a file from .cls to
// .clsx should keep every snippet prefix they already type. The bodies are ApexX's own,
// but the prefixes have to cover the Apex extension's.
{
  const apexSnippets = findApexSnippets();

  if (apexSnippets.length > 0) {
    const ours = new Set(
      Object.values(
        JSON.parse(
          fs.readFileSync(
            path.join(root, "packages", "vscode-extension", "snippets", "apexx.json"),
            "utf8",
          ),
        ),
      ).map(snippet => snippet.prefix),
    );

    const missing = apexSnippets
      .flatMap(file => Object.values(JSON.parse(fs.readFileSync(file, "utf8"))))
      .map(snippet => snippet.prefix)
      .filter(prefix => typeof prefix === "string" && !ours.has(prefix));

    assert.deepEqual(
      [...new Set(missing)],
      [],
      "an Apex snippet prefix has no ApexX counterpart",
    );
  } else {
    console.log("Apex extension not installed: snippet prefixes not compared.");
  }
}

function findApexSnippets() {
  const extensions = path.join(os.homedir(), ".vscode", "extensions");

  if (!fs.existsSync(extensions)) {
    return [];
  }

  for (const entry of fs.readdirSync(extensions)) {
    if (!/^salesforce\.apex-language-server-extension-\d/.test(entry)) {
      continue;
    }

    const directory = path.join(extensions, entry, "snippets");
    if (fs.existsSync(directory)) {
      return fs
        .readdirSync(directory)
        .filter(file => file.endsWith(".json"))
        .map(file => path.join(directory, file));
    }
  }

  return [];
}

// Every snippet has to be well formed, because a malformed one fails silently in the
// editor rather than loudly here.
{
  const snippets = JSON.parse(
    fs.readFileSync(
      path.join(root, "packages", "vscode-extension", "snippets", "apexx.json"),
      "utf8",
    ),
  );
  const prefixes = new Set();

  for (const [name, snippet] of Object.entries(snippets)) {
    assert.equal(typeof snippet.prefix, "string", `${name} needs a prefix`);
    assert.equal(typeof snippet.description, "string", `${name} needs a description`);
    assert.ok(
      Array.isArray(snippet.body) && snippet.body.length > 0,
      `${name} needs a body`,
    );
    assert.ok(!prefixes.has(snippet.prefix), `prefix ${snippet.prefix} is used twice`);
    prefixes.add(snippet.prefix);

    // A choice placeholder with an empty option, or a tabstop numbered twice with
    // different defaults, both misbehave only once a user triggers them.
    for (const line of snippet.body) {
      assert.equal(typeof line, "string", `${name} body lines must be strings`);
      assert.doesNotMatch(line, /\$\{\d+\|[^}]*\|\|/, `${name} has an empty choice`);
    }
  }
}

function findApexLanguageConfiguration() {
  const extensions = path.join(os.homedir(), ".vscode", "extensions");

  if (!fs.existsSync(extensions)) {
    return undefined;
  }

  for (const entry of fs.readdirSync(extensions)) {
    if (!/^salesforce\.apex-language-server-extension-\d/.test(entry)) {
      continue;
    }

    const candidate = path.join(extensions, entry, "language-configuration.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// A code is a promise to the reader, so the table in the README and the codes the
// compiler actually raises have to stay in step. Checked in both directions, because a
// documented code that nothing raises misleads as much as an undocumented one.
{
  const codesInSource = new Set();
  for (const file of ["tuples.ts", "index.ts"]) {
    const text = fs.readFileSync(
      path.join(root, "packages", "transpiler", "src", file),
      "utf8",
    );
    for (const match of text.matchAll(/"(APXX\d{4})"/g)) {
      codesInSource.add(match[1]);
    }
  }

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const reference = readme.slice(readme.indexOf("## Diagnostic Reference"));
  assert.notEqual(reference, "", "the README should carry a diagnostic reference");
  const documented = new Set(
    [...reference.matchAll(/\| `(APXX\d{4})` \|/g)].map(match => match[1]),
  );

  assert.deepEqual(
    [...codesInSource].filter(code => !documented.has(code)).sort(),
    [],
    "every code the compiler raises must appear in the README reference",
  );
  assert.deepEqual(
    [...documented].filter(code => !codesInSource.has(code)).sort(),
    [],
    "every documented code must be one the compiler can raise",
  );
}

// The code travels as data, so no message may open with one: it would render twice
// everywhere the code is shown separately. Checked against the source rather than
// against a sample of diagnostics, so a code cannot leak back in through a path no
// probe here happens to reach. A bare `"APXX2401"` argument does not match; a literal
// that continues into prose does.
for (const file of ["tuples.ts", "index.ts"]) {
  const text = fs.readFileSync(
    path.join(root, "packages", "transpiler", "src", file),
    "utf8",
  );
  const leaked = [...text.matchAll(/["`](APXX\d{4})[: ]/g)].map(match => match[1]);
  assert.deepEqual(
    leaked,
    [],
    `a code belongs in diagnostic.code, not in a message: ${file} embeds ${leaked.join(", ")}`,
  );
}

// And the field really does survive the pipeline onto a reported diagnostic.
const codedSample = tupleTypeResult.diagnostics.find(
  diagnostic => diagnostic.code === "APXX2412",
);
assert.ok(codedSample, "expected a coded diagnostic in the tuple probe");
assert.doesNotMatch(codedSample.message, /^APXX/);

// A file is syntactically broken for as long as it takes to type a statement, so the
// syntax error that reports it has to stay readable. The generated messages quote the
// input with its newlines escaped and enumerate every token the grammar would accept --
// over two thousand characters of keywords -- and error recovery then invents follow-on
// errors on top.
{
  const incomplete = [
    ["class", `public class Probe {
    public static void run() {
        Integer first = 1;
        Integer second = 2;
        Datetime t = Datetime.
    }
}
`],
    ["anonymous", `Integer first = 1;
Integer second = 2;
Integer third = 3;
Datetime t = Datetime.
`],
  ];

  for (const [mode, source] of incomplete) {
    const errors = transpileApexX(source, { sourceFileName: `Probe.${mode}`, mode })
      .diagnostics.filter(diagnostic => diagnostic.severity === "error");

    assert.equal(
      errors.length,
      1,
      `${mode}: recovery errors should not pile up: ${JSON.stringify(errors.map(e => e.message))}`,
    );
    assert.doesNotMatch(
      errors[0].message,
      /expecting \{/,
      `${mode}: a message must not recite the grammar`,
    );
    assert.doesNotMatch(errors[0].message, /\\n/, `${mode}: no escaped newlines in a message`);
    assert.ok(
      errors[0].message.length < 120,
      `${mode}: message is ${errors[0].message.length} characters: ${errors[0].message}`,
    );
    // The listener used to report a fixed offset of zero, which put every syntax error
    // on line 1 once diagnostics were mapped back to the authored source by offset.
    assert.ok(
      errors[0].range.start.line > 2,
      `${mode}: expected the error near the broken statement, got line ${errors[0].range.start.line}`,
    );
    assert.equal(
      errors[0].range.start.line,
      source.slice(0, errors[0].range.start.offset).split("\n").length,
      `${mode}: line and offset must agree`,
    );
  }

  // A short list of alternatives is a real hint and is kept.
  const missingSemicolon = transpileApexX(
    `public class Probe {
    public static void run() {
        Integer first = 1
    }
}
`,
    { sourceFileName: "Probe.clsx" },
  ).diagnostics.filter(diagnostic => diagnostic.severity === "error");
  assert.equal(missingSemicolon.length, 1);
  assert.match(missingSemicolon[0].message, /Missing ';'/);
}

// A front-end error leaves un-lowered ApexX in the output; the Apex parse errors
// that follow are cascade noise reported at generated-file positions.
assert.deepEqual(
  driftResult.diagnostics.filter(diagnostic => diagnostic.source === "apex-parser"),
  [],
);

const scalarCollectionMethodsSource = `public with sharing class AccountService {
    public static Boolean hasHotAccount(List<Account> accounts) {
        return accounts.any(a => a.Rating == 'Hot');
    }

    public static Boolean allHaveNumbers(List<Account> accounts) {
        return accounts.all(a => a.AccountNumber != null);
    }

    public static Integer hotAccountCount(List<Account> accounts) {
        return accounts.count(a => a.Rating == 'Hot');
    }

    public static Account firstHotAccount(List<Account> accounts) {
        return accounts.find(a => a.Rating == 'Hot');
    }
}
`;
const scalarCollectionMethodsResult = transpileApexX(scalarCollectionMethodsSource, {
  sourceFileName: "AccountService.clsx",
});
const scalarCollectionMethodsErrors = scalarCollectionMethodsResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(scalarCollectionMethodsErrors, []);
assert.match(scalarCollectionMethodsResult.output, /Boolean apexxAny0 = false;/);
assert.match(scalarCollectionMethodsResult.output, /apexxAny0 = true;/);
assert.match(scalarCollectionMethodsResult.output, /Boolean apexxAll0 = true;/);
assert.match(scalarCollectionMethodsResult.output, /if \(!\(a\.AccountNumber != null\)\)/);
assert.match(scalarCollectionMethodsResult.output, /Integer apexxCount0 = 0;/);
assert.match(scalarCollectionMethodsResult.output, /apexxCount0\+\+;/);
assert.match(scalarCollectionMethodsResult.output, /Account apexxFind0 = null;/);
assert.match(scalarCollectionMethodsResult.output, /apexxFind0 = a;/);

const scalarAssignmentSource = `public with sharing class AccountService {
    public static Boolean summarize(List<Account> accounts) {
        Boolean hasHot = accounts.any(a => a.Rating == 'Hot');
        Integer hotCount = accounts.count(a => a.Rating == 'Hot');
        Account firstHot = accounts.find(a => a.Rating == 'Hot');
        return hasHot && hotCount > 0 && firstHot != null;
    }
}
`;
const scalarAssignmentResult = transpileApexX(scalarAssignmentSource, {
  sourceFileName: "AccountService.clsx",
});
const scalarAssignmentErrors = scalarAssignmentResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(scalarAssignmentErrors, []);
assert.match(scalarAssignmentResult.output, /Boolean hasHot = apexxAny0;/);
assert.match(scalarAssignmentResult.output, /Integer hotCount = apexxCount0;/);
assert.match(scalarAssignmentResult.output, /Account firstHot = apexxFind0;/);

const flatMapSource = `public with sharing class AccountService {
    public static List<Contact> contacts(List<Account> accounts) {
        return accounts.flatMap(a => a.Contacts);
    }

    public static List<String> contactEmails(List<Account> accounts) {
        return accounts.flatMap(a => a.Contacts)
            .map(c => c.Email);
    }

    public static Contact firstContactWithEmail(List<Account> accounts) {
        return accounts.flatMap(a => a.Contacts)
            .find(c => c.Email != null);
    }
}
`;
const flatMapResult = transpileApexX(flatMapSource, {
  sourceFileName: "AccountService.clsx",
});
const flatMapErrors = flatMapResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(flatMapErrors, []);
assert.match(flatMapResult.output, /List<Contact> apexxFlatMap0 = new List<Contact>\(\);/);
assert.match(flatMapResult.output, /apexxFlatMap0\.addAll\(a\.Contacts\);/);
assert.match(flatMapResult.output, /for \(Contact c : apexxFlatMap1\)/);
assert.match(flatMapResult.output, /List<String> apexxMap0 = new List<String>\(\);/);
assert.match(flatMapResult.output, /Contact apexxFind0 = null;/);

const invalidFlatMapSource = `public with sharing class AccountService {
    public static List<String> invalid(List<Account> accounts) {
        return accounts.flatMap(a => a.Name);
    }
}
`;
const invalidFlatMapResult = transpileApexX(invalidFlatMapSource, {
  sourceFileName: "AccountService.clsx",
});
assert.match(
  invalidFlatMapResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
  /flatMap\(\.\.\.\) expects a lambda that returns List<R>, but this lambda returns String\./,
);

const invalidTerminalChainSource = `public with sharing class AccountService {
    public static List<Account> invalid(List<Account> accounts) {
        return accounts.any(a => a.Rating == 'Hot')
            .filter(a => a.Rating == 'Warm');
    }
}
`;
const invalidTerminalChainResult = transpileApexX(invalidTerminalChainSource, {
  sourceFileName: "AccountService.clsx",
});
assert.match(
  invalidTerminalChainResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
  /filter\(\.\.\.\) cannot run after a list method that returns Boolean\./,
);

const funcLambdaSource = `public with sharing class EqualityService {
    public static Boolean compare(Integer left, Integer right) {
        Func<int, int, bool> testForEquality = (x, y) => x == y;
        return testForEquality(left, right);
    }
}
`;
const funcLambdaResult = transpileApexX(funcLambdaSource, {
  sourceFileName: "EqualityService.clsx",
});
const funcLambdaErrors = funcLambdaResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(funcLambdaErrors, []);
const funcLambdaSupport = funcLambdaResult.supportClasses.find(
  supportClass => supportClass.className === "ApexXFuncs",
);
assert.ok(funcLambdaSupport);
assert.match(funcLambdaSupport.source, /Boolean invoke\(Integer arg0, Integer arg1\);/);
assert.match(funcLambdaResult.output, /private class ApexXLambda0 implements ApexXFuncs\.ApexXFunc_[0-9a-f]{12}/);
assert.match(funcLambdaResult.output, /return x == y;/);
assert.match(
  funcLambdaResult.output,
  /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} testForEquality = new ApexXLambda0\(\);/,
);
assert.match(
  funcLambdaResult.output,
  /return testForEquality\.invoke\(left, right\);/,
);

const capturedFuncLambdaSource = `public with sharing class RevenueService {
    public static Boolean compare(Decimal left, Decimal right, Decimal tolerance) {
        Func<Decimal, Decimal, Boolean> isWithinTolerance =
            (actual, expected) => actual == expected || (actual - expected).abs() <= tolerance;

        return isWithinTolerance(left, right);
    }
}
`;
const capturedFuncLambdaResult = transpileApexX(capturedFuncLambdaSource, {
  sourceFileName: "RevenueService.clsx",
});
const capturedFuncLambdaErrors = capturedFuncLambdaResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(capturedFuncLambdaErrors, []);
assert.match(capturedFuncLambdaResult.output, /private Decimal tolerance;/);
assert.match(capturedFuncLambdaResult.output, /public ApexXLambda0\(Decimal tolerance\)/);
assert.match(capturedFuncLambdaResult.output, /this\.tolerance = tolerance;/);
assert.match(
  capturedFuncLambdaResult.output,
  /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} isWithinTolerance = new ApexXLambda0\(tolerance\);/,
);
assert.match(
  capturedFuncLambdaResult.output,
  /return actual == expected \|\| \(actual - expected\)\.abs\(\) <= tolerance;/,
);

const funcParameterBlockMapSource = `public with sharing class WorkService {
    public static List<WorkItem> buildWork(List<Account> accounts, Func<Account, Boolean> shouldEscalate) {
        return accounts.map(account => {
            Boolean escalate = shouldEscalate(account);
            return new WorkItem(account.Id, escalate ? 'High' : 'Normal');
        });
    }

    public static List<WorkItem> loadWork(List<Account> accounts, String mode) {
        Func<Account, Boolean> shouldEscalate;
        if (mode == 'Revenue') {
            shouldEscalate = (account) => account.AnnualRevenue != null && account.AnnualRevenue > 100000;
        } else {
            shouldEscalate = (account) => account.Rating == 'Hot';
        }

        return buildWork(accounts, shouldEscalate);
    }

    public class WorkItem {
        public Id accountId;
        public String priority;

        public WorkItem(Id accountId, String priority) {
            this.accountId = accountId;
            this.priority = priority;
        }
    }
}
`;
const funcParameterBlockMapResult = transpileApexX(funcParameterBlockMapSource, {
  sourceFileName: "WorkService.clsx",
});
const funcParameterBlockMapErrors = funcParameterBlockMapResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(funcParameterBlockMapErrors, []);
assert.match(
  funcParameterBlockMapResult.output,
  /public static List<WorkItem> buildWork\(List<Account> accounts, ApexXFuncs\.ApexXFunc_[0-9a-f]{12} shouldEscalate\)/,
);
assert.match(funcParameterBlockMapResult.output, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} shouldEscalate;/);
assert.match(funcParameterBlockMapResult.output, /shouldEscalate = new ApexXLambda0\(\);/);
assert.match(funcParameterBlockMapResult.output, /shouldEscalate = new ApexXLambda1\(\);/);
assert.match(funcParameterBlockMapResult.output, /Boolean escalate = shouldEscalate\.invoke\(account\);/);
assert.match(
  funcParameterBlockMapResult.output,
  /apexxMap0\.add\(new WorkItem\(account\.Id, escalate \? 'High' : 'Normal'\)\);/,
);

const nestedFuncCallSource = `public with sharing class EqualityService {
    public static Boolean compare(Integer left, Integer right) {
        Func<int, int, bool> testForEquality = (x, y) => x == y;
        Func<int, bool> isSelfEqual = (x) => testForEquality(x, x);
        return isSelfEqual(left);
    }
}
`;
const nestedFuncCallResult = transpileApexX(nestedFuncCallSource, {
  sourceFileName: "EqualityService.clsx",
});
const nestedFuncCallErrors = nestedFuncCallResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(nestedFuncCallErrors, []);
assert.match(nestedFuncCallResult.output, /private ApexXFuncs\.ApexXFunc_[0-9a-f]{12} testForEquality;/);
assert.match(nestedFuncCallResult.output, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} isSelfEqual = new ApexXLambda1\(testForEquality\);/);
assert.match(nestedFuncCallResult.output, /return testForEquality\.invoke\(x, x\);/);
assert.match(nestedFuncCallResult.output, /return isSelfEqual\.invoke\(left\);/);

const defaultArgumentsSource = `public with sharing class NotificationService {
    @AuraEnabled
    public static String formatMessage(String subject, Boolean urgent = false, String prefix = 'Info') {
        return prefix + ': ' + subject + ':' + urgent;
    }
}
`;
const defaultArgumentsResult = transpileApexX(defaultArgumentsSource, {
  sourceFileName: "NotificationService.clsx",
});
const defaultArgumentErrors = defaultArgumentsResult.diagnostics.filter(
  diagnostic => diagnostic.severity === "error",
);
assert.deepEqual(defaultArgumentErrors, []);
assert.match(
  defaultArgumentsResult.output,
  /public static String formatMessage\(String subject\) \{\s*return formatMessage\(subject, false, 'Info'\);/s,
);
assert.match(
  defaultArgumentsResult.output,
  /public static String formatMessage\(String subject, Boolean urgent\) \{\s*return formatMessage\(subject, urgent, 'Info'\);/s,
);
assert.match(
  defaultArgumentsResult.output,
  /public static String formatMessage\(String subject, Boolean urgent, String prefix\)/,
);
assert.doesNotMatch(defaultArgumentsResult.output, /urgent = false/);
assert.doesNotMatch(defaultArgumentsResult.output, /prefix = 'Info'/);

const invalidDefaultArgumentsSource = `public with sharing class NotificationService {
    public static String invalid(String subject = 'Hi', Boolean urgent) {
        return subject;
    }
}
`;
const invalidDefaultArgumentsResult = transpileApexX(invalidDefaultArgumentsSource, {
  sourceFileName: "NotificationService.clsx",
});
assert.match(
  invalidDefaultArgumentsResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
  /Default parameter values must be trailing/,
);

const decoratorWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "apexx-decorator-"));
try {
  const decoratorClassesDir = path.join(
    decoratorWorkspace,
    "force-app",
    "main",
    "default",
    "classes",
  );
  fs.mkdirSync(decoratorClassesDir, { recursive: true });
  fs.writeFileSync(
    path.join(decoratorClassesDir, "UserFriendlyError.cls"),
    `public with sharing class UserFriendlyError implements ApexX.Decorator {
    public Object handle(ApexX.Invocation ctx, ApexX.Next next) {
        try {
            return next.call();
        } catch (Exception ex) {
            throw ex;
        }
    }
}
`,
    "utf8",
  );

  const decoratorSource = `public with sharing class AccountController {
    @AuraEnabled
    @UserFriendlyError(message = 'Unable to save account', expectedTypes = new List<Type>{ Type.forName('MyExpectedException') })
    public static Account save(Account account, Boolean validate = true) {
        if (validate) {
            account.Name = account.Name.trim();
        }
        update account;
        return account;
    }
}
`;
  const decoratorResult = transpileApexX(decoratorSource, {
    sourceFileName: "AccountController.clsx",
    workspaceRoot: decoratorWorkspace,
  });
  const decoratorErrors = decoratorResult.diagnostics.filter(
    diagnostic => diagnostic.severity === "error",
  );
  assert.deepEqual(decoratorErrors, []);
  assert.equal(decoratorResult.supportClasses.length, 1);
  assert.equal(decoratorResult.supportClasses[0].className, "ApexX");
  assert.match(decoratorResult.supportClasses[0].source, /public interface Decorator/);
  assert.equal(parseApex(decoratorResult.supportClasses[0].source).ok, true);
  assert.match(
    decoratorResult.output,
    /public static Account save\(Account account\) \{\s*return save\(account, true\);/s,
  );
  assert.match(
    decoratorResult.output,
    /new UserFriendlyError\(\)\.handle\(new ApexX\.Invocation\('AccountController', 'save'/,
  );
  assert.match(
    decoratorResult.output,
    /'message' => 'Unable to save account'/,
  );
  assert.match(
    decoratorResult.output,
    /'expectedTypes' => new List<Type>\{ Type\.forName\('MyExpectedException'\) \}/,
  );
  assert.match(decoratorResult.output, /private static Account save_ApexXBody0/);
  assert.match(decoratorResult.output, /private class ApexXNext0 implements ApexX\.Next/);
  assert.doesNotMatch(decoratorResult.output, /@UserFriendlyError/);

  const unresolvedDecoratorSource = `public with sharing class AccountController {
    @MissingDecorator
    public static Account save(Account account) {
        return account;
    }
}
`;
  const unresolvedDecoratorResult = transpileApexX(unresolvedDecoratorSource, {
    sourceFileName: "AccountController.clsx",
    workspaceRoot: decoratorWorkspace,
  });
  assert.match(
    unresolvedDecoratorResult.diagnostics.map(diagnostic => diagnostic.message).join("\n"),
    /Unknown ApexX annotation @MissingDecorator/,
  );
} finally {
  fs.rmSync(decoratorWorkspace, { recursive: true, force: true });
}

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
  fs.copyFileSync(
    path.join(root, "apexx", "classes", "PlainApex.clsx"),
    path.join(tempProject, "apexx", "classes", "PlainApex.clsx"),
  );
  fs.mkdirSync(
    path.join(tempProject, "force-app", "main", "default", "classes"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      tempProject,
      "force-app",
      "main",
      "default",
      "classes",
      "UserFriendlyError.cls",
    ),
    `public with sharing class UserFriendlyError implements ApexX.Decorator {
    public Object handle(ApexX.Invocation ctx, ApexX.Next next) {
        return next.call();
    }
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempProject, "apexx", "classes", "DecoratedController.clsx"),
    `public with sharing class DecoratedController {
    @UserFriendlyError
    public static Account save(Account account, Boolean validate = true) {
        return account;
    }
}
`,
    "utf8",
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

  const supportClass = fs.readFileSync(
    path.join(
      tempProject,
      "force-app",
      "main",
      "default",
      "classes",
      "ApexX.cls",
    ),
    "utf8",
  );
  assert.match(supportClass, /public interface Decorator/);

  const generatedClassesDirectory = path.join(
    tempProject,
    "force-app",
    "main",
    "default",
    "classes",
  );
  const funcRegistry = fs.readFileSync(
    path.join(generatedClassesDirectory, "ApexXFuncs.cls"),
    "utf8",
  );
  const tupleRegistry = fs.readFileSync(
    path.join(generatedClassesDirectory, "ApexXTuples.cls"),
    "utf8",
  );
  assert.match(funcRegistry, /Boolean invoke\(Account arg0\);/);
  assert.match(funcRegistry, /Integer invoke\(Integer arg0\);/);
  assert.match(tupleRegistry, /public class ApexXTuple_[0-9a-f]{12}/);
  assert.deepEqual(
    fs.readdirSync(generatedClassesDirectory).filter(fileName =>
      /^ApexX(?:Func|Tuple)_[0-9a-f]{12}\.cls$/i.test(fileName),
    ),
    [],
  );
} finally {
  fs.rmSync(tempProject, { recursive: true, force: true });
}

// The source map must address the authored file exactly: every generated
// character the map calls verbatim has to equal the character it maps to.
{
  const authoredDirectory = path.join(root, "apexx", "classes");
  let verbatim = 0;
  let exact = 0;

  for (const fileName of fs.readdirSync(authoredDirectory).filter(name => name.endsWith(".clsx"))) {
    const source = fs.readFileSync(path.join(authoredDirectory, fileName), "utf8");
    const result = transpileApexX(source, {
      sourceFileName: fileName,
      workspaceRoot: root,
    });

    for (let offset = 0; offset < result.output.length; offset += 1) {
      if (!result.sourceMap.isVerbatim(offset)) {
        continue;
      }

      verbatim += 1;
      const authored = result.sourceMap.toSource(offset);

      if (authored !== undefined && result.output[offset] === source[authored]) {
        exact += 1;
      }
    }
  }

  assert.ok(verbatim > 10000, `expected a substantial verbatim mapping, got ${verbatim}`);
  assert.equal(exact, verbatim, `source map drifted on ${verbatim - exact} characters`);

  // Tokens inside lowered regions must still resolve, including expressions that
  // only survive inside generated code.
  const accountService = fs.readFileSync(
    path.join(authoredDirectory, "AccountService.clsx"),
    "utf8",
  );
  const mapped = transpileApexX(accountService, {
    sourceFileName: "AccountService.clsx",
    workspaceRoot: root,
  });

  for (const [needle, token] of [
    ["PortfolioRuleProvider.resolve", "resolve"],
    [">= MIN_REVENUE_PER_EMPLOYEE", "MIN_REVENUE_PER_EMPLOYEE"],
    ["Func<Account, Boolean> shouldEscalate", "shouldEscalate"],
    ["AccountSummary summarize(", "summarize"],
  ]) {
    const base = accountService.indexOf(needle);
    assert.ok(base >= 0, `probe source is missing ${needle}`);
    const authoredOffset = base + needle.indexOf(token);
    const generatedOffset = mapIdentifierOffset(
      mapped.sourceMap,
      accountService,
      mapped.output,
      authoredOffset,
    );
    assert.ok(generatedOffset !== undefined, `${token} did not map into the generated Apex`);
    assert.equal(
      mapped.output.slice(generatedOffset, generatedOffset + token.length),
      token,
      `${token} mapped to the wrong generated offset`,
    );
  }

  // The generated-name table is what lets messages be reported in ApexX terms.
  const funcNames = [...mapped.generatedTypeNames.values()];
  assert.ok(
    funcNames.some(name => /^Func<Account, ?Boolean>$/.test(name)),
    `expected a Func<Account, Boolean> entry, got ${funcNames.join(" | ")}`,
  );
}

// --- Anonymous blocks: .apexx scripts ------------------------------------
{
  const script = `List<Account> accounts = [SELECT Id, Name, AnnualRevenue FROM Account LIMIT 5];
List<String> names = accounts.filter(a => a.AnnualRevenue > 1000).map(a => a.Name);
Integer factor = 3;
Func<Integer, Integer> scaled = (n) => n * factor;
Map<Id, (String, Integer)> byId = new Map<Id, (String, Integer)>();
System.debug(names);
System.debug(scaled(7));
System.debug(byId);
`;
  const anonymous = transpileApexX(script, {
    sourceFileName: "Probe.apexx",
    mode: "anonymous",
  });

  assert.deepEqual(
    anonymous.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
    [],
    "an anonymous build of supported ApexX should not report errors",
  );

  // The compilation-unit rule rejects a script on its first statement, so the
  // generated block is validated against the anonymous-block rule instead.
  assert.equal(parseApex(anonymous.output, { anonymous: true }).ok, true);
  assert.equal(parseApex(anonymous.output).ok, false);

  // A script has to be self-contained: Apex rejects an inner type that has inner
  // types, so a block-level class cannot carry the registries a class build
  // deploys. Every structural type it uses is declared flat in the block.
  assert.deepEqual(
    anonymous.supportClasses.map(supportClass => supportClass.className),
    [],
    "an anonymous build should not require deployed support classes",
  );
  assert.ok(
    !/ApexXFuncs\.|ApexXTuples\./.test(anonymous.output),
    "an anonymous block must not reference the registry classes",
  );
  assert.match(anonymous.output, /^public interface ApexXFunc_[0-9a-f]{12} \{$/m);
  assert.match(anonymous.output, /^public class ApexXTuple_[0-9a-f]{12} \{$/m);
  assert.match(anonymous.output, /^private class ApexXLambda0 implements ApexXFunc_[0-9a-f]{12} \{$/m);

  // The captured local reaches the implementation through its constructor.
  assert.match(anonymous.output, /new ApexXLambda0\(factor\)/);

  // Declarations precede the statements, so each lambda follows its interface.
  const firstStatement = anonymous.output.indexOf("List<Account> accounts =");
  assert.ok(
    anonymous.output.indexOf("private class ApexXLambda0") < firstStatement,
    "generated declarations should come before the statements",
  );

  // The same source compiled as a class keeps the registry contract.
  const asClass = transpileApexX(
    `public class Probe {\n    public static void run() {\n${script
      .split("\n")
      .map(line => (line.length > 0 ? `        ${line}` : line))
      .join("\n")}    }\n}\n`,
    { sourceFileName: "Probe.clsx" },
  );
  assert.ok(
    asClass.supportClasses.some(
      supportClass => supportClass.className === "ApexXFuncs",
    ),
    "a class build should still collect shared contracts into ApexXFuncs",
  );
  assert.match(asClass.output, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12}/);
}

// A lambda in a script used to be lowered to an implementation class that was
// never emitted, because there was no class body to inject it into.
{
  const anonymous = transpileApexX(
    "Func<Integer, Integer> twice = (n) => n * 2;\nSystem.debug(twice(21));\n",
    { sourceFileName: "Lambda.apexx", mode: "anonymous" },
  );
  const implementation = /new (ApexXLambda\d+)\(/.exec(anonymous.output);

  assert.ok(implementation, "the lowered lambda should be instantiated");
  assert.ok(
    anonymous.output.includes(`private class ${implementation[1]} implements`),
    `${implementation[1]} is instantiated but never declared`,
  );
  assert.equal(parseApex(anonymous.output, { anonymous: true }).ok, true);
}

// Decorators lower through the ApexX class, which an anonymous block cannot
// declare, and cannot nest a helper class inside a class the block declares.
{
  const decorated = transpileApexX(
    `public class Inner {
    @UserFriendlyError
    public static void run() {
        System.debug('x');
    }
}
Inner.run();
`,
    {
      sourceFileName: "Decorated.apexx",
      workspaceRoot: root,
      mode: "anonymous",
    },
  );

  assert.ok(
    decorated.diagnostics.some(
      diagnostic =>
        diagnostic.severity === "error" &&
        diagnostic.code === "APXX2621",
    ),
    "decorating a method of a script-declared class should be an error",
  );
}

// A method at the top level of a block is a legal shape, so trailing default
// arguments still lower to overloads there.
{
  const defaults = transpileApexX(
    `public static String greet(String name, String greeting = 'Hello') {
    return greeting + ', ' + name;
}
System.debug(greet('Jakub'));
`,
    { sourceFileName: "Defaults.apexx", workspaceRoot: root, mode: "anonymous" },
  );

  assert.deepEqual(
    defaults.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
    [],
    "default arguments should lower at the top level of a script",
  );
  assert.match(
    defaults.output,
    /public static String greet\(String name\) \{\n    return greet\(name, 'Hello'\);/,
  );
  assert.equal(parseApex(defaults.output, { anonymous: true }).ok, true);
}

// A decorator dispatches through the class that holds the method, so neither
// shape a script can offer works. Reported rather than passed through.
{
  const topLevel = transpileApexX(
    `@UserFriendlyError
public static void run() {
    System.debug('x');
}
run();
`,
    { sourceFileName: "Decorated.apexx", workspaceRoot: root, mode: "anonymous" },
  );

  assert.ok(
    topLevel.diagnostics.some(
      diagnostic =>
        diagnostic.severity === "error" &&
        diagnostic.code === "APXX2620",
    ),
    "a decorated top-level script method should be reported",
  );
}

// A Func or tuple from a deployed class is a registry member, and an inline
// declaration of the same signature is a different Apex type. The platform
// rejects that assignment with a message naming neither the script nor the fix,
// so the compiler reports it first, and offers the mode that works.
{
  const interop = `(Func<Account, Boolean> rule, String reason, Decimal threshold) = PortfolioRuleProvider.resolve('Revenue Exposure');
System.debug(reason + threshold);
`;
  const inline = transpileApexX(interop, {
    sourceFileName: "Interop.apexx",
    workspaceRoot: root,
    mode: "anonymous",
  });

  assert.ok(
    inline.diagnostics.some(
      diagnostic =>
        diagnostic.severity === "error" &&
        diagnostic.code === "APXX2630" &&
        diagnostic.message.includes("PortfolioRuleProvider"),
    ),
    `expected the boundary error, got ${JSON.stringify(inline.diagnostics)}`,
  );

  const deployed = transpileApexX(interop, {
    sourceFileName: "Interop.apexx",
    workspaceRoot: root,
    mode: "anonymous",
    structuralTypes: "deployed",
  });

  assert.deepEqual(
    deployed.diagnostics.filter(diagnostic => diagnostic.severity === "error"),
    [],
    "deployed structural types should accept a value from a deployed class",
  );
  assert.match(deployed.output, /ApexXTuples\.ApexXTuple_[0-9a-f]{12} apexxTuple0 = PortfolioRuleProvider\.resolve/);
  assert.match(deployed.output, /ApexXFuncs\.ApexXFunc_[0-9a-f]{12} rule = apexxTuple0\.item0;/);
  // Nothing is declared inline that the registry already holds.
  assert.ok(
    !/^public (?:interface|class) ApexX(?:Func|Tuple)_/m.test(deployed.output),
    "deployed mode should not also declare the structural types inline",
  );
  assert.equal(parseApex(deployed.output, { anonymous: true }).ok, true);

  // A script's own lambda still lowers in place, implementing the registry type.
  const mixed = transpileApexX(
    `${interop}Func<Integer, Integer> twice = (n) => n * 2;\nSystem.debug(twice(21));\n`,
    {
      sourceFileName: "Interop.apexx",
      workspaceRoot: root,
      mode: "anonymous",
      structuralTypes: "deployed",
    },
  );
  assert.match(
    mixed.output,
    /private class ApexXLambda0 implements ApexXFuncs\.ApexXFunc_[0-9a-f]{12}/,
  );
  // Those signatures have to reach the org, so they stay in the support classes.
  assert.deepEqual(
    mixed.supportClasses.map(supportClass => supportClass.className).sort(),
    ["ApexXFuncs", "ApexXTuples"],
  );
}

// A script that only uses its own structural types is unaffected by the check.
{
  const selfContained = transpileApexX(
    `List<Account> accounts = [SELECT Id, Name FROM Account LIMIT 5];
List<String> names = accounts.map(account => account.Name);
Func<Integer, Integer> twice = (n) => n * 2;
System.debug(names.size() + twice(21));
`,
    { sourceFileName: "Plain.apexx", workspaceRoot: root, mode: "anonymous" },
  );

  assert.deepEqual(
    selfContained.diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    ),
    [],
    "a self-contained script should not trip the boundary check",
  );
}

// The script extension is wired through the editor contribution too.
assert.ok(
  extensionPackage.contributes.languages[0].extensions.includes(".apexx"),
  "the extension should claim .apexx",
);
assert.ok(
  extensionPackage.contributes.commands.some(
    command => command.command === "apexx.executeCurrentScript",
  ),
  "the extension should contribute an execute command for scripts",
);
assert.deepEqual(
  extensionPackage.contributes.configuration.properties[
    "apexx.scriptStructuralTypes"
  ].enum,
  ["inline", "deployed"],
);

console.log("Smoke test passed.");

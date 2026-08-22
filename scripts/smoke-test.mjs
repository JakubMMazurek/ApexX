import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
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
assert.ok(
  extensionGrammar.repository.collectionHelpers.patterns.some(pattern =>
    pattern.match.includes("flatMap"),
  ),
);
assert.equal(extensionSnippets["ApexX typed function"].prefix, "apexx-func");
assert.equal(extensionSnippets["ApexX block function"].prefix, "apexx-func-block");
assert.equal(extensionSnippets["ApexX tuple contract"].prefix, "apexx-tuple");
assert.equal(extensionSnippets["ApexX tuple-valued map"].prefix, "apexx-tuple-map");
assert.ok(extensionGrammar.repository.tuples);

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
    diagnostic.message.includes("APXX2406") && diagnostic.message.includes("received 1"),
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
    diagnostic.message.includes("APXX2403"),
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

console.log("Smoke test passed.");

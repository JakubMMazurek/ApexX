import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { transpileApexX } from "../packages/transpiler/dist/index.js";
import { parseApex } from "../packages/parser/dist/index.js";

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
assert.match(funcLambdaResult.output, /public interface ApexXFunc0/);
assert.match(funcLambdaResult.output, /Boolean invoke\(Integer x, Integer y\);/);
assert.match(funcLambdaResult.output, /private class ApexXLambda0 implements ApexXFunc0/);
assert.match(funcLambdaResult.output, /return x == y;/);
assert.match(
  funcLambdaResult.output,
  /ApexXFunc0 testForEquality = new ApexXLambda0\(\);/,
);
assert.match(
  funcLambdaResult.output,
  /return testForEquality\.invoke\(left, right\);/,
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
} finally {
  fs.rmSync(tempProject, { recursive: true, force: true });
}

console.log("Smoke test passed.");

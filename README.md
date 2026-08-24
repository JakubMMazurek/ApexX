# ApexX

ApexX is an experimental, Apex-compatible source language for Salesforce. Author `.clsx` files with modern language features, then compile them to ordinary `.cls` metadata that the Salesforce platform already understands.

The mental model is TypeScript and JavaScript: the richer source is for people, while generated Apex is a deployment artifact. Ordinary Apex remains valid ApexX, so a team can adopt the language one class or one expression at a time.

> **Project status:** this is a working language prototype and an executable technical showcase, not a production release. The compiler, Salesforce tests, VS Code integration, and Lightning demo are all included so the current behavior can be inspected end to end.

## What ApexX Adds

- typed `filter`, `map`, `flatMap`, `find`, `any`, `all`, and `count` operations on `List<T>`
- expression and multi-statement block lambdas
- first-class `Func<...>` values that can be selected, reassigned, passed, returned, and shared across classes
- strongly typed tuples, tuple-valued maps, destructuring, and cross-class tuple contracts
- trailing default arguments, compiled to ordinary Apex overloads
- user-defined method decorators, compiled to explicit Apex control flow
- a VS Code language mode with syntax highlighting, snippets, diagnostics, type-aware completion, and compile on save
- a language service over `.clsx`: outline, go to definition across files, find references, rename, signature help, and hover reporting real declared types

Every feature lowers to statically typed Apex. Shared function and tuple signatures are collected into deterministic nested types in `ApexXFuncs.cls` and `ApexXTuples.cls`, avoiding one generated file per structural type.

## Contents

- [Install and validate locally](#install-and-validate-locally)
- [Connect a Salesforce org](#connect-a-salesforce-org)
- [Install the VS Code experience](#install-the-vs-code-experience)
- [Language tour](#language-tour)
- [Salesforce showcase](#salesforce-showcase)
- [Command reference](#command-reference)
- [Troubleshooting](#troubleshooting)
- [Architecture and development notes](#architecture-and-development-notes)

## Prerequisites

- Git
- Node.js 20.19 or newer, including npm
- Salesforce CLI (`sf`) and access to the demo org, for deployment and the Lightning showcase
- VS Code, for the `.clsx` editor demonstration

## Install And Validate Locally

The repository is private, so authenticate Git with the GitHub account that has access before cloning it.

```bash
git clone https://github.com/JakubMMazurek/ApexX.git
cd ApexX
npm ci
npm test
```

`npm test` builds every TypeScript package, exercises compiler output, validates generated Apex through the upstream Apex parser, and runs the language-server smoke suite. No Salesforce connection is required for this step.

Compile all checked-in `.clsx` sources:

```bash
npm run apexx -- build
```

Inside this Salesforce DX project, compilation writes deployable `.cls` and `.cls-meta.xml` files to `force-app/main/default/classes`. Treat `apexx/classes` as authored source and `force-app/main/default/classes` as compiler output.

## Connect A Salesforce Org

The alias `apexx` is only a local convenience; creating it does not change the org. Log in with the same demo-org credentials on each computer:

```bash
sf org login web --alias apexx --set-default
```

For a Salesforce sandbox that uses the standard test login endpoint, add `--instance-url https://test.salesforce.com`.

Build, deploy, seed the deterministic dataset, run the native Apex suite, verify readiness, and open the showcase:

```bash
npm run apexx -- build
npm run sf:deploy -- --target-org apexx
npm run sf:seed -- --target-org apexx
npm run sf:test -- --target-org apexx
npm run demo:check -- --target-org apexx
npm run sf:open:showcase -- --target-org apexx
```

The target org must support Salesforce API version `67.0`. The seed script only replaces Accounts whose names begin with `ApexX Demo` and their child Contacts, so it is repeatable for the dedicated showcase dataset. Review the script before using it in an org that contains important data.

For normal preparation on demo day, the same sequence is safe to rerun. `demo:check` is the final non-mutating readiness gate: it validates the local toolchain, generated structural registries, Salesforce authentication, and the expected four demo Accounts and four Contacts.

## Install The VS Code Experience

On Windows, macOS, or Linux, after `npm ci` and `npm run build`:

```bash
npm run vscode:install
```

The installer targets `~/.vscode/extensions`, links the built workspace packages
so the language server and compiler run from this repo, and is safe to rerun after
every `npm run build`. For a VS Code fork or a portable install, point it elsewhere:

```bash
npm run vscode:install -- --extensions-dir ~/.vscode-insiders/extensions
```

Reload VS Code and open `apexx/classes/AccountService.clsx`. The extension supplies dedicated coloring, indentation and folding, feature snippets, live compiler diagnostics, hover documentation, type-aware completion, and compile-on-save behavior.

For org-backed sObject completion, cache only the objects needed for the demo:

```bash
npm run schema:refresh -- --target-org apexx Account Contact
```

The cache is written to the ignored `.apexx/schema` directory and is never committed.

## Language Tour

Example `.clsx`:

```apex
public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        return accounts
            .filter(a => a.Rating == 'Hot')
            .filter(a => a.AccountNumber != null);
    }
}
```

Recommended project layout:

```text
apexx/
  classes/
    AccountService.clsx

force-app/
  main/
    default/
      classes/
        AccountService.cls
        AccountService.cls-meta.xml
```

Outside a Salesforce DX project, ApexX writes generated Salesforce source-format files under:

```text
generated/
  force-app/
    main/
      default/
        classes/
          AccountService.cls
          AccountService.cls-meta.xml
```

Generated `.cls`:

```apex
public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        List<Account> apexxFilter0 = new List<Account>();
        for (Account a : accounts) {
            if (a.Rating == 'Hot') {
                apexxFilter0.add(a);
            }
        }
        List<Account> apexxFilter1 = new List<Account>();
        for (Account a : apexxFilter0) {
            if (a.AccountNumber != null) {
                apexxFilter1.add(a);
            }
        }
        return apexxFilter1;
    }
}
```

`map` returns a new list type by inferring the lambda body, with the assignment or method return type used as context:

```apex
public static List<String> hotAccountNames(List<Account> accounts) {
    return accounts.filter(a => a.Rating == 'Hot')
        .map(a => a.Name);
}
```

Generated Apex:

```apex
List<Account> apexxFilter0 = new List<Account>();
for (Account a : accounts) {
    if (a.Rating == 'Hot') {
        apexxFilter0.add(a);
    }
}
List<String> apexxMap0 = new List<String>();
for (Account a : apexxFilter0) {
    apexxMap0.add(a.Name);
}
return apexxMap0;
```

Map chains use a small expression type inferencer for fields, literals, comparisons, common primitive methods, and static calls:

```apex
public static List<String> upperAccountNumbers(List<Account> accounts) {
    return accounts
        .map(a => a.AccountNumber)
        .map(accountNumber => accountNumber.toUpperCase());
}
```

Scalar helpers and `flatMap` use the same lambda typing:

```apex
Boolean hasHot = accounts.any(a => a.Rating == 'Hot');
Integer hotCount = accounts.count(a => a.Rating == 'Hot');
Account firstHot = accounts.find(a => a.Rating == 'Hot');

List<Contact> contacts = accounts.flatMap(a => a.Contacts);
List<String> emails = accounts
    .flatMap(a => a.Contacts)
    .map(c => c.Email);
```

`Func` lambda assignments are also supported. ApexX accepts C#-style lowercase aliases such as `int` and `bool` and emits Salesforce Apex type names:

```apex
Func<int, int, bool> testForEquality = (x, y) => x == y;
return testForEquality(left, right);
```

Generated Apex uses a deterministic nested interface for the structural signature and a private implementation for the lambda. Every function signature in the project is collected into one generated registry file:

```apex
// ApexXFuncs.cls — shared structural registry
public class ApexXFuncs {
    public interface ApexXFunc_c7ff27852c51 {
        Boolean invoke(Integer arg0, Integer arg1);
    }
}

// Inside the generated source class
private class ApexXLambda0 implements ApexXFuncs.ApexXFunc_c7ff27852c51 {
    public Boolean invoke(Integer x, Integer y) {
        return x == y;
    }
}

ApexXFuncs.ApexXFunc_c7ff27852c51 testForEquality = new ApexXLambda0();
return testForEquality.invoke(left, right);
```

`Func` can cross method and class boundaries. Its deterministic member name is derived from the full normalized signature, so two classes compiled separately agree on the same nested native Apex interface. A project build aggregates all required interfaces into `ApexXFuncs.cls`; VS Code performs the same workspace aggregation when it compiles on save.

```apex
public static List<AccountWorkItem> buildRenewalWork(
    List<Account> accounts,
    Func<Account, Boolean> shouldEscalate
) {
    return accounts.map(account => {
        Boolean escalate = shouldEscalate(account);
        return new AccountWorkItem(account.Id, escalate ? 'High' : 'Normal');
    });
}
```

Block lambdas allow real preparation logic before the typed result:

```apex
Func<Account, Boolean> hasExposure = (account) => {
    Decimal revenue = account.AnnualRevenue == null
        ? 0
        : account.AnnualRevenue;
    return revenue >= 250000;
};
```

Tuples remove throwaway classes created only to carry two or three related values. A common Salesforce example is calculating multiple values per record: ordinary Apex requires a tiny map-value wrapper or parallel maps that must stay synchronized. ApexX makes the pair the strongly typed value of the map:

```apex
// AccountSignalProvider.clsx
public static Map<Id, (Decimal, Boolean)> calculate(List<Account> accounts) {
    Map<Id, (Decimal, Boolean)> signals =
        new Map<Id, (Decimal, Boolean)>();

    for (Account account : accounts) {
        Decimal revenuePerEmployee =
            account.AnnualRevenue == null
            || account.NumberOfEmployees == null
            || account.NumberOfEmployees <= 0
                ? null
                : account.AnnualRevenue / account.NumberOfEmployees;
        Boolean needsReview = account.AccountNumber == null
            || revenuePerEmployee == null
            || revenuePerEmployee < 10000;
        signals.put(account.Id, (revenuePerEmployee, needsReview));
    }
    return signals;
}

// AccountSignalConsumer.clsx — compiled independently
Map<Id, (Decimal, Boolean)> signals = AccountSignalProvider.calculate(accounts);
(Decimal revenuePerEmployee, Boolean needsReview) = signals.get(accountId);
```

Tuples are not capped at arity three; the compiler accepts arbitrary arity and emits a warning beyond seven elements because a named domain type is usually clearer at that point. The generated carrier is named from its complete normalized element signature and nested in `ApexXTuples.cls`. Tuple values—including tuples that contain a `Func`—therefore remain real cross-class structural contracts, with ordinary public Apex types underneath and no reflection, `Object`, or unsafe casts. Regardless of how many structural signatures the project uses, ApexX maintains only two generated structural files: `ApexXFuncs.cls` and `ApexXTuples.cls`. Tuple returns are intentionally rejected on `@AuraEnabled` boundaries; destructure inside Apex and expose a named DTO there.

Default method arguments generate overloads:

```apex
@AuraEnabled
public static String formatMessage(
    String subject,
    Boolean urgent = false,
    String prefix = 'Info'
) {
    return prefix + ': ' + subject;
}
```

Generated Apex:

```apex
@AuraEnabled
public static String formatMessage(String subject) {
    return formatMessage(subject, false, 'Info');
}

@AuraEnabled
public static String formatMessage(String subject, Boolean urgent) {
    return formatMessage(subject, urgent, 'Info');
}

@AuraEnabled
public static String formatMessage(String subject, Boolean urgent, String prefix) {
    return prefix + ': ' + subject;
}
```

Custom decorators are user-defined classes. ApexX treats an unknown method annotation as a decorator only when a class of the same name implements `ApexX.Decorator`:

```apex
public with sharing class UserFriendlyError implements ApexX.Decorator {
    public Object handle(ApexX.Invocation ctx, ApexX.Next next) {
        try {
            return next.call();
        } catch (Exception ex) {
            throw new LwcUtil().getUserFriendlyException(ex);
        }
    }
}
```

Source:

```apex
@AuraEnabled
@UserFriendlyError(message = 'Unable to save account.')
public static Account save(Account account, Boolean validate = true) {
    update account;
    return account;
}
```

ApexX removes the custom annotation, preserves native annotations, generates default-argument overloads, moves the original body behind `ApexX.Next`, and writes the shared `ApexX.cls` support class when needed. Decorator arguments are optional; `@UserFriendlyError` can use the policy class default message, while `@UserFriendlyError(message = '...')` overrides it for one method.

## Architecture And Development Notes

Current upstream snapshots inspected during setup:

- `apex-dev-tools/apex-parser` at `ece2f32`, npm package `@apexdevtools/apex-parser@5.1.0`
- `forcedotcom/apex-language-support` at `9a54f45`, including `apex-parser-ast`, `apex-ls`, and `apex-lsp-vscode-extension`

ApexX starts as an integration layer over `@apexdevtools/apex-parser`. A grammar fork remains available later when the language surface grows beyond shallow `.clsx` recognition.

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).

## VS Code Editor Details

The VS Code extension associates `.clsx` with ApexX language mode, starts the ApexX language server, and watches `.clsx` saves to generate Apex. In a Salesforce DX project, saving `apexx/classes/AccountService.clsx` writes:

```text
force-app/main/default/classes/AccountService.cls
force-app/main/default/classes/AccountService.cls-meta.xml
```

The output package directory and API version come from `sfdx-project.json` when present. Outside a Salesforce DX project, ApexX writes to `generated/force-app/main/default/classes`.

For the Visual Studio Code portion of the presentation, open `apexx/classes/AccountService.clsx` and demonstrate this sequence:

1. Add a collection helper and trigger completion after the lambda parameter to show inferred Account or Contact fields.
2. Continue a `filter` / `map` / `flatMap` chain to show that completion follows the changing element type.
3. Introduce a small syntax or type error and show the live compiler diagnostic, then undo it.
4. Hover `Func`, a collection helper, or `UserFriendlyError` to show the language contract in place.
5. Hover a local, a parameter or a method to show its resolved declaration, then press F12 on a call to jump to it.
6. Press F12 on `@UserFriendlyError` to open the decorator class, and on a `PortfolioRuleProvider.resolve` call to cross a file boundary.
7. Open the outline, then rename a variable with F2 to show every occurrence updating.
8. Save the file and show the generated `.cls` and `.cls-meta.xml` files reported by the ApexX output channel.

Snippet prefixes `apexx-func`, `apexx-func-block`, `apexx-tuple`, `apexx-tuple-map`, `apexx-pipeline`, `apexx-defaults`, and `apexx-decorator` are available for a quick authoring demonstration.

## Language Service

The ApexX language server reads `.clsx` directly, so editing feels like editing Apex.
Alongside completion and diagnostics it provides:

| Feature | Behaviour |
| --- | --- |
| Outline and breadcrumbs | Types, methods, fields and properties, nested as declared |
| Hover | The resolved declaration, e.g. `List<Account> accounts` with its kind and owning method |
| Go to definition | Locals, parameters, fields, methods and types; across files for `Type.member`; `@Decorator` opens the class implementing it |
| Find references, highlight, rename | Every occurrence in the file, skipping comments and string literals |
| Signature help | Parameter list and active argument while typing a call |
| Workspace symbols | Every declaration in every `.clsx` file in the workspace |

This works by projecting `.clsx` onto plain Apex before parsing it with
`@apexdevtools/apex-parser`. Each ApexX-only construct -- pipelines, `Func` lambdas,
tuples, tuple destructuring, default arguments -- is replaced by padding of exactly
the same width, so every offset and line number in the parse tree still addresses the
original source. Declarations that only exist in ApexX syntax, such as the target of a
pipeline assignment or the bindings of a tuple destructuring, are recovered from the
ApexX parse result and merged into the same symbol table.

Note that this is a file-scoped symbol service, not a full Apex type checker. Method
resolution does not consider overloads or argument types, and types from the org rather
than the workspace are known only through the cached sObject schema.

## Salesforce Showcase

The project includes an interactive `apexxShowcase` Lightning Web Component and an `ApexX Showcase` Lightning tab. Four presentation chapters establish why the project exists and reveal its compatibility model, unpack each language primitive with executable comparisons, prove the editor and compilation toolchain, and finish with the live portfolio workflow. Every comparison starts from realistic authored Apex and runs against deterministic org data. The language tour covers the complete collection toolkit, block lambdas, a captured `Func` selected from three runtime modes, a cross-class `Map<Id, (Decimal, Boolean)>`, two default parameters with all three call shapes, and a custom decorator whose raw and translated failures can be compared live. Comparisons explicitly retain strong conventional choices such as fused loops and mode helpers, and explain when the ApexX abstraction earns its cost. The final workflow includes all feature-specific authored helpers on both sides and calculates the source reduction directly from the snippets shown. Seed the shared dataset with:

```bash
npm run sf:seed -- --target-org apexx
```

Immediately before presenting, run the non-mutating readiness check. It runs the compiler and editor suite, confirms the generated shared contracts, verifies Salesforce authentication, and checks for exactly four demo Accounts and four Contacts:

```bash
npm run demo:check -- --target-org apexx
```

The VS Code integration intentionally does not promote a dedicated “Preview Generated Apex” experience yet. Compile-on-save still writes inspectable `.cls` artifacts, but the authored `.clsx` remains the presentation surface. A polished generated-code preview belongs after pipeline fusion, when intermediate collection stages no longer make the output look more repetitive than the final compiler model.

For `List<Account>.filter(a => a.)`, `List<Account>.map(a => a.)`, and the other ApexX list helpers, completions infer the lambda parameter from the receiver list. ApexX includes a small built-in Account/Contact fallback and can also read org schema cached under `.apexx/schema/sobjects`. Refresh the local cache from your default org or a specific alias:

```bash
npm run schema:refresh -- Account
npm run schema:refresh -- --target-org apexx Account
```

## Command Reference

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact dependency versions from `package-lock.json`. |
| `npm test` | Build all packages and run compiler plus language-server smoke tests. |
| `npm run apexx -- build` | Compile every project `.clsx` source to Salesforce source format. |
| `npm run apexx -- parse <file.clsx>` | Compile and validate one source file without deploying it. |
| `npm run schema:refresh -- --target-org apexx Account` | Cache org schema for richer sObject completion. |
| `npm run vscode:install` | Install the locally built VS Code extension on Windows, macOS, or Linux. |
| `npm run sf:deploy -- --target-org apexx` | Deploy the generated Apex and Lightning metadata. |
| `npm run sf:seed -- --target-org apexx` | Recreate the dedicated showcase dataset. |
| `npm run sf:test -- --target-org apexx` | Run `AccountServiceTest` with Apex code coverage. |
| `npm run demo:check -- --target-org apexx` | Run the complete local suite and verify demo-org readiness. |
| `npm run sf:open:showcase -- --target-org apexx` | Open the `ApexX Showcase` Lightning tab. |

## Troubleshooting

- **`sf` or `code` is not recognized:** install the Salesforce CLI or VS Code, then open a new terminal so the updated `PATH` is loaded.
- **The `apexx` alias is missing:** rerun `sf org login web --alias apexx --set-default`. Authentication and aliases are local to each computer and are intentionally excluded from Git.
- **The Apex extension reports an unsupported Java runtime:** the JDK path is machine-specific, so it is deliberately not committed to `.vscode/settings.json`. The Salesforce Apex extension detects a JDK automatically; if it cannot, set `salesforcedx-vscode-apex.java.home` in your **user** settings rather than the workspace, for example `C:\\Program Files\\Java\\latest\\jdk-21` on Windows or `/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home` on macOS. This setting is unrelated to ApexX, which needs only Node.
- **VS Code still treats `.clsx` as plain text:** run `npm run build`, reinstall with `npm run vscode:install`, and reload the VS Code window.
- **Completion is missing an org field:** refresh the relevant object with `npm run schema:refresh -- --target-org apexx <ObjectApiName>` and reload the editor window.
- **Lightning shows an older component bundle:** reopen the showcase, then hard-refresh the page. Salesforce persistent component caching can take a short time to invalidate after deployment.
- **The readiness check reports unexpected demo records:** rerun `npm run sf:seed -- --target-org apexx`; it restores the four-Account, four-Contact dataset used by the presentation.

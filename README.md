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
- a language service over `.clsx` and `.apexx`: outline, go to definition across files, go to implementation, find references, rename, signature help, structural folding, quick fixes, and hover reporting real declared types, with an exact position map back to the authored source
- `.apexx` scripts, compiled to self-contained anonymous Apex that runs with Execute in VS Code or `sf apex run`, with nothing to deploy first

Every feature lowers to statically typed Apex. In a class, shared function and tuple signatures are collected into deterministic nested types in `ApexXFuncs.cls` and `ApexXTuples.cls`, avoiding one generated file per structural type. In a script those same types are declared in the block itself, because Apex treats a class declared in an anonymous block as an inner type and rejects an inner type that has inner types.

## Contents

- [Install and validate locally](#install-and-validate-locally)
- [Connect a Salesforce org](#connect-a-salesforce-org)
- [Install the VS Code experience](#install-the-vs-code-experience)
- [Language tour](#language-tour)
- [Scripts: anonymous Apex](#scripts-anonymous-apex)
- [Salesforce showcase](#salesforce-showcase)
- [Command reference](#command-reference)
- [Diagnostic reference](#diagnostic-reference)
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

Inside this Salesforce DX project, compilation writes deployable `.cls` and `.cls-meta.xml` files to `force-app/main/default/classes`, and anonymous blocks to `scripts/apex`. Treat `apexx/classes` and `apexx/scripts` as authored source, and `force-app/main/default/classes` plus `scripts/apex` as compiler output.

## Connect A Salesforce Org

The alias `apexx` is only a local convenience; creating it does not change the org, and every command below also works against whichever org the Salesforce CLI already treats as default. Log in with the same demo-org credentials on each computer:

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

The same applies to `apexx/scripts/AccountAudit.apexx`, which additionally offers **Execute** and **Compile** at the top of the file. See [Scripts: anonymous Apex](#scripts-anonymous-apex).

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

Upstream dependencies and what each is actually good for:

- `@apexdevtools/apex-parser@5.1.0` -- an ANTLR Apex grammar. Syntax only: it produces a
  parse tree, with no symbol table or type resolution. Used both to validate generated
  `.cls` files and, over the offset-preserving projection, to build the symbol model.
- `@apexdevtools/apex-ls` -- BSD-3 and on npm, and it does perform semantic analysis, but
  only in the JVM build. The published JavaScript build exposes `Workspaces.get(path)`
  and `Workspace.findType(name)` and nothing else, so it is not usable here.
- `forcedotcom/apex-language-support` -- a TypeScript LSP implementation with the right
  feature set, but the repository states it is experimental and not to be used, and
  `@salesforce/apex-ls` is not published to npm.
- `apex-jorje-lsp.jar`, from the Salesforce Apex extension -- the only production-grade
  Apex language service available. Closed source, JVM, Apex-only, and it owns a
  per-workspace index that must not be shared. See the Language Service section.

There is no open-source JavaScript Apex semantic layer to build on today, which is why
ApexX carries its own symbol model and treats the Salesforce server as an optional
accelerator rather than a dependency.

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).
Known gaps, with what fixing each involves, are in [docs/limitations.md](docs/limitations.md).

## VS Code Editor Details

The VS Code extension associates `.clsx` and `.apexx` with ApexX language mode, starts the ApexX language server, and watches saves to generate Apex. In a Salesforce DX project, saving `apexx/classes/AccountService.clsx` writes:

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
7. Open the outline, then rename a variable with F2 to show every occurrence updating. Rename a lambda parameter to show that a same-named parameter in another method is untouched.
8. Save the file and show the generated `.cls` and `.cls-meta.xml` files reported by the ApexX output channel.
9. Open `apexx/scripts/AccountAudit.apexx`, show the same completion and hover in a script, then click **Execute** to compile it and run the generated anonymous block against the org.

Every step above uses the built-in symbol model, so none of it depends on a JDK or on
the Salesforce Apex extension being installed.

Snippet prefixes `apexx-func`, `apexx-func-block`, `apexx-tuple`, `apexx-tuple-map`, `apexx-pipeline`, `apexx-defaults`, and `apexx-decorator` are available for a quick authoring demonstration.

### Syntax highlighting

The ApexX grammar colours the ApexX constructs and hands everything else to the Apex
grammar it includes. That include is also the hazard: wherever an Apex block rule
consumes a region first, Apex's own colours apply inside it, so the same decorator could
appear in two different colours in one file, and a class name could come out as plain
text while a built-in type beside it was coloured.

The ApexX rules are therefore injected ahead of both grammars for the whole file, so a
construct is coloured by what it is and not by where it sits. Coloured as their own
thing: decorators and their parameter names, class, interface and enum names, types in
an `extends` or `implements` list, in a `new`, in a generic argument and in a
declaration, collection helpers, lambda arrows and parameters, `Func` types, and tuple
contracts.

`npm run grammar` tokenises with the real TextMate engine and asserts the resulting
scopes, loading the installed Salesforce Apex grammar so the interaction between the two
is what gets tested. After changing a grammar, run `npm run vscode:install` and reload
the window -- grammars are read at extension load.

## Language Service

Editing ApexX is meant to feel like editing Apex. Everything below is served by
ApexX's own symbol model, which needs no JDK and is on by default, and all of it works
in a `.clsx` class and in a `.apexx` script.

| Feature | Behaviour |
| --- | --- |
| Hover | The declaration as Apex would write it, e.g. `private static final Decimal AccountService.MIN_REVENUE_PER_EMPLOYEE` |
| Go to definition | Locals, parameters, fields, methods and types; across files for `Type.member`; `@Decorator` opens the class implementing it |
| Find references, highlight | Every occurrence, scoped to the declaration, skipping comments and string literals |
| Rename | Locals and parameters within their scope; types and members across the file |
| Outline and breadcrumbs | Types, methods, fields and properties, nested as declared |
| Signature help | Parameter list and active argument while typing a call, including every overload of a standard method. Resolves nearest-first: this file, then the workspace, then the Apex standard library |
| Workspace symbols | Every declaration in every `.clsx` in the workspace. Scripts are not indexed, so a rename started in a class does not reach usages inside them |
| Completion | What is in scope, then the workspace's types, then the Apex standard library, then the sObjects the schema describes, then the keywords. ApexX collection helpers, `Func` and tuple snippets, lambda-aware sObject fields, clause-aware SOQL inside a query literal, and `@` decorators with their parameters |
| Diagnostics | ApexX compiler errors, live on every edit, one readable syntax error rather than a recovery cascade |
| Syntax highlighting | Decorators, types, lambdas, `Func` types and tuples, coloured the same wherever they appear |

### How it reads ApexX

`.clsx` is not Apex, so the Apex grammar cannot parse it directly. The language server
projects the source onto plain Apex first: each ApexX-only construct -- pipelines,
`Func` lambdas, tuples, tuple destructuring, default arguments -- is replaced by
padding of exactly the same width, and newlines are never touched. Offsets and line
numbers in the resulting parse tree therefore address the original file, and can be
reported straight back to the editor.

Across the checked-in sources this takes the Apex parse from 62 syntax errors to 0,
with no offset drift and none of the 359 recovered declarations mispositioned.

A script is projected the same way, then parsed with the grammar's anonymous-block rule
rather than its compilation-unit rule, which would fail on the first statement and
collect nothing. The same declaration walk then collects a block's own locals, methods
and types, so hover, outline, definition, references and rename work there unchanged.
Completion never depended on the class shape: it infers a receiver's type from the
declarations, lambda parameters and sObject schema around it.

### What completion offers

Several different questions, answered from several different places.

Where an **identifier** is expected, the offer is what Apex would offer, assembled
from the three things ApexX can see. First what is in scope: locals and parameters
visible at the caret, then the members of the enclosing type, which are writable
unqualified. Then the types -- those declared in the file, those declared anywhere
else in the workspace, the Apex runtime's own types and namespaces, and the sObjects
the cached schema describes. Then the keywords. Ordering is that sequence, so the
nearest thing is the first thing.

A member of a **value** comes from the symbol model: locals and fields, lambda
parameters typed from the list they iterate, and the cached sObject schema -- so
`accounts.filter(account => account.` offers Account fields. `this.` offers the
enclosing type's members, a variable of a type declared in the workspace offers that
type's instance members, and the primitives and collections carry their own tables,
so `Map<Id, Account>` offers `keySet` and `values` rather than nothing.

A member of a **type used statically** comes from the Apex standard library itself. The
Salesforce Apex extension ships `StandardApexLibrary`, an archive of 2365 Apex stub
classes covering every standard type with its real signatures and Salesforce's own
descriptions; it is what the Apex language server resolves against. ApexX reads the same
archive where the user already has it, parses the stubs with the same Apex parser the
compiler uses, and answers from that -- so `Messaging.`, `ConnectApi.`, `Schema.` and
`Limits.` offer what they offer in a `.cls` file, down to the parameter names. Nothing is
downloaded and nothing is vendored: it is the copy on disk, read where it lies, and
`apexx.standardApexLibrary` turns it off.

Apex blurs namespace and class -- `Messaging` both contains `SingleEmailMessage` and
declares `sendEmail` -- so a namespace receiver offers its statics, its instance methods
and the types it contains, rather than one reading of the three.

Two details are worth knowing. A handful of standard methods are named after DML
keywords: `Database.insert` is declared `global static Database.SaveResult insert(...)`,
which the Apex grammar reads as a DML statement rather than a declaration, losing the
method and leaking its parameters. ApexX renames just the declared name before parsing,
which is why `Database.insert` through `Database.merge` resolve at all. And the answer to
an identifier position is cut to the prefix typed so far and reported incomplete, because
offering thousands of type names on every keystroke is not a list, it is a transfer.

Without the Apex extension installed, `Datetime.`, `System.`, `Math.`, `String.`,
`Database.`, `JSON.`, `UserInfo.`, `Test.`, `Limits.`, `Date.`, `Decimal.`, `Integer.`,
`Id.`, `Schema.`, `Trigger.`, `EncodingUtil.`, `Crypto.`, `Blob.`, `EventBus.`,
`Type.`, `Pattern.`, `Approval.`, `Long.`, `Double.` and `Boolean.` fall back to a
curated table of their common statics, and a static receiver outside that list offers
nothing rather than guessing. A class declared in the workspace always offers its own
statics from the index.

A **query literal** is a language of its own, and the caret's clause decides what it
offers: fields of the queried object after `SELECT`, `WHERE`, `ORDER BY` and `GROUP BY`;
sObject names after `FROM`; the aggregate functions, date literals and clause keywords
where each is legal; and, after `:`, the Apex values in scope, because a bind variable
steps back out of the query. A relationship is walked through the schema, so
`[SELECT Account.` on a Contact offers Account's fields. Until `FROM` has been typed the
object is taken from what the query is assigned to, which is how `List<Account> rows = [SELECT `
knows what it is selecting. Brackets that index a list are left alone.

Two more positions accept only one kind of name, and are answered accordingly: after
`implements` or `extends` the offer is the interfaces and classes in the workspace plus
the platform ones a class is usually declared against, and inside `new Account(` it is
that sObject's fields, which is how one is built inline.

An **annotation** is neither. After `@` the offer is the decorator classes in the
workspace, then the native Apex annotations. Inside a decorator's argument list it is
the parameters that decorator accepts -- read from the decorator's own source, not from
a list kept alongside it. A decorator receives an untyped `Map<String, Object>`, so what
it understands is the set of keys it pulls out of `ctx.config`; add a
`ctx.config.get('retries')` and `retries` is offered from then on. The native
annotations that take arguments, such as `@AuraEnabled(cacheable=true)`, are fixed by
the platform and listed.

Declarations that exist only in ApexX syntax are recovered from the ApexX parse result
and merged into the same symbol table: the target of a pipeline assignment, `Func`
lambda variables, lambda parameters, and tuple destructuring bindings. Lambda
parameters are typed from the receiver list, so `accounts.filter(a => ...)` reports `a`
as `Account`.

Scoping is per method and per lambda. A lambda parameter shadows an outer local of the
same name, and a local is never resolved to a same-named local in another method --
which is also why renaming one cannot touch the other.

This is a symbol service, not an Apex type checker. It does not pick an overload from
the argument types: completion offers one entry per name and signature help offers all of
that name's signatures, leaving the choice visible rather than guessed. Types that live in
the org rather than the workspace are known only through the cached sObject schema.
Block scoping is per method, so two `for` loops in one method each declaring `Integer i`
are treated as one variable.

### What else the service answers

**Folding** is structural rather than indentation-based, which is what VS Code falls
back to when nothing answers: braces are counted over source with comments and strings
masked out, so a `}` inside a string closes nothing, block and consecutive line comments
fold as the blocks they read as, and `// #region` pairs fold too.

**Go to implementation** is the other direction from go to definition. On an interface or
class name it lists the workspace types whose declaration names it after `implements` or
`extends`; on one of its members it lists that member on each of them. Interface methods
are a separate rule in the Apex grammar from a class's, so they need their own hook in
the symbol model -- without it an interface declares nothing that an outline, a rename or
this could see.

**Signature help** resolves nearest-first too -- this file, the workspace index, then
the standard library -- so a qualified call, a call into another `.clsx`, and a standard
method all have signatures. The receiver is what makes a qualified call answerable, and
`new` is what says the name is a type whose constructors are being called. Overloads are
listed fewest parameters first, so the simplest is offered by default.

**Annotations** are offered as soon as `@` is typed, because `@` is a completion trigger
character. It has to be: `@` is not a word character, so nothing else would ask.

**ApexX: Restart Language Server** restarts the service in place, which beats reloading
the window when it has gone quiet or its settings changed. Set
`apexxLanguageServer.trace.server` to `verbose` first to see what it is doing.

### Resolving through the Salesforce Apex language server

The Apex language server that ships with the Salesforce Apex extension resolves what
the built-in model cannot: an overload chosen from the argument types, and types that
live in the org rather than in the workspace or the schema cache. ApexX can drive it,
because the lowering pipeline emits an exact position map alongside the generated `.cls`
-- so the server is asked about the generated code and every answer is translated back to
the authored file, with generated names rewritten so a hover reads `Func<Account,
Boolean>` rather than a signature hash.

The standard library used to be on that list and no longer is. ApexX reads the same
`StandardApexLibrary` archive the Apex extension ships, so `System.` offers 189 members
without a JVM, against the 190 the Apex server reports. What enabling it still buys,
measured: cross-file definition, hover that picks the overload matching the arguments,
576 members after `accounts.`, and Apex semantic errors reported on the authored line.

**`apexx.useApexLanguageServer` is off by default, and the reason matters.** The Apex
language server keeps a persistent index at `.sfdx/tools/<version>/apex.db` for the
workspace it runs in, and the Salesforce Apex extension already runs one per open
workspace. Enabling it here starts a second server on the same project, so two
processes write one database. That corrupts it, and a corrupt `apex.db` stops the
Salesforce Apex extension from starting at all:

```text
IndexException: Corrupted database: apex.db
Apex Language Server client: couldn't create connection to server.
```

The remedy is to close the editor and delete `.sfdx/tools/<version>`, which is a cache
and is rebuilt on the next start.

As a second line of defence, ApexX refuses to start the Apex server at all when it
finds an existing `apex.db` in the workspace, whatever the setting says. Enabling the
setting on a project the Apex extension is already indexing therefore does nothing,
rather than doing harm.

Making this safe to enable means running ApexX's server against an isolated shadow
project with its own index. That is the outstanding work; the position map it needs is
already in place. Until then, enable it only on a workspace the Apex extension is not
indexing.

| Setting | Purpose |
| --- | --- |
| `apexx.compileOnSave` | Compile on every save: a `.clsx` to its `.cls` files, a `.apexx` to its anonymous block. On by default |
| `apexx.outputDirectory` | Where generated classes are written; defaults to the Salesforce DX package directory, or `generated/force-app/main/default/classes` outside a DX project |
| `apexx.apiVersion` | API version for generated `.cls-meta.xml`; defaults to `sourceApiVersion` from `sfdx-project.json`, then ApexX's fallback |
| `apexx.scriptOutputDirectory` | Where generated anonymous blocks are written; defaults to `scripts/apex` |
| `apexx.scriptStructuralTypes` | `inline` (default) declares a script's `Func` interfaces and tuple carriers in the block; `deployed` uses the registry members, for interop with a deployed ApexX class |
| `apexx.useApexLanguageServer` | Resolve through the Apex language server. Off by default; see above. Class-only: the bridge projects onto a `.cls` named after the class |
| `apexx.javaHome` | JDK to run it with; defaults to `salesforcedx-vscode-apex.java.home`, then `JAVA_HOME` |
| `apexxLanguageServer.trace.server` | Log traffic between VS Code and the ApexX language server to the ApexX output channel. `messages` names each request, `verbose` includes its payload. Off by default; for diagnosing the language service itself |
| `apexx.standardApexLibrary` | Resolve the Apex standard library from the Salesforce Apex extension's own `StandardApexLibrary` archive, so completion and hover answer from the data the Apex language server uses. On by default, and inert when that extension is not installed |
| `apexx.apexDiagnostics` | Also report Apex semantic errors. Off by default: they catch real mistakes such as calling a method that does not exist, but they also flag code the platform compiles and deploys, so they are advisory. A validate-only deploy of the checked-in classes succeeds while the Apex server reports six errors in them |

`npm run apex-smoke` exercises the Apex-backed path, opting in explicitly. It reports
which of the two paths it managed to verify, and skips rather than fails when no JDK or
jar is present.

## Scripts: Anonymous Apex

An `.apexx` file is authored ApexX that compiles to an anonymous block instead of a class -- `.apexx` is to `.apex` what `.clsx` is to `.cls`. Authored scripts live in `apexx/scripts`; `npm run apexx -- build` writes the generated block to `scripts/apex`, where the Salesforce Apex extension offers **Execute** and **Debug** on every `.apex` file.

```apex
// apexx/scripts/AccountAudit.apexx
List<Account> accounts = [SELECT Id, Name, AnnualRevenue, NumberOfEmployees FROM Account];

List<String> reviewable = accounts
    .filter(account => account.AnnualRevenue > 500000)
    .map(account => account.Name);

Decimal minimumPerEmployee = 10000;
Func<Account, Boolean> isEfficient = (account) =>
    account.AnnualRevenue != null && account.NumberOfEmployees != null
        && account.AnnualRevenue >= minimumPerEmployee * account.NumberOfEmployees;

Map<Id, (String, Decimal)> revenueByAccount = new Map<Id, (String, Decimal)>();
```

A generated script is self-contained and needs nothing deployed. The interfaces its `Func` values implement, the carriers its tuples use, and the classes its lambdas lower to are all declared in the block, above the statements:

```apex
public interface ApexXFunc_8420216b86a6 {
    Boolean invoke(Account arg0);
}

public class ApexXTuple_b1160e58ac54 { /* item0, item1 */ }

private class ApexXLambda0 implements ApexXFunc_8420216b86a6 { /* captures minimumPerEmployee */ }
```

That shape is forced by the platform: a class an anonymous block declares is an inner type, and Apex rejects an inner type that has inner types. So a script cannot carry the nested `ApexXFuncs`/`ApexXTuples` registries a class build deploys, and names its structural types flat instead. The names stay content-addressed, so the same signature keeps the same name across builds.

In VS Code, an `.apexx` file gets **Execute** and **Compile** actions at the top of the file. Execute saves and compiles the script, then hands the generated block to the same Salesforce **Execute Anonymous** command that sits behind Execute on a hand-written `.apex` file, so the log output is identical. Compiler errors stop it before anything runs and are listed in the ApexX output channel. **Debug** is offered on the generated block itself, in `scripts/apex`, rather than on the authored script; runtime positions in a log or a stack trace refer to that generated file, not to authored `.apexx` lines. From the terminal:

```bash
npm run apexx -- build
sf apex run --file scripts/apex/AccountAudit.apex --target-org apexx
```

### Talking to deployed ApexX classes

By default a script declares its structural types inline, which is what makes it self-contained. A deployed ApexX class names the same types as registry members, and a flat name and a registry member are different Apex types even for an identical signature. So passing a `Func` or a tuple across that boundary needs the deployed names:

```bash
npm run apexx -- build --script-types deployed
```

or `apexx.scriptStructuralTypes: "deployed"` in VS Code, which the language service reads too, so diagnostics match how the script will be built. The script then refers to `ApexXFuncs.ApexXFunc_<hash>` and `ApexXTuples.ApexXTuple_<hash>`, which must be deployed; a lambda the script defines itself still lowers in place, implementing the registry interface. Any new signature the script introduces is written into the generated registry classes, so `npm run sf:deploy` picks it up.

Compiling such a script with inline types is reported as `APXX2630` rather than passed through, because the platform failure -- `Illegal assignment from ApexXTuples.ApexXTuple_567e4fc64300 to ApexXTuple_567e4fc64300` -- names neither the script nor the fix.

### Limits

- **Decorators are rejected in a script.** A decorated method lowers to a wrapper plus a `Next` helper class dispatched through the class that holds it. In a block, that helper would be an inner type of an inner type, and a block-level method has no holder at all. Both shapes are reported as errors (`APXX2620`, `APXX2621`) rather than passed through to a confusing platform failure. Put decorated methods in a deployed class and call it from the script.
- **A script is not part of the workspace index.** The language service works inside a script -- diagnostics, type-aware completion, hover, outline, folding, go to definition, find references, rename, signature help, and navigation out into an authored `.clsx` it calls. What it does not do is index the script itself, so find references or rename started from a `.clsx` will not reach usages inside scripts. The optional Apex-language-server acceleration is also class-only, because it works through a shadow `.cls` named after the class and a script declares none.

Everything else works in a script: the full collection toolkit, expression and block lambdas with captures, `Func` values, tuples and tuple-valued maps, and trailing default arguments on a top-level method, which lower to ordinary Apex overloads beside it.

## Salesforce Showcase

The project includes an interactive `apexxShowcase` Lightning Web Component and an `ApexX Showcase` Lightning tab. Four presentation chapters establish why the project exists and reveal its compatibility model, unpack each language primitive with executable comparisons, prove the editor and compilation toolchain, and finish with the live portfolio workflow. Every comparison starts from realistic authored Apex and runs against deterministic org data. The language tour covers the complete collection toolkit, block lambdas, a captured `Func` selected from three runtime modes, a cross-class `Map<Id, (Decimal, Boolean)>`, two default parameters with all three call shapes, and a custom decorator whose raw and translated failures can be compared live. Comparisons explicitly retain strong conventional choices such as fused loops and mode helpers, and explain when the ApexX abstraction earns its cost. The final workflow includes all feature-specific authored helpers on both sides and calculates the source reduction directly from the snippets shown. Seed the shared dataset with:

```bash
npm run sf:seed -- --target-org apexx
```

The toolchain chapter covers the language service as it actually behaves -- hover, definition and implementation, references and rename, completion across scope, workspace, standard library and schema, signature help with overloads, structural folding, live diagnostics and compile on save -- plus the source-map bridge to the Apex language server and why it stays off by default. It ends with an `.apexx` script shown beside the anonymous block it compiles to.

The ApexX half of every code panel is sliced out of the authored sources by `npm run showcase:snippets` into `showcaseSource.js`, so a panel cannot claim code the compiler would refuse. `npm test` fails when that file is stale.

Immediately before presenting, run the non-mutating readiness check. It runs the compiler and editor suite, confirms the generated shared contracts, verifies Salesforce authentication, and checks for exactly four demo Accounts and four Contacts:

```bash
npm run demo:check
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
| `npm test` | Build all packages, then run the compiler, language-server, grammar and showcase-panel tests. |
| `npm run grammar` | Tokenise ApexX with the real TextMate engine and assert the scopes. |
| `npm run showcase:snippets` | Regenerate the showcase's ApexX code panels from the authored sources. |
| `npm run apex-smoke` | Exercise the Apex-language-server path; skips without a JDK or jar. |
| `npm run test:all` | Run `npm test` followed by `npm run apex-smoke`. |
| `npm run apexx -- build` | Compile every project `.clsx` class and `.apexx` script. |
| `npm run apexx -- build --script-types deployed` | Compile scripts against the deployed structural-type registries. |
| `npm run apexx -- parse <file.clsx\|file.apexx>` | Compile and validate one source file without deploying it. |
| `sf apex run --file scripts/apex/AccountAudit.apex --target-org apexx` | Run a generated anonymous block from the terminal. |
| `npm run schema:refresh -- --target-org apexx Account` | Cache org schema for richer sObject completion. |
| `npm run vscode:install` | Install the locally built VS Code extension on Windows, macOS, or Linux. |
| `npm run sf:deploy -- --target-org apexx` | Deploy the generated Apex and Lightning metadata. |
| `npm run sf:seed -- --target-org apexx` | Recreate the dedicated showcase dataset. |
| `npm run sf:test -- --target-org apexx` | Run `AccountServiceTest` with Apex code coverage. |
| `npm run demo:check` | Run the complete local suite and verify demo-org readiness. Add `-- --target-org <alias>` to override the CLI's default org. |
| `npm run sf:open:showcase -- --target-org apexx` | Open the `ApexX Showcase` Lightning tab. |

## Diagnostic Reference

Coded diagnostics belong to constructs whose lowering hides the real Apex type behind a
generated class, so a platform error would name `ApexXTuple_935886cf7d05` rather than
anything in the source. The code is stable; the message is not -- match on the code.

The code is carried as the diagnostic's code rather than inside its text, so the
Problems panel shows it as `apexx-semantics(APXX2412)` and links it to this section,
and `apexx build` prints it ahead of the message. Type mismatches outside these
constructs -- a list-chain step, or a `Func` lambda whose body contradicts its
declaration -- carry no code and are reported by message alone.

| Code | Reported when |
| --- | --- |
| `APXX2401` | A tuple declares fewer than two elements. |
| `APXX2402` | A tuple element is not a valid Apex type. |
| `APXX2403` | A tuple return crosses an `@AuraEnabled` boundary. Destructure it in Apex and return a DTO or `Map`. |
| `APXX2404` | Warning: a tuple carries more than seven elements. Consider a named type. |
| `APXX2405` | The body of a tuple-returning method could not be located. |
| `APXX2406` | A tuple `return` supplies the wrong number of values. |
| `APXX2407` | A destructuring declares fewer than two typed variables. |
| `APXX2408` | A destructuring repeats a variable name. |
| `APXX2409` | A destructuring is missing its semicolon. |
| `APXX2410` | A `Map` tuple value is not two or more valid Apex types. |
| `APXX2411` | A `Map` tuple value supplies the wrong number of values. |
| `APXX2412` | A tuple value's type does not fit the element the contract declares. |
| `APXX2413` | A destructuring declares a different number of variables than the called method returns. |
| `APXX2414` | A destructured variable's type does not fit the element the called method returns. |
| `APXX2620` | A decorator is applied to a method at the top level of a script. Decorators dispatch through the class holding the method. |
| `APXX2621` | A decorator is applied to a method of a class declared in a script, where the generated helper would be an inner type of an inner type. |
| `APXX2630` | A script exchanges a `Func` or tuple with a deployed class while declaring its structural types inline. Build with `--script-types deployed`. |


## Troubleshooting

- **`sf` or `code` is not recognized:** install the Salesforce CLI or VS Code, then open a new terminal so the updated `PATH` is loaded.
- **The `apexx` alias is missing:** rerun `sf org login web --alias apexx --set-default`. Authentication and aliases are local to each computer and are intentionally excluded from Git.
- **The Apex extension reports an unsupported Java runtime:** the JDK path is machine-specific, so it is deliberately not committed to `.vscode/settings.json`. The Salesforce Apex extension detects a JDK automatically; if it cannot, set `salesforcedx-vscode-apex.java.home` in your **user** settings rather than the workspace, for example `C:\\Program Files\\Java\\latest\\jdk-21` on Windows or `/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home` on macOS. This setting is unrelated to ApexX, which needs only Node.
- **The Salesforce Apex extension will not start, reporting `Corrupted database: apex.db`:** two Apex language servers wrote one index. Close the editor, delete `.sfdx/tools/<version>` -- a cache, rebuilt on next start -- and leave `apexx.useApexLanguageServer` off, which is the default.
- **Hover shows one signature of an overloaded method:** hover reports the first, because nothing in a hover says which arguments are being passed. Signature help lists all of them, and typing the call is where that matters. Picking the overload from the argument types needs `apexx.useApexLanguageServer`, which is off by default for the reason above.
- **`System.` or `Messaging.` offers only the common members:** the Apex standard library is read from the Salesforce Apex extension. Without that extension ApexX falls back to its curated table; install it, or point `APEXX_STANDARD_LIBRARY` at a `StandardApexLibrary.zip`.
- **VS Code still treats `.clsx` or `.apexx` as plain text, or highlighting looks wrong after a grammar change:** run `npm run build`, reinstall with `npm run vscode:install`, and reload the VS Code window. Grammars are read when the extension loads, so a reload is required even though the language server picks up changes on restart.
- **Completion after a `.` offers nothing:** the receiver has to be resolvable. A value is resolved from the declarations around it and the cached sObject schema; a type used statically is resolved from the Apex standard library, and falls back to the curated table in [What completion offers](#what-completion-offers) when the Salesforce Apex extension is not installed.
- **`Execute` on a `.apexx` file does nothing:** it delegates to the Salesforce Apex extension's Execute Anonymous command, which needs that extension installed and a default org set (`sf org login web --alias apexx --set-default`). Without the extension, ApexX falls back to running `sf apex run` in a terminal. If the script has compiler errors it reports them instead of running; check the ApexX output channel.
- **A script fails in the org with `Illegal assignment from ApexXTuples.ApexXTuple_... to ApexXTuple_...`:** the script exchanges a `Func` or a tuple with a deployed ApexX class, so it needs the deployed structural types. Build it with `--script-types deployed`, or set `apexx.scriptStructuralTypes` to `deployed`, and deploy `ApexXFuncs.cls` and `ApexXTuples.cls`. ApexX reports this as `APXX2630` before you run it.
- **Completion is missing an org field:** refresh the relevant object with `npm run schema:refresh -- --target-org apexx <ObjectApiName>` and reload the editor window.
- **Lightning shows an older component bundle:** reopen the showcase, then hard-refresh the page. Salesforce persistent component caching can take a short time to invalidate after deployment.
- **The readiness check reports unexpected demo records:** rerun `npm run sf:seed -- --target-org apexx`; it restores the four-Account, four-Contact dataset used by the presentation.

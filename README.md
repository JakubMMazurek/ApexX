# ApexX

ApexX is an experimental extended Apex source language. It uses `.clsx` as the source extension and emits ordinary Salesforce Apex `.cls` files.

The first milestone is intentionally small:

- ordinary Apex in `.clsx` is emitted as ordinary `.cls`
- lambda arguments parse on ApexX `List<T>` helpers such as `filter`, `map`, `flatMap`, `find`, `any`, `all`, and `count`
- `filter` lowers to a typed Apex loop, avoiding `Object` casts in generated code
- `map` lowers to a typed Apex loop that produces `List<R>`
- `find`, `any`, `all`, and `count` lower to typed scalar/item loops
- `flatMap` lowers to a typed `addAll` loop that flattens `List<R>` bodies
- chained list helpers are typed step by step
- standalone `List<T>.filter(...)` expression statements parse while editing, even when the result is not assigned
- `Func<T1, T2, TResult> name = (x, y) => expression` lowers to a generated invokable inner class
- `Func` variables can be called directly in `.clsx`; generated Apex emits `.invoke(...)`
- upstream Apex parsing is reused to validate generated `.cls`

## Quick Start

```powershell
cd C:\Users\qba05\Documents\ApexX
npm install
npm run build
npm run test
npm run apexx -- build
```

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

`Func` lambda assignments are also supported as a first proof of concept. ApexX accepts C#-style lowercase aliases such as `int` and `bool` and emits Salesforce Apex type names:

```apex
Func<int, int, bool> testForEquality = (x, y) => x == y;
return testForEquality(left, right);
```

Generated Apex:

```apex
public interface ApexXFunc0 {
    Boolean invoke(Integer x, Integer y);
}

private class ApexXLambda0 implements ApexXFunc0 {
    public Boolean invoke(Integer x, Integer y) {
        return x == y;
    }
}

ApexXFunc0 testForEquality = new ApexXLambda0();
return testForEquality.invoke(left, right);
```

## Upstream Reuse

Current upstream snapshots inspected during setup:

- `apex-dev-tools/apex-parser` at `ece2f32`, npm package `@apexdevtools/apex-parser@5.1.0`
- `forcedotcom/apex-language-support` at `9a54f45`, including `apex-parser-ast`, `apex-ls`, and `apex-lsp-vscode-extension`

ApexX starts as an integration layer over `@apexdevtools/apex-parser`. A grammar fork remains available later when the language surface grows beyond shallow `.clsx` recognition.

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).

## VS Code

The VS Code extension associates `.clsx` with ApexX language mode, starts the ApexX language server, and watches `.clsx` saves to generate Apex. In a Salesforce DX project, saving `apexx/classes/AccountService.clsx` writes:

```text
force-app/main/default/classes/AccountService.cls
force-app/main/default/classes/AccountService.cls-meta.xml
```

The output package directory and API version come from `sfdx-project.json` when present. Outside a Salesforce DX project, ApexX writes to `generated/force-app/main/default/classes`.

For `List<Account>.filter(a => a.)`, `List<Account>.map(a => a.)`, and the other ApexX list helpers, completions infer the lambda parameter from the receiver list. ApexX includes a small built-in Account/Contact fallback and can also read org schema cached under `.apexx/schema/sobjects`. Refresh the local cache from your default org or a specific alias:

```powershell
npm run schema:refresh -- Account
npm run schema:refresh -- --target-org apexx Account
```

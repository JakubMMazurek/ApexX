# ApexX

ApexX is an experimental extended Apex source language. It uses `.clsx` as the source extension and emits ordinary Salesforce Apex `.cls` files.

The first milestone is intentionally small:

- ordinary Apex in `.clsx` is emitted as ordinary `.cls`
- `List<T>.filter(item => predicate)` parses in `.clsx`
- `filter` lowers to a typed Apex loop, avoiding `Object` casts in generated code
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
        return accounts.filter(a => a.Rating == 'Hot');
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
        return apexxFilter0;
    }
}
```

## Upstream Reuse

Current upstream snapshots inspected during setup:

- `apex-dev-tools/apex-parser` at `ece2f32`, npm package `@apexdevtools/apex-parser@5.1.0`
- `forcedotcom/apex-language-support` at `9a54f45`, including `apex-parser-ast`, `apex-ls`, and `apex-lsp-vscode-extension`

ApexX starts as an integration layer over `@apexdevtools/apex-parser`. A grammar fork remains available later when the language surface grows beyond shallow `.clsx` recognition.

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).

## VS Code

The VS Code extension contributes `.clsx` language support and compiles on save by default. In a Salesforce DX project, saving `apexx/classes/AccountService.clsx` writes:

```text
force-app/main/default/classes/AccountService.cls
force-app/main/default/classes/AccountService.cls-meta.xml
```

The output package directory and API version come from `sfdx-project.json` when present. Outside a Salesforce DX project, ApexX writes to `generated/force-app/main/default/classes`.

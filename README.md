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
npm run apexx -- build examples --out generated
```

Example `.clsx`:

```apex
public with sharing class AccountService {
    public static List<Account> hotAccounts(List<Account> accounts) {
        return accounts.filter(a => a.Rating == 'Hot');
    }
}
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


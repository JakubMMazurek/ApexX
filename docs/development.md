# Development

## Install And Build

```bash
git clone https://github.com/JakubMMazurek/ApexX.git
cd ApexX
npm ci
npm run build
```

## Run The PoC

```bash
npm run apexx -- build
```

Outside a Salesforce DX project, this writes Salesforce source-format files under `generated/force-app/main/default/classes`.

## Validate

```bash
npm run test
```

The smoke test builds `apexx/classes` and checks that the generated output contains the expected typed loops, default-argument overloads, decorator lowering, generated `ApexX.cls` support, the aggregated `ApexXFuncs.cls` and `ApexXTuples.cls` structural registries, unresolved decorator diagnostics, and valid editor contributions. The LSP smoke test opens in-memory `.clsx` documents against the real ApexX language server and checks completion labels for list chains and lambda parameters as well as feature hover documentation.

The `apexx/classes` directory is the living showcase. It contains collection helpers, default arguments, first-class `Func` values, general block lambdas, arbitrary-arity tuples, tuple-valued maps, deterministic cross-class structural contracts, generated decorators, and the user-defined `UserFriendlyError` policy class.

## Salesforce Showcase

Build, deploy, seed test data, and open the Lightning tab:

```bash
npm run apexx -- build
npm run sf:deploy -- --target-org apexx
npm run sf:seed -- --target-org apexx
npm run sf:test -- --target-org apexx
npm run demo:check -- --target-org apexx
npm run sf:open:showcase -- --target-org apexx
```

The `apexxShowcase` LWC is an executable, four-chapter presentation. It opens with the language problem and ApexX compatibility model, moves through focused executable examples, explains the VS Code and compilation toolchain, and reserves the complete portfolio briefing for the final reveal. Focused examples cover `flatMap`, `filter`, `map`, `count`, `any`, `all`, and `find`; block lambdas; a captured `Func` selected from three runtime modes; a cross-class map whose values are `(Decimal, Boolean)` tuples; two default parameters and their three call shapes; and the decorator boundary. The comparisons use realistic conventional Apex rather than inflated patterns: fused loops and mode helpers remain visible, and the presentation states their performance or simplicity advantages. The decorator tab contrasts the actual raw Salesforce exception with the safe LWC response and exposes the custom decorator contract and implementation. The final portfolio-briefing workflow includes the feature-specific helpers on both sides and reports the source reduction calculated from the complete displayed snippets.

`AccountServiceTest.clsx` exercises the composed workflow, focused examples, raw and decorated error paths, shared overview, and legacy entry points as native Salesforce tests.

## Parse A Single File

```bash
npm run apexx -- parse apexx/classes/AccountService.clsx
```

`parse` runs the ApexX lowering path and validates the generated Apex through `@apexdevtools/apex-parser`.

## VS Code Extension

The extension package associates `.clsx` with ApexX language mode and starts the ApexX language server after the repo is built. It contributes dedicated syntax scopes, indentation and folding rules, snippets, hover documentation, live compiler diagnostics, and type-aware completion.

It also compiles on save by default. In a Salesforce DX workspace, a saved `apexx/classes/<ClassName>.clsx` file generates:

```text
force-app/main/default/classes/<ClassName>.cls
force-app/main/default/classes/<ClassName>.cls-meta.xml
```

Compile-on-save rescans the workspace's `.clsx` sources and regenerates the two shared structural registries. Function interfaces are nested in `ApexXFuncs.cls`; tuple carriers are nested in `ApexXTuples.cls`. This preserves contracts used by other source classes while keeping the generated classes directory free of one-file-per-signature clutter.

The language server infers a lambda parameter from the receiver list. For example, in `accounts.filter(a => a.)`, `accounts.map(a => a.)`, or `accounts.find(a => a.)`, `a` is treated as `Account` when `accounts` is declared as `List<Account>`. It also follows typed chains such as `accounts.flatMap(a => a.Contacts).map(c => c.)`, where `c` is treated as `Contact`. sObject field completions use built-in fallbacks first, and they can use a local org schema cache:

```bash
npm run schema:refresh -- --target-org apexx Account
```

The generated cache lives under `.apexx/schema/sobjects` and is intentionally ignored by Git because it is org-specific.

The extension uses the default `packageDirectories` entry and `sourceApiVersion` from `sfdx-project.json`. The same behavior is available manually through `ApexX: Build Current File`.

Open `packages/vscode-extension` as an extension development host target after running:

```bash
npm install
npm run build
```

For a demo-machine install, run `npm run vscode:install`, reload VS Code, and open `apexx/classes/AccountService.clsx`. The installer copies the extension UI contributions and uses the built workspace packages for the language server and compiler. It runs on Windows, macOS, and Linux, installs into `~/.vscode/extensions`, and accepts `--extensions-dir` for VS Code forks.

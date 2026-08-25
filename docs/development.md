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

This builds both source roots: `apexx/classes` to deployable `.cls` files, and
`apexx/scripts` to anonymous blocks in `scripts/apex`. Outside a Salesforce DX project,
classes go to `generated/force-app/main/default/classes` instead. `--scripts-out`
redirects the script output, and `--script-types deployed` compiles scripts against the
deployed structural-type registries rather than declaring those types in the block.

## Validate

```bash
npm run test
```

`npm test` builds every package, then runs three test stages: `npm run smoke` for the
compiler, `npm run lsp-smoke` against the real language server over stdio, and
`npm run grammar` for syntax highlighting. Only the last needs extra dependencies --
`vscode-textmate` and `vscode-oniguruma`, both devDependencies -- and it is the only
stage that reads anything from outside the repository.

`npm run test:all` adds `npm run apex-smoke`, which exercises the optional
Apex-language-server path. It skips, rather than fails, when there is no JDK, no
`apex-jorje-lsp.jar`, or when the workspace already has an Apex index that another
server owns -- and it reports which of the two resolution paths it managed to verify.

The smoke test also checks the editor contributions against the Salesforce Apex extension when it is installed: the language configuration key by key, and that every Apex snippet prefix has an ApexX counterpart. Both skip with a message rather than failing when it is absent, and the `wordPattern` is additionally checked behaviourally -- it must match whole identifiers and stop where a word ends -- because a pattern matching nothing silently disables auto-triggered completion while leaving trigger characters working.

The smoke test builds `apexx/classes` and checks that the generated output contains the expected typed loops, default-argument overloads, decorator lowering, generated `ApexX.cls` support, the aggregated `ApexXFuncs.cls` and `ApexXTuples.cls` structural registries, unresolved decorator diagnostics, and valid editor contributions. It also covers anonymous-block output: flat structural declarations carried in the block, validation against the anonymous-block grammar, the lambda implementation class that a class-less unit used to drop, default arguments on a block-level method, the rejected decorator shapes, and both sides of the `APXX2630` structural-type boundary. Diagnostics are covered for position as well as content: that each one covers the construct it is about and no surrounding whitespace, that a stage which adds or removes lines above an error does not slide its squiggle, and that the compatibility checks report a real mismatch while staying silent on a legal one -- numeric widening, a ternary typed from its branches, an uninferable expression, an ambiguous overload. Those tests were written against deliberately broken builds of each check, so a check that stops working fails its own test rather than passing quietly. The LSP smoke test opens in-memory `.clsx` and `.apexx` documents against the real ApexX language server and checks completion labels for list chains and lambda parameters, feature hover documentation, script diagnostics at authored positions, that a coded diagnostic arrives as a `code` with a `codeDescription` link and no code repeated in its text while an uncoded one carries neither, and hover, outline, definition, references and rename inside a script. It also covers the rest of the service: what an identifier position offers and in what order, members of the collections and primitives, `this`, a workspace type used statically and as an instance, each SOQL clause and the bracket that is an index rather than a query, `implements`, an sObject constructor, that every item carries the range of the identifier being typed and that a snippet body travels in that edit, structural folding of braces and comments and `#region` markers, go to implementation on a type and on one of its members, an interface's own methods, and signature help for a qualified call, a call into another file, and a standard method with all of its overloads.

`npm run grammar` tokenises with the real TextMate engine and holds the grammar to one
bar: source that is legal Apex must produce the same scopes under `source.apexx` as
under `source.apex`, token for token. Both grammars are read from this repo, so the
comparison does not depend on the Salesforce extension being installed. That is the
check the previous suite could not make -- it asserted ApexX's own scope names, so it
passed while the grammar disagreed with Apex about roughly two thirds of an ordinary
class. The ApexX-only constructs are then checked on their own, and the demo sources are
checked for tokens that reached no rule at all.

The grammar is generated, not edited: `npm run grammar:build` (which `npm run build`
runs first) rebuilds `apexx.tmLanguage.json` from the vendored Apex grammar plus
`apexx-additions.json`, and the smoke test fails if the committed file is not what the
generator produces.

The `apexx/classes` directory is the living showcase. It contains collection helpers, default arguments, first-class `Func` values, general block lambdas, arbitrary-arity tuples, tuple-valued maps, deterministic cross-class structural contracts, generated decorators, and the user-defined `UserFriendlyError` policy class.

`apexx/scripts` holds authored scripts. `AccountAudit.apexx` exercises the collection
pipeline, a block lambda that captures a local, and a tuple-valued map inside a single
anonymous block that needs nothing deployed.

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
npm run apexx -- parse apexx/scripts/AccountAudit.apexx
```

`parse` runs the ApexX lowering path and validates the generated Apex through
`@apexdevtools/apex-parser`, against the compilation-unit rule for a class and the
anonymous-block rule for a script.

## Language Server

`packages/language-server` is a symbol service, not only diagnostics. The modules:

| Module | Responsibility |
| --- | --- |
| `apexModel.ts` | Projects ApexX onto plain Apex at identical offsets, walks the parse tree for declarations, recovers declarations that exist only in ApexX syntax, and resolves identifiers by innermost scope. A `.apexx` script is walked from the anonymous-block rule, so a block's own declarations are collected |
| `workspaceIndex.ts` | A parsed model of every `.clsx` in the workspace, open documents taking precedence over disk, for cross-file resolution. Class-only: a script exports nothing to other files, so a rename started in a class does not reach usages inside scripts |
| `sobjectSchema.ts` | The cached org schema used for sObject field completion, and the sObject names offered as types |
| `standardLibrary.ts` | Reads the Apex standard library out of the Salesforce Apex extension's `StandardApexLibrary` archive -- 2365 stub classes with real signatures and Salesforce's own descriptions -- parsed with the same Apex parser the compiler uses, lazily and cached. Absent extension, absent library: every lookup returns nothing and the curated table answers instead |
| `apexGlobals.ts` | The fallback table of common Apex types, namespaces, primitive and collection members, and the keywords |
| `soql.ts` | Recognises a query literal and answers by clause: fields, sObject names, functions, date literals, clause keywords, and bind variables back out into Apex scope |
| `jorjeClient.ts` | Optional: owns the Salesforce Apex language server process, discovers the jar and a JDK, and degrades quietly when either is missing |
| `apexBridge.ts` | Optional: transpiles in memory, maps positions both ways through the compiler's source map, and rewrites generated names |

The projection is what makes the rest possible. Each ApexX-only construct -- pipelines,
`Func` lambdas, tuples, tuple destructuring, default arguments -- is replaced by padding
of exactly the same width, and newlines are never touched, so offsets and line numbers
in the parse tree address the authored file. Declarations that only exist in ApexX
syntax are recovered from the ApexX parse result: the target of a pipeline assignment,
`Func` lambda variables, lambda parameters, and tuple destructuring bindings.

Scoping is per method and per lambda, so a lambda parameter shadows an outer local and
a rename cannot reach a same-named local in another method.

Completion answers several different questions, each from whichever source can answer
it: what is in scope, then the workspace, then the Apex standard library, then the
sObject schema, then the keywords. `docs/architecture.md` describes the whole set; the
parts worth knowing while working on it are that a static receiver is answered from the
Apex extension's own `StandardApexLibrary` archive when that extension is installed and
from `apexGlobals.ts` otherwise, that a query literal is answered by `soql.ts` from the
caret's clause, and that an annotation is answered from the workspace's decorators plus
the native Apex annotations -- with a decorator's argument list read from the keys it
pulls out of `ctx.config`, the only honest source for parameters passed as an untyped
`Map<String, Object>`.

Two invariants are easy to break and hard to notice:

- **Every item needs the range of the identifier being typed.** Without one the editor
  cannot match items against the typed word, so it stops filtering and shows everything.
- **An identifier answer that consulted the standard library must report itself
  incomplete.** The library is thousands of types, so the answer is cut to the prefix
  typed so far; saying it is complete makes the editor filter that cut list forever.

Overloads are deliberately collapsed to one entry in completion and expanded in
signature help, which resolves nearest-first through the current file, the workspace
index, then the library.

A script is answered by this model alone. The Apex-server path is class-only, because
`apexBridge` projects a document onto a `.cls` named after its class, and a script
declares none; `askApex` returns early rather than handing that server a file of loose
statements under an invented class name.

Locals, parameters and decorator annotations are always answered by this model even
when the Apex server is enabled: it positions them exactly inside lowered statements,
where a generated position can only map back to the statement, and annotations do not
survive lowering as annotations.

### The optional Apex-language-server path

`apexx.useApexLanguageServer` is off by default. The Apex language server keeps a
persistent index at `.sfdx/tools/<version>/apex.db` for its workspace and does not lock
it, and the Salesforce Apex extension already runs one per open workspace. A second
server on the same project corrupts that index, which stops the Salesforce Apex
extension from starting at all. `jorjeClient` also refuses to start when it finds an
existing `apex.db`, regardless of the setting.

If an index does get corrupted, close the editor and delete `.sfdx/tools/<version>`;
it is a cache and is rebuilt on the next start.

## VS Code Extension

The extension package associates `.clsx` and `.apexx` with ApexX language mode and starts the ApexX language server after the repo is built. It contributes dedicated syntax scopes, snippets, hover documentation, live compiler diagnostics, and type-aware completion.

Its `language-configuration.json` is a byte-for-byte copy of the Salesforce Apex
extension's: word boundaries, indentation, auto-closing pairs, comment markers and
folding markers all behave in a `.clsx` file the way they do in a `.cls` file, and
`smoke-test.mjs` compares the two key by key whenever that extension is installed. The
`wordPattern` in particular is load-bearing beyond word selection -- the editor skips
auto-triggered completion entirely when no word can be read at the caret -- so it is also
checked behaviourally, without needing the Apex extension present.

The snippets cover every prefix the Apex extension defines, with ApexX's own bodies, so a
file moved from `.cls` to `.clsx` keeps whatever the author already types. A test fails
if an Apex prefix has no ApexX counterpart. Note that Apex's `for` is the for-each form
and `fori` is the counted loop, which is worth checking against before adding another.

**ApexX: Restart Language Server** restarts the service without reloading the window,
and `apexxLanguageServer.trace.server` logs the traffic to the ApexX output channel --
that name is keyed by the language client's own id, which is what
`vscode-languageclient` reads, so renaming the client renames the setting.

One grammar ships with it, and it is generated. `scripts/build-grammar.mjs` reads the
vendored Salesforce Apex grammar in `packages/vscode-extension/grammars`, retargets it
at `source.apexx`, and splices in the ApexX rules from `syntaxes/apexx-additions.json`
at the points named there. To change the highlighting, edit the additions file and
rebuild -- editing `apexx.tmLanguage.json` directly is overwritten by the next build and
caught by the smoke test. `grammars/README.md` covers re-vendoring when Salesforce ships
a new Apex grammar.

Grammars are read when the extension loads, so a grammar change needs
`npm run vscode:install` and a window reload, not just a server restart.

It also compiles on save by default. In a Salesforce DX workspace, a saved `apexx/classes/<ClassName>.clsx` file generates:

```text
force-app/main/default/classes/<ClassName>.cls
force-app/main/default/classes/<ClassName>.cls-meta.xml
```

A saved `apexx/scripts/<ScriptName>.apexx` file generates one anonymous block, with no
metadata file because a block is not metadata:

```text
scripts/apex/<ScriptName>.apex
```

A script also gets an **Execute** and a **Compile** code lens. Execute saves the file,
compiles it, opens the generated block, and runs it through the Salesforce Apex
extension's Execute Anonymous command -- the same command behind Execute on a
hand-written `.apex` file, so logs and the replay debugger behave identically. Without
that extension it falls back to `sf apex run` in a terminal. Compiler errors stop it
before anything runs, and are listed in the ApexX output channel.

`apexx.scriptOutputDirectory` moves the generated blocks; `apexx.scriptStructuralTypes`
chooses between declaring a script's structural types inline and using the deployed
registry members, and the language server reads it too so diagnostics match how the
script will be built.

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

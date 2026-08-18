# ApexX Architecture

## Goals

ApexX should feel like Apex with carefully chosen modern additions, not like a separate runtime. The compiler accepts `.clsx` files and emits deployable `.cls` files.

The v0.1 compatibility rule is simple: if a `.clsx` file contains ordinary Apex, the generated `.cls` should remain ordinary Apex plus a generated header.

## Upstream Strategy

`apex-dev-tools/apex-parser` is the primary parser dependency. It provides ANTLR grammars and TypeScript APIs such as `ApexParserFactory`. ApexX uses it to validate generated `.cls` files.

`forcedotcom/apex-language-support` is the main reference for language-server structure. It currently contains package boundaries for parser AST, LSP services, `apex-ls`, and the VS Code extension. ApexX mirrors that separation at a much smaller scale.

The first implementation does not fork the grammar. Instead, it recognizes a tiny ApexX surface and lowers it before passing generated Apex to the upstream parser. A future grammar fork belongs under `packages/parser/grammar` or a dedicated `packages/grammar-fork` package once ApexX syntax needs full CST support.

## Packages

- `@apexx/ast`: shared AST and diagnostic types for ApexX additions
- `@apexx/semantics`: small semantic helpers, currently `List<T>` receiver discovery and generated-name allocation
- `@apexx/parser`: upstream Apex parser wrapper plus ApexX lambda/list-method discovery
- `@apexx/transpiler`: lowers `.clsx` source into `.cls` source
- `@apexx/sfdx`: Salesforce DX layout detection and `.cls-meta.xml` generation
- `@apexx/cli`: command-line build and parse entry point
- `@apexx/language-server`: minimal LSP diagnostics for `.clsx`
- `apexx-vscode-extension`: local VS Code extension shell for `.clsx`

## v0.1 Lambda Shape

Supported:

```apex
accounts.filter(a => a.Rating == 'Hot')
    .filter(a => a.AccountNumber != null)
```

Inside a return expression:

```apex
return accounts.filter(a => a.Rating == 'Hot');
```

Inside a `List<T>` assignment expression:

```apex
List<Account> hot = accounts.filter(a => a.Rating == 'Hot');
```

As a standalone expression statement:

```apex
accounts.filter(a => a.Rating == 'Hot');
```

The receiver must currently begin as a simple variable whose type is discoverable as `List<T>` in the same file. Every chained `filter` preserves that same `List<T>` type, so each lambda parameter is typed as `T` and each generated loop produces another `List<T>`.

Source-level function values are supported for local assignments:

```apex
Func<int, int, bool> testForEquality = (x, y) => x == y;
return testForEquality(left, right);
```

The last `Func` type argument is the return type. Earlier type arguments are lambda parameter types. For deployable Apex, the transpiler emits a generated inner interface plus a generated inner class with an `invoke(...)` method, then initializes the local variable with that generated class. Direct source calls such as `testForEquality(left, right)` are lowered to `testForEquality.invoke(left, right)`.

## Generated Names

Generated locals use names such as `apexxFilter0`. They intentionally avoid underscores because Apex identifiers cannot begin with an underscore, end with an underscore, or contain consecutive underscores.

The transpiler checks existing identifiers and increments the numeric suffix until the generated name is free.

## Salesforce DX Output

ApexX writes Apex classes in Salesforce source format:

```text
apexx/classes/ClassName.clsx
```

to:

```text
force-app/main/default/classes/ClassName.cls
force-app/main/default/classes/ClassName.cls-meta.xml
```

When `sfdx-project.json` is present, ApexX uses its default package directory and `sourceApiVersion`. Outside a Salesforce DX project, it falls back to:

```text
generated/force-app/main/default/classes
```

## Future Surface

The next major design thread is making source-level generic function types first-class across method parameters, fields, and list APIs:

```apex
Func<Integer, Integer, Boolean> testForEquality = (x, y) => x == y;
```

The current implementation supports local assignments and direct calls to those local `Func` variables.

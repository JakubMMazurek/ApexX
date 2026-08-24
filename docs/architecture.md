# ApexX Architecture

## Goals

ApexX should feel like Apex with carefully chosen modern additions, not like a separate runtime. The compiler accepts `.clsx` files and emits deployable `.cls` files.

The v0.1 compatibility rule is simple: if a `.clsx` file contains ordinary Apex, the generated `.cls` should remain ordinary Apex plus a generated header.

## Upstream Strategy

`@apexdevtools/apex-parser` is the parser dependency: an ANTLR Apex grammar with
TypeScript APIs such as `ApexParserFactory`. It is syntax only -- a parse tree, with no
symbol table and no type resolution. ApexX uses it twice: to validate generated `.cls`
files, and to build the symbol model from an offset-preserving projection of `.clsx`.

There is no open-source JavaScript Apex semantic layer to build on:

- `@apexdevtools/apex-ls` is BSD-3, published, and does perform semantic analysis, but
  only in its JVM build. The published JavaScript build exposes `Workspaces.get(path)`
  and `Workspace.findType(name)` and nothing more.
- `forcedotcom/apex-language-support` is TypeScript with the right feature set, but the
  repository states it is experimental and not to be used, and `@salesforce/apex-ls` is
  not published to npm.
- `apex-jorje-lsp.jar`, inside the Salesforce Apex extension, is the only
  production-grade Apex language service available. It is closed source, JVM-only,
  understands Apex only, and owns a per-workspace index that must not be shared.

So ApexX carries its own symbol model and treats the Salesforce server as an optional
accelerator. The grammar is still not forked: ApexX recognises its own surface, lowers
it, and hands plain Apex to the upstream parser. A fork belongs under
`packages/parser/grammar` once ApexX syntax needs full CST support.

## Position Mapping

Every stage of lowering rewrites text as a set of non-overlapping splices, so each
stage can report which output span came from which input span. `packages/transpiler/src/sourceMap.ts`
records those spans and chains the six stage maps -- tuple lowering, the main
transformation pass, the `Func` type rewrite, generated-type insertion, trailing
whitespace trimming, and the header -- into one exact offset mapping, exposed as
`TranspileResult.sourceMap`.

Verified across the checked-in sources: 25834 generated characters are reported
verbatim and all 25834 map to the identical authored character.

An offset inside a rewritten span maps to the span, because the span as a whole was
replaced. `mapIdentifierOffset` narrows that to a token by locating the authored
identifier inside the generated replacement, which is what lets a position inside a
lowered statement still be addressed.

`TranspileResult.generatedTypeNames` maps a generated interface name back to the ApexX
type it stands for, so a message can say `Func<Account, Boolean>` rather than
`ApexXFuncs.ApexXFunc_8420216b86a6`. Those names are signature hashes and cannot be
inverted by computation, so the table is emitted by the compiler that created them.

## Language Service

`packages/language-server` is a symbol service over `.clsx`, not just diagnostics:

- `apexModel.ts` projects `.clsx` onto plain Apex by replacing each ApexX-only
  construct with padding of exactly the same width, never touching newlines, so the
  parse tree addresses the original file. It then walks the tree for declarations,
  merges in declarations that exist only in ApexX syntax, and resolves identifiers by
  innermost scope. Across the checked-in sources this takes the Apex parse from 62
  syntax errors to 0, with none of the 359 declarations mispositioned.
- `workspaceIndex.ts` keeps a parsed model of every `.clsx` in the workspace, with open
  documents taking precedence over disk, so cross-file resolution sees unsaved edits.
- `jorjeClient.ts` and `apexBridge.ts` are the optional Apex-server path: the bridge
  transpiles in memory, maps positions both ways through the source map, and rewrites
  generated names; the client owns the JVM process and degrades quietly.

### Why the Apex server is opt-in

The Apex language server keeps a persistent index at `.sfdx/tools/<version>/apex.db`
for the workspace it runs in, and does not lock it. The Salesforce Apex extension
already runs one per open workspace, so a second server on the same project means two
writers on one database. That corrupts it, and a corrupt index stops the Salesforce
Apex extension from starting at all -- a failure outside this project's blast radius.

`apexx.useApexLanguageServer` therefore defaults to off, and the client additionally
refuses to start when it finds an existing `apex.db` in the workspace, regardless of
the setting. Making it safe to enable by default means giving ApexX's server an
isolated shadow project with its own index, which is the outstanding work.

## Packages

- `@apexx/ast`: shared AST and diagnostic types for ApexX additions
- `@apexx/semantics`: small semantic helpers, currently `List<T>` receiver discovery and generated-name allocation
- `@apexx/parser`: upstream Apex parser wrapper plus ApexX lambda/list-method discovery
- `@apexx/transpiler`: lowers `.clsx` source into `.cls` source, and emits the position
  map and generated-name table that let editors report generated code as authored code
- `@apexx/sfdx`: Salesforce DX layout detection and `.cls-meta.xml` generation
- `@apexx/cli`: command-line build and parse entry point
- `@apexx/language-server`: symbol service for `.clsx` -- hover, definition,
  references, rename, outline, signature help, workspace symbols, completion and
  diagnostics, with an optional Apex-language-server path
- `apexx-vscode-extension`: local VS Code extension shell for `.clsx`

## v0.1 Lambda Shape

Supported:

```apex
accounts.filter(a => a.Rating == 'Hot')
    .filter(a => a.AccountNumber != null)
```

Typed maps:

```apex
List<String> names = accounts.map(a => a.Name);
```

Filter/map chains:

```apex
return accounts.filter(a => a.Rating == 'Hot')
    .map(a => a.Name);
```

Scalar and flattening helpers:

```apex
Boolean hasHot = accounts.any(a => a.Rating == 'Hot');
Integer hotCount = accounts.count(a => a.Rating == 'Hot');
Account firstHot = accounts.find(a => a.Rating == 'Hot');
List<Contact> contacts = accounts.flatMap(a => a.Contacts);
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

The receiver must currently begin as a simple variable whose type is discoverable as `List<T>` in the same file. `filter` preserves `List<T>`, `map` transforms to `List<R>`, `flatMap` expects a lambda returning `List<R>` and also produces `List<R>`, and scalar helpers such as `any`, `all`, `count`, and `find` terminate the chain.

`map` transforms `List<T>` into `List<R>`. ApexX infers `R` from the lambda body when the expression is in the supported semantic subset: local identifiers, literals, sObject fields, equality/comparison/logical expressions, common primitive methods, and static calls such as `String.valueOf(...)`. An assignment target or enclosing method return type is still used as context and as a result-type sanity check.

Source-level function values are supported for local assignments:

```apex
Func<int, int, bool> testForEquality = (x, y) => x == y;
return testForEquality(left, right);
```

The last `Func` type argument is the return type. Earlier type arguments are lambda parameter types. For deployable Apex, the transpiler emits a generated inner interface per `Func` signature plus generated inner classes with `invoke(...)` methods. Direct source calls such as `testForEquality(left, right)` are lowered to `testForEquality.invoke(left, right)`. `Func` values can be passed as method parameters and assigned from lambdas after declaration.

## Method Sugar

Trailing default method arguments are lowered into ordinary Apex overloads. Required parameters after optional parameters are rejected because ApexX would otherwise need a named-argument call model to disambiguate safe overload generation.

```apex
public static String label(String value, String prefix = 'Info') {
    return prefix + ': ' + value;
}
```

becomes:

```apex
public static String label(String value) {
    return label(value, 'Info');
}

public static String label(String value, String prefix) {
    return prefix + ': ' + value;
}
```

Custom method decorators are compile-time annotations backed by user classes. ApexX resolves an unknown method annotation as a decorator only when a class with the same name implements `ApexX.Decorator`.

```apex
@UserFriendlyError(message = 'Unable to save account.')
public static Account save(Account account) {
    update account;
    return account;
}
```

The generated public method calls `new UserFriendlyError().handle(ctx, next)`. The original body is moved to a private method, and a generated `ApexX.Next` class calls that body. Decorator arguments are passed through `ctx.config` as `Map<String, Object>`.

For v0.1, decorators are intentionally limited to static methods. This covers common LWC/Aura service methods while leaving instance-method `this` capture as a later design step.

When decorators are used, the CLI and VS Code extension also emit `ApexX.cls`, which contains:

```apex
public class ApexX {
    public class Invocation { ... }
    public interface Next { Object call(); }
    public interface Decorator { Object handle(Invocation ctx, Next next); }
}
```

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

The current implementation supports local assignments, reassignment from lambdas, direct calls, and method parameters for `Func` values. `map` also supports block lambdas for short multi-statement projections.

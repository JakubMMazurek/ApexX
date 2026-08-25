# ApexX Architecture

## Goals

ApexX should feel like Apex with carefully chosen modern additions, not like a separate runtime. The compiler accepts `.clsx` files and emits deployable `.cls` files, and `.apexx` files which it emits as anonymous blocks.

The v0.1 compatibility rule is simple: if a `.clsx` file contains ordinary Apex, the generated `.cls` should remain ordinary Apex plus a generated header. The same holds for a script: ordinary anonymous Apex in a `.apexx` file passes through unchanged.

## Upstream Strategy

`@apexdevtools/apex-parser` is the parser dependency: an ANTLR Apex grammar with
TypeScript APIs such as `ApexParserFactory`. It is syntax only -- a parse tree, with no
symbol table and no type resolution. ApexX uses it twice: to validate generated Apex,
and to build the symbol model from an offset-preserving projection of the authored
source. Both uses pick the grammar's entry rule from the unit being compiled --
`compilationUnit` for a class, `anonymousUnit` for a script.

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
records those spans and chains the seven stage maps -- tuple lowering, the main
transformation pass, the `Func` type rewrite, generated-type insertion, method lowering,
trailing whitespace trimming, and the header -- into one exact offset mapping, exposed as
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

## Diagnostics

A diagnostic carries offsets into whatever text produced it, and stages add and remove
lines, so a range is only meaningful together with the stage it came from. The compiler
keeps each batch in its own coordinate space -- tuple lowering reports against the
authored source, the parse and chain checks against the tuple-lowered text, method
lowering against the text three stages further on, and the final Apex parse against the
generated `.cls` -- then maps every range back to the authored source through the
matching slice of stage maps before returning it. `spanToSource` maps a span rather
than an offset, because an offset inside a rewritten span collapses to the start of
that span and would leave the range empty. Reported ranges are also pulled in off
surrounding whitespace: a statement span starts at column zero because the lowering
splices the indentation with the statement, which is not where a squiggle belongs.

An error in the ApexX front end leaves that construct un-lowered, so the Apex parse
then fails on syntax nobody wrote. Those cascade errors are suppressed while a
front-end error stands.

A file is syntactically broken for as long as it takes to type a statement, so the
syntax error reporting it has to stay readable. The generated parser messages quote the
offending input with its line breaks escaped and then enumerate every token the grammar
would have accepted, which at a statement position runs past two thousand characters of
keywords; error recovery adds its own follow-on errors on top. Only the first error of a
parse is reported, its message is rewritten to what was unexpected plus at most a short
list of alternatives, and a quotation spanning lines is dropped rather than read back to
its author. The listener also computes a real offset from the line and column the parser
reports, because a diagnostic about generated Apex is mapped back to the authored source
by offset -- a fixed offset of zero put every syntax error on line 1.

### Compatibility checks

Lowering hides the type a construct really has behind a generated class, so a mismatch
that is not caught here surfaces as a platform compiler error naming
`ApexXTuple_935886cf7d05` or `ApexXFunc_8420216b86a6` instead of the types in the
source. Checked before lowering:

- a `Func` lambda body against the return type its declaration promises, at each
  `return` in a block lambda
- tuple return values and `Map` tuple values against the tuple contract (`APXX2412`)
- tuple destructuring against what the called method actually returns, in arity
  (`APXX2413`) and element types (`APXX2414`)

The README carries the full table of coded diagnostics. A code is a field on
`ApexXDiagnostic`, not a prefix on its message, so `toLspDiagnostic` can hand the editor
a real `code` plus a `codeDescription` link -- the same shape the Apex language server's
own diagnostics arrive in -- and a test can assert identity instead of prose. Only the
constructs in the table carry one; inferred mismatches are reported by message alone.

Both rest on `inferExpressionType`, where operator precedence decides the answer. The
conditional operator binds loosest of all, so it is resolved before any other: a
ternary's condition almost always contains a comparison, and reading that comparison as
the whole expression types `cond ? 0 : revenue` as `Boolean`. Branches that disagree on
anything but numeric width leave the type unknown.

Two notions of assignability exist deliberately. `isAssignableType` demands an exact
match and is used where the expected type was itself inferred from a list chain.
`isCompatibleApexType` allows what the Apex compiler allows -- numeric widening,
`Id` against `String` -- and is used where the expected type is declared in the source,
because reporting a legal conversion would be a false positive. Both treat an
uninferable type as compatible: staying quiet beats guessing.

## Syntax Highlighting

ApexX is a superset of Apex, so its grammar is not written -- it is derived. The
Salesforce Apex grammar is vendored at `packages/vscode-extension/grammars`, and
`scripts/build-grammar.mjs` retargets it at `source.apexx` and splices the ApexX-only
constructs in from `syntaxes/apexx-additions.json`. Every Apex rule survives that
derivation, so SOQL, DML, annotations, javadoc and string escapes are coloured by the
rules that already know how, with the scopes they already use.

That replaced a hand-written grammar which listed a few dozen ApexX patterns and fell
back to `include: source.apex`. The include was the hazard: an ApexX rule that matched
first replaced a precise Apex scope with a coarse one, and an Apex block rule that
consumed a region first coloured the ApexX constructs inside it. Measured token for
token against Apex, that grammar agreed on 36% of an ordinary class -- SOQL bodies were
not highlighted at all, and an unterminated string literal swallowed the rest of a line.
The derived grammar agrees on 100%, which is what `npm run grammar` pins.

Inner scope names keep their `.apex` suffix deliberately. Themes colour
`keyword.type.apex` and its neighbours by name, so leaving them untouched is exactly
what makes the two languages look identical; only genuinely new tokens -- the lambda
arrow, `Func`, tuple punctuation, the collection helpers -- carry `.apexx`.

The ApexX rules are spliced in ahead of the Apex rules that would otherwise claim the
same text: a lambda's `(` before a parenthesised expression, a collection helper before
an ordinary invocation, a tuple type before a type argument. A block-bodied lambda
carries its own body, because a `{` reached from an Apex expression is an array
initialiser and a `return` inside one would not be a keyword.

Nothing is injected into `source.apex` any more. An earlier injection added the arrow
and the collection helpers to plain `.cls` files, which coloured any variable named
`count` or `map` as an ApexX built-in and relabelled Apex's own map-literal `=>`.

### The language configuration is Apex's, byte for byte

Colouring is only half of how an editor reads a file. `language-configuration.json`
decides where a word ends, when to indent, what auto-closes and how folding markers
work, and ApexX's copy is now identical to the Salesforce Apex extension's -- an ApexX
file is an Apex file with more in it, so it should behave like one. `smoke-test.mjs`
compares the two key by key whenever that extension is installed.

That file is easy to get wrong in a way nothing reports. Its `wordPattern` had an
unescaped `]` inside a negated character class, which closed the class early and left a
pattern matching no identifier at all. `getWordAtPosition` then returns null for every
word, and the editor skips auto-triggered suggestions entirely when it does -- so
completion appeared dead while trigger characters kept working. The behavioural half of
that check is unconditional: the pattern has to match whole identifiers and stop at the
characters that end a word.

Two consequences worth knowing. A rule anchored on a keyword -- `class X`, `new X`,
`implements X` -- has to be tried before the keyword rule, or the keyword is consumed
and the name after it never matches; built-in types are kept out of the shape-based
type rules by a negative lookahead instead. And a rule competing with an Apex rule has
to begin at the same character: the Apex method-call rule starts at the `.`, so
recognising a collection helper means matching `.filter`, not `filter`.

## Language Service

`packages/language-server` is a symbol service over ApexX, not just diagnostics:

- `apexModel.ts` projects ApexX onto plain Apex by replacing each ApexX-only
  construct with padding of exactly the same width, never touching newlines, so the
  parse tree addresses the original file. It then walks the tree for declarations,
  merges in declarations that exist only in ApexX syntax, and resolves identifiers by
  innermost scope. Across the checked-in sources this takes the Apex parse from 62
  syntax errors to 0, with none of the 359 declarations mispositioned.
`buildDocumentModel` parses a script with `anonymousUnit` instead of
`compilationUnit`, so the same `DeclarationListener` collects a block's own
declarations and every feature built on the symbol model works there. Completion
is inferred from the source text and never needed the class shape at all. Two
things stay class-only: the workspace index, so a rename started in a `.clsx`
does not reach usages inside scripts, and `askApex`, because the bridge projects a
document onto a `.cls` named after its class.

Completion answers several different questions, each from the source that can actually
answer it.

Where an **identifier** is expected the offer is assembled nearest-first: locals and
parameters in scope, the enclosing type's own members, types declared in the file, types
declared elsewhere in the workspace, the Apex runtime's types and namespaces, the
sObjects the cached schema describes, then the keywords. A member of a **value** comes
from the symbol model -- locals, lambda parameters typed from their receiver list, and
the sObject schema -- and `this` resolves to the enclosing type.

A member of a **type used statically** comes from the Apex standard library itself; see
[Reading the Apex standard library](#reading-the-apex-standard-library).

A **query literal** is its own language, so the caret's clause decides the offer:
fields of the queried object in `SELECT`, `WHERE`, `ORDER BY` and `GROUP BY`; sObject
names after `FROM`; the aggregate functions, date literals and clause keywords where
each is legal; and after `:` the Apex values in scope, because a bind variable steps
back out of the query. A relationship is walked through the schema. Until `FROM` is
typed the object comes from what the query is assigned to. `soql.ts` recognises the
query by what precedes the bracket rather than by what follows it, which is how
`rows[0]` stays an index expression while the query is still empty.

An **annotation** is none of these: after `@` the offer is the workspace's decorator
classes plus the native Apex annotations, and inside a decorator's argument list it is
the keys that decorator reads out of `ctx.config`. A decorator takes an untyped
`Map<String, Object>`, so there is no signature to read; the keys it reads are what it
actually accepts, which keeps the offer honest as the decorator changes.

Two positions accept only one kind of name and are answered accordingly: after
`implements` or `extends`, the workspace's interfaces and classes plus the platform
interfaces a class is usually declared against; inside `new Account(`, that sObject's
fields.

Every item carries the range of the identifier being typed. Without one the editor has
nothing to match the typed word against, so it stops filtering and offers the whole
list -- which is how `Sys` came to show items with no `s` in them. An identifier answer
that consulted the standard library is also reported incomplete, so the editor asks
again as the prefix grows rather than filtering a list it believes is complete.

### Reading the Apex standard library

The Salesforce Apex extension ships `StandardApexLibrary.zip`: 2365 Apex stub classes,
one per standard type, carrying real signatures and Salesforce's own doc comments. It is
what the Apex language server resolves against, so `standardLibrary.ts` reads the same
archive rather than approximating it. Nothing is vendored and nothing is downloaded --
the copy on disk is read where it lies, and every entry point returns `undefined` when
the extension is absent, which leaves ApexX on its own curated table of the common
types. `apexx.standardApexLibrary` turns it off outright.

The archive is read with a small central-directory reader over `zlib.inflateRawSync`,
which keeps the language server dependency-free and identical on every platform where
shelling out to `unzip` would not be. Type names come from the entry paths alone, so the
index costs no decompression; a type's members are parsed on first use and cached. The
stubs are parsed with the same Apex parser the compiler uses, so a signature offered
here is a signature the compiler would accept. Parsing the whole library takes under a
second.

Two properties of the data shape the code. Apex blurs namespace and class -- `Messaging`
both contains `SingleEmailMessage` and declares `sendEmail`, which the stub marks as an
instance method although everyone writes `Messaging.sendEmail(...)` -- so a
namespace-class receiver offers its statics, its instance methods and the types the
namespace contains, rather than one reading of the three. And a handful of standard
methods are named after DML keywords: `global static Database.SaveResult insert(...)`
parses as a DML statement rather than a declaration, which loses the method and leaks
its parameters out as class-level fields. Renaming just the declared name before parsing
is what makes `Database.insert` through `Database.merge` resolvable at all.

Completion collapses overloads to one entry per name, the way TypeScript's does; ten
identical `insert` labels help nobody choose. Signature help is where the overloads
belong, and is the one place all of them are returned.

### Signature help, folding and implementations

Signature help resolves nearest-first as well: the file being edited, then the workspace
index, then the standard library. The receiver is what makes a qualified call
answerable, so `enclosingCall` reports it alongside the method name, and reports whether
the call was preceded by `new` -- which decides that the name is a type and constructors
are what is being called.

Folding is structural rather than indentation-based, which is what the editor falls back
to when nothing answers: braces are counted over source with comments and strings masked
out, so a `}` inside a string closes nothing, and comments and `// #region` pairs fold
too. Comments are scanned out of the source directly rather than diffed against the
masked form -- the mask replaces a comment with spaces, and a comment's own indentation
is already spaces, so the two are identical exactly where the comment continues.

Go to implementation is the other direction from go to definition: on a type name, the
workspace types whose declaration names it after `implements` or `extends`; on one of its
members, that member on each of them. An interface's methods are a separate rule in the
Apex grammar from a class's, so the model needs its own hook for them -- without it an
interface declares nothing that an outline, a hover, a rename, member completion or this
could see.

- `workspaceIndex.ts` keeps a parsed model of every `.clsx` in the workspace, with open
  documents taking precedence over disk, so cross-file resolution sees unsaved edits.
- `standardLibrary.ts` reads the Apex standard library out of the Salesforce Apex
  extension's archive, and `apexGlobals.ts` is the fallback table for a machine without
  it. `soql.ts` answers inside a query literal.
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
- `@apexx/transpiler`: lowers `.clsx` source into `.cls` source and `.apexx` source into
  an anonymous block, and emits the position map and generated-name table that let
  editors report generated code as authored code
- `@apexx/sfdx`: Salesforce DX layout detection, `.cls-meta.xml` generation, and the
  `scripts/apex` output location for generated blocks
- `@apexx/cli`: command-line build and parse entry point
- `@apexx/language-server`: symbol service for `.clsx` and `.apexx` -- hover,
  definition, implementation, references, rename, outline, folding, signature help,
  workspace symbols, quick fixes, completion and diagnostics, with the Apex standard
  library read from the Salesforce Apex extension and an optional
  Apex-language-server path
- `apexx-vscode-extension`: local VS Code extension shell for `.clsx` and `.apexx`,
  including compile-on-save and Execute for scripts

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

Nested inside a larger expression:

```apex
System.debug(accounts.filter(a => a.Rating == 'Hot'));
Integer hot = accounts.filter(a => a.Rating == 'Hot').size();
```

A chain lowers to a `for` loop, and a loop is a statement, so a nested one is *hoisted*:
the loop is emitted before the statement and the chain is replaced by the name holding
its result.

```apex
List<Account> apexxFilter0 = new List<Account>();
for (Account a : accounts) {
    if (a.Rating == 'Hot') {
        apexxFilter0.add(a);
    }
}
System.debug(apexxFilter0);
```

The shapes that are still refused, and what each would take, are catalogued in
[limitations.md](limitations.md).

Hoisting moves the work earlier, so it is refused where that would change whether or
when the chain runs, each with its own diagnostic: after `&&` or `||` or in a ternary
arm, where the chain might never have run; in the header of an `if`, `for`, `while` or
`switch`, where there is no statement above to hoist to; and where one statement holds
two chains, since each rewrite claims the whole statement. In all three the fix is to
assign the chain to a local first.

A single lambda parameter may be written with or without parentheses -- `a => ...` and
`(a) => ...` are the same lambda, as in JavaScript, and lower to identical Apex. Two or
more parameters need the parentheses.

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

Scripts follow the same convention with the conventional anonymous-Apex location:

```text
apexx/scripts/ScriptName.apexx  ->  scripts/apex/ScriptName.apex
```

An anonymous block is not metadata, so no `-meta.xml` is written. `scripts/apex` is
where the Salesforce Apex extension offers Execute and Debug, so the generated file
gets those actions for free, and the ApexX extension adds an Execute code lens on the
authored `.apexx` that compiles first and then delegates to the same command.

## Unit Modes

`TranspileOptions.mode` selects the kind of Apex the pipeline targets, and one
platform rule drives every difference between them: a class an anonymous block
declares is an *inner* type, and Apex rejects an inner type that has inner types.

| | `class` | `anonymous` |
| --- | --- | --- |
| Output | `.cls` compilation unit | `.apex` block |
| Validated against | `compilationUnit` | `anonymousUnit` |
| Structural type names | `ApexXFuncs.ApexXFunc_<hash>` | `ApexXFunc_<hash>`, or the registry name with `structuralTypes: "deployed"` |
| Where those types live | deployed registry classes | declared in the block, or deployed |
| Lambda implementations | injected into the class body | declared at block level |
| Decorators | lowered | reported (`APXX2620`, `APXX2621`) |
| Language service | full symbol service, indexed | full symbol service, not indexed |

The names are content-addressed either way, so a signature keeps its name across
builds and across modes -- only the qualifier differs. `SharedTypeNaming` in
`sharedTypes.ts` is the single place that decides it.

Because the qualifier is part of the Apex type, a structural value cannot cross
between the two namings: assigning a deployed `ApexXTuples.ApexXTuple_<hash>` to a
flat `ApexXTuple_<hash>` is rejected by the platform even though the signature is
identical. `TranspileOptions.structuralTypes` therefore selects, per script,
whether its structural types are `inline` (self-contained, the default) or
`deployed` (registry members, required for interop with a deployed ApexX class),
and `checkStructuralTypeBoundaries` reports the mismatch as `APXX2630` at compile
time rather than letting the platform report it.

A method declared at the top level of a block has no enclosing class. That is a legal
shape only in a script, so `findApexXMethods` keeps such methods only in anonymous
mode; trailing default arguments lower to sibling overloads there as usual, while a
decorator, which is dispatched through the class that holds the method, is reported.

## Future Surface

The next major design thread is making source-level generic function types first-class across method parameters, fields, and list APIs:

```apex
Func<Integer, Integer, Boolean> testForEquality = (x, y) => x == y;
```

The current implementation supports local assignments, reassignment from lambdas, direct calls, and method parameters for `Func` values. `map` also supports block lambdas for short multi-statement projections.

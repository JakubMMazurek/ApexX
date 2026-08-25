# Known limitations

What ApexX does not handle yet, why, and what fixing each would involve. Every entry
here is reproducible today; anything that turns out to be wrong should be deleted rather
than left standing.

Entries are grouped by how much they cost the person writing ApexX, not by how hard they
are to fix.

## Blocks real work

### One nested `List<T>` chain per statement

```apex
System.debug(accounts.map(a => a.Name) + accounts.map(a => a.Id));
```

A nested chain is hoisted: its loop is emitted above the statement and the chain is
replaced by the temp holding the result. That rewrite claims the whole statement, and the
transformation model splices a span once, so a second chain in the same statement has
nowhere to put its own rewrite. Both are refused with a diagnostic rather than one
silently overwriting the other.

**To fix:** group candidates by statement in `collectEmbeddedListMethodCalls`, then emit
one call carrying every chain in that statement, with the substitutions applied
right-to-left so the earlier offsets stay valid. The lowering already emits all the loops
for a multi-step chain, so the shape exists.

### A chain after `&&`, `||`, or in a ternary arm

```apex
if (flag && accounts.any(a => a.Name != null)) { }
Integer n = flag ? accounts.map(a => a.Name).size() : 0;
```

Hoisting moves the loop above the statement, so a chain that the source only reaches
conditionally would run every time. That is a behaviour change, not a formatting one, so
it is refused.

**To fix properly:** lower the chain to a `Func`-style call the enclosing expression can
hold, rather than to a loop -- see *Chains lower to loops, not values* below. Hoisting
cannot be made correct here.

### A chain in a control-statement header

```apex
for (Account a : accounts.filter(x => x.Name != null)) { }
```

There is no statement above a header to hoist to, and for a loop header, hoisting would
also change how often the chain is evaluated.

**To fix:** for `if` and `switch`, emit the loop before the whole statement. For `for`
and `while` headers the same objection as the conditional case applies.

### Chains lower to loops, not values

This is the root cause of the three entries above. `filter`/`map`/... become an
imperative `for` loop, which is a statement, so a chain can only exist where a statement
can be placed. `Func` values already lower the other way -- to an inner class
implementing a generated interface -- which is expression-level and composes anywhere.

**To fix:** add a second lowering that emits `ApexXFuncs.filter(list, new ApexXLambda0())`
and use it wherever the statement form cannot be placed. The cost is an allocation per
lambda and a virtual `invoke()` per element, which is why the loop form is the default;
the two would need to coexist rather than one replacing the other.

### A lambda cannot appear directly in a `return`

```apex
public static Func<Account, Boolean> both(
    Func<Account, Boolean> left,
    Func<Account, Boolean> right
) {
    return (account) => left(account) && right(account);   // refused
}
```

```apex
    Func<Account, Boolean> combined = (account) => left(account) && right(account);
    return combined;                                       // works
```

Lambdas are recognised in a `Func` assignment and as an argument to an ApexX `List<T>`
method, and nowhere else, so a lambda in a `return` is reported as an unsupported lambda
form. The restriction is syntactic rather than semantic: assigning it to a local first
compiles, so higher-order methods, closures over runtime values and predicate
composition all work today -- they just cost one named local each.

**To fix:** treat a `return` whose expression is a lambda as an assignment to a
synthesised local followed by `return <local>`, which is the shape the lowering already
emits. The same argument applies to a lambda passed as an argument to an ordinary
method.

### The receiver must be a simple local

```apex
wrapper.accounts.filter(a => a.Name != null);   // not recognised
getAccounts().filter(a => a.Name != null);      // not recognised
```

The element type is resolved by looking the receiver up as a `List<T>` variable declared
in the same file, so only a bare identifier works. Both cases are reported as a receiver
problem rather than as a nesting one.

**To fix:** resolve the receiver's type through the semantic model instead of the
declared-variable table. The language server already infers receiver types for
completion, so the inference exists but is not shared with the transpiler.

## Produces worse output than it should

### `splitCommaList` is implemented six times, three of them wrongly

`packages/parser`, `packages/semantics`, `packages/transpiler/index.ts`,
`packages/transpiler/sharedTypes.ts`, `packages/transpiler/tuples.ts` and
`packages/language-server` each define their own. They disagree:

| Copy | Tracks |
| --- | --- |
| `transpiler/tuples.ts` | `<>`, `()`, `{}`, `[]`, strings |
| `transpiler/index.ts` | `<>`, `()`, `{}`, strings |
| `parser` | `<>` only (enough for its one caller, a type argument list) |
| `transpiler/sharedTypes.ts` | `<>` only, no strings |
| `semantics` | `()` only -- **`Map<Id, String>` splits into two** |
| `language-server` | nothing -- plain `.split(",")` |

**To fix:** one implementation, but not a single function. A comma list of *types* must
treat `<` as nesting; a comma list of *value expressions* must not, because `f(a < b, c)`
is a comparison. That needs `splitTypeList` and `splitArgumentList` as separate exports
from a shared package, and each of the ~20 call sites assigned to the right one. Doing it
with one angle-aware function would break SOQL and argument splitting.

### A tuple in a `Func` parameter position exposes the carrier

```apex
Func<(Integer, Integer), Integer> total = t => t.item0 + t.item1;
```

This compiles, but `item0` is a generated field name. The return position does not have
the problem -- there the author writes a tuple literal and reads it back through a
destructuring binding with names they chose -- so the two positions are not equally
finished, and only the return position is worth demonstrating.

**To fix:** allow a destructuring binding in a lambda parameter list, `((Integer a,
Integer b)) => a + b`, lowered by reading the carrier's fields into the named locals at
the top of `invoke`. The tuple destructuring pass already emits exactly that shape for a
statement.

### A hoisted loop after an inline `{` is indented oddly

```apex
for (Account x : accounts) { System.debug(accounts.map(a => a.Name)); }
```

The generated loop is indented to the enclosing line, but its first line still follows
the `{` on that line. The Apex is valid and parses; it just reads badly.

**To fix:** emit a newline before the hoisted block when the statement does not start its
own line.

### Generated generics lose the space after a comma

`Func<Map<Id, String>, Boolean>` generates `invoke(Map<Id,String> m)`. Valid Apex,
inconsistent with the formatting everywhere else in the generated file.

**To fix:** normalise type text to `, ` when rendering rather than stripping whitespace.

## Editor

### The Apex grammar is vendored, not tracked

`packages/vscode-extension/grammars/apex.tmLanguage.json` is a copy of the Salesforce
extension's grammar. Nothing notices when Salesforce ships a new one.

**To fix:** have the smoke test compare the vendored copy against the installed
extension's, when that extension is present, and report a difference rather than failing.
Re-vendoring is already documented in `grammars/README.md`.

### `apexx.useApexLanguageServer` cannot be on by default

Two Apex language servers on one workspace share `.sfdx/tools/apex.db` and corrupt it, so
ApexX's own symbol model is the default and the Salesforce server is opt-in.

**To fix:** requires either a private index location for the second server or an
inter-process lock; neither is exposed by the Salesforce extension today.

## Fixed, kept here as regression notes

These were limitations and are not any more. Each has a test named in
`scripts/smoke-test.mjs`; the note is here so the reason survives.

- **Parentheses around a single lambda parameter.** `a =>` was required by `List<T>`
  methods and rejected by `Func` assignments; `(a) =>` was the reverse. Both forms now
  work everywhere and lower to identical Apex.
- **Block lambda bodies on one line.** The body was matched by a regex anchoring the
  closing brace at the start of a line, so `a => { return x; };` was not a lambda. Bodies
  are now found by matching braces.
- **Nested generics in a `Func` type.** `Func<List<Account>, Integer>` was read as
  `Func<List<Account` and generated a corrupt class declaration.
- **A tuple as a `Func` type argument.** `Func<Integer, (Integer, Integer)>` failed three
  ways at once. The parser's type-argument split counted only angle brackets, so it read
  the tuple return as two arguments and reported `Func expects 2 lambda parameter(s), but
  got 1` -- sending the author to fix a lambda that was correct. Nothing resolved a tuple
  inside a type argument to its generated carrier, so lowering emitted an interface whose
  `invoke` returned `(Integer, Integer)`. And the alias scan covers the authored source as
  well as the lowered one, so the pre-lowering form was registered too. The structural
  types now compose both ways: a tuple could always hold a `Func`, and a `Func` can now
  return or accept one, with the lambda body building the carrier and a destructuring
  binding resolving through the call.
- **A nested chain broken across lines.** The embedded pass matched the receiver only
  where its identifier ended exactly at the dot, so `numbers` on its own line followed by
  `.filter(...)` was read as an unresolvable receiver -- and reported as one, which was
  doubly misleading because `numbers` was a local all along. The line breaks the chain
  occupied are also closed up now, so the rebuilt statement does not keep them.
- **A chain followed by another call.** `list.filter(...).size()` had its `.size()`
  spliced away by the assignment pass, then reported a bogus type mismatch.
- **Syntax highlighting diverging from Apex.** The grammar is now derived from the
  Salesforce one and pinned at 100% scope fidelity by `npm run grammar`.

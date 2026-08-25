# Vendored Apex grammar

`apex.tmLanguage.json` is the TextMate grammar the Salesforce Apex extension ships,
converted from its plist form to JSON. It is the base ApexX highlighting is derived
from: `scripts/build-grammar.mjs` reads it, retargets it at `source.apexx`, and layers
the ApexX-only constructs (lambdas, `Func<>`, tuples, collection helpers) on top. That
is what makes a `.clsx` file colour like a `.cls` file rather than approximate it.

The grammar is vendored rather than read from the installed extension so that ApexX
highlights the same way whether or not that extension is present.

## Re-vendoring

Point at the installed extension and convert:

    plutil -convert json \
      -o packages/vscode-extension/grammars/apex.tmLanguage.json \
      ~/.vscode/extensions/salesforce.salesforcedx-vscode-apex-<version>/grammars/apex.tmLanguage
    node scripts/build-grammar.mjs

`scripts/grammar-test.mjs` then reports the scope fidelity against the Apex grammar,
which is what says whether the new base still lines up.

## Licence

Copyright (c) 2017, Salesforce.com, inc. Redistributed under the BSD 3-Clause licence
in `LICENSE.apex.txt`, from https://github.com/forcedotcom/salesforcedx-vscode.

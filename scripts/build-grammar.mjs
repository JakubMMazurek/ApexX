#!/usr/bin/env node
/**
 * Builds the ApexX TextMate grammar from the Apex one.
 *
 * ApexX is a superset of Apex, so its highlighting is derived rather than written:
 * the vendored Salesforce grammar in packages/vscode-extension/grammars supplies every
 * rule Apex already has -- SOQL, DML, annotations, javadoc, triggers -- and this script
 * retargets it at `source.apexx` and splices in the ApexX-only constructs from
 * apexx-additions.json. Hand-written rules over `include: source.apex` were the previous
 * approach, and they lost: an ApexX rule that matched first replaced a precise Apex scope
 * with a coarse one, which is what made a .clsx file look nothing like a .cls file.
 *
 * Inner scope names keep their `.apex` suffix on purpose. Themes colour `keyword.type.apex`
 * and friends by name, so leaving them alone is what makes the two languages look identical;
 * only genuinely new tokens carry `.apexx`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "packages", "vscode-extension");
const basePath = path.join(extension, "grammars", "apex.tmLanguage.json");
const additionsPath = path.join(extension, "syntaxes", "apexx-additions.json");
const outputPath = path.join(extension, "syntaxes", "apexx.tmLanguage.json");

const base = readJson(basePath);
const additions = readJson(additionsPath);
const grammar = structuredClone(base);

grammar.name = "ApexX";
grammar.scopeName = "source.apexx";
grammar.fileTypes = ["clsx", "apexx"];

// Comment keys carry the reasoning in the additions file; they are not rules.
for (const [name, rule] of Object.entries(additions.repository)) {
    if (name.startsWith("//")) {
        continue;
    }

    if (grammar.repository[name]) {
        fail(`Addition '${name}' would overwrite a rule the Apex grammar already defines.`);
    }

    grammar.repository[name] = rule;
}

for (const { rule, before, includes } of additions.inject) {
    const target = grammar.repository[rule];

    if (!target?.patterns) {
        fail(`Cannot inject into '${rule}': the Apex grammar has no such rule with patterns.`);
    }

    const at = target.patterns.findIndex(pattern => pattern.include === before);

    if (at < 0) {
        fail(`Cannot inject into '${rule}': it does not include '${before}' to sit before.`);
    }

    target.patterns.splice(at, 0, ...includes.map(include => ({ include })));
}

fs.writeFileSync(outputPath, `${JSON.stringify(grammar, null, 2)}\n`);

const added = Object.keys(additions.repository).filter(name => !name.startsWith("//"));
console.log(`Built ${path.relative(root, outputPath)}`);
console.log(`  ${Object.keys(base.repository).length} rules from the Apex grammar`);
console.log(`  ${added.length} ApexX rules: ${added.join(", ")}`);

function readJson(file) {
    if (!fs.existsSync(file)) {
        fail(`Missing ${path.relative(root, file)}.`);
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

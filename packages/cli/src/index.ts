#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  mergeGeneratedSupportClasses,
  transpileApexX,
} from "@apexx/transpiler";
import type {
  ApexXDiagnostic,
  ApexXStructuralTypes,
  GeneratedApexSupportClass,
} from "@apexx/ast";
import {
  inferApexClassName,
  inferApexScriptName,
  resolveBuildTarget,
  resolveScriptTarget,
  writeApexClassFiles,
  writeApexScriptFile,
} from "@apexx/sfdx";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === "build") {
    await build(args);
    return;
  }

  if (args.command === "parse") {
    await parse(args);
    return;
  }

  printHelp();
  process.exitCode = args.command === "help" || args.command === "" ? 0 : 1;
}

async function build(args: ParsedArgs): Promise<void> {
  const inputs = await resolveBuildInputs(args);
  const explicitOut = args.options.get("out");
  const explicitScriptsOut = args.options.get("scripts-out");
  const explicitApiVersion = args.options.get("api-version");
  const scriptTypes = parseScriptTypes(args.options.get("script-types"));

  if (!scriptTypes) {
    console.error("--script-types accepts inline or deployed.");
    process.exitCode = 1;
    return;
  }

  const buildTarget = await resolveBuildTarget({
    sourcePath: inputs[0],
    workspaceRoot: process.cwd(),
    explicitClassesDir:
      typeof explicitOut === "string" ? explicitOut : undefined,
    explicitApiVersion:
      typeof explicitApiVersion === "string" ? explicitApiVersion : undefined,
  });
  const scriptTarget = await resolveScriptTarget({
    sourcePath: inputs[0],
    workspaceRoot: process.cwd(),
    explicitScriptsDir:
      typeof explicitScriptsOut === "string" ? explicitScriptsOut : undefined,
  });
  const files: string[] = [];
  for (const input of inputs) {
    files.push(...(await collectApexXFiles(input)));
  }
  const sources = [...new Set(files)].sort();

  if (sources.length === 0) {
    console.error(
      `No .clsx or .apexx files found at ${inputs
        .map(input => path.relative(process.cwd(), input) || ".")
        .join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  let hadError = false;
  const generatedSupport: GeneratedApexSupportClass[] = [];

  for (const file of sources) {
    const source = await fs.readFile(file, "utf8");
    const script = isApexXScript(file);
    const result = transpileApexX(source, {
      sourceFileName: path.basename(file),
      workspaceRoot: process.cwd(),
      mode: script ? "anonymous" : "class",
      structuralTypes: scriptTypes,
    });
    const errors = result.diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    );

    printDiagnostics(file, result.diagnostics);

    if (errors.length > 0) {
      hadError = true;
      continue;
    }

    if (script) {
      const written = await writeApexScriptFile({
        scriptsDir: scriptTarget.scriptsDir,
        scriptName: inferApexScriptName(file),
        source: result.output,
      });

      console.log(`Wrote ${path.relative(process.cwd(), written.scriptFile)}`);
      generatedSupport.push(...result.supportClasses);
      continue;
    }

    const className = inferApexClassName(result.output, path.basename(file));
    const written = await writeApexClassFiles({
      classesDir: buildTarget.classesDir,
      className,
      source: result.output,
      apiVersion: buildTarget.apiVersion,
    });

    console.log(`Wrote ${path.relative(process.cwd(), written.classFile)}`);
    console.log(`Wrote ${path.relative(process.cwd(), written.metadataFile)}`);

    generatedSupport.push(...result.supportClasses);
  }

  for (const supportClass of mergeGeneratedSupportClasses(generatedSupport)) {
    const supportWritten = await writeApexClassFiles({
      classesDir: buildTarget.classesDir,
      className: supportClass.className,
      source: supportClass.source,
      apiVersion: buildTarget.apiVersion,
    });
    console.log(`Wrote ${path.relative(process.cwd(), supportWritten.classFile)}`);
    console.log(`Wrote ${path.relative(process.cwd(), supportWritten.metadataFile)}`);
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

async function parse(args: ParsedArgs): Promise<void> {
  const input = args.positional[0];

  if (!input) {
    console.error("parse requires a .clsx or .apexx file.");
    process.exitCode = 1;
    return;
  }

  const file = path.resolve(process.cwd(), input);
  const source = await fs.readFile(file, "utf8");
  const result = transpileApexX(source, {
    sourceFileName: path.basename(file),
    workspaceRoot: process.cwd(),
    mode: isApexXScript(file) ? "anonymous" : "class",
    structuralTypes: parseScriptTypes(args.options.get("script-types")) ?? "inline",
  });
  printDiagnostics(file, result.diagnostics);

  if (result.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
    process.exitCode = 1;
  } else {
    console.log(`Parsed ${path.relative(process.cwd(), file)}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];

      if (next && !next.startsWith("--")) {
        options.set(key, next);
        index += 1;
      } else {
        options.set(key, true);
      }
    } else {
      positional.push(value);
    }
  }

  return { command, positional, options };
}

function parseScriptTypes(
  value: string | true | undefined,
): ApexXStructuralTypes | undefined {
  if (value === undefined) {
    return "inline";
  }

  return value === "inline" || value === "deployed" ? value : undefined;
}

/** `.apexx` is to `.apex` what `.clsx` is to `.cls`: authored source for a unit
 * of that kind, here an anonymous block. */
function isApexXScript(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".apexx");
}

function isApexXSource(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return lowered.endsWith(".clsx") || lowered.endsWith(".apexx");
}

async function collectApexXFiles(input: string): Promise<string[]> {
  if (!(await exists(input))) {
    return [];
  }

  if (!(await statIsDirectory(input))) {
    return isApexXSource(input) ? [input] : [];
  }

  const files: string[] = [];
  const entries = await fs.readdir(input, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(input, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectApexXFiles(fullPath)));
    } else if (entry.isFile() && isApexXSource(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

/**
 * An explicit path wins. Otherwise both conventional source roots are built, so
 * a project holding classes and scripts needs one command.
 */
async function resolveBuildInputs(args: ParsedArgs): Promise<string[]> {
  const explicit = args.positional[0];

  if (explicit) {
    return [path.resolve(process.cwd(), explicit)];
  }

  const candidates = [
    path.join(process.cwd(), "apexx", "classes"),
    path.join(process.cwd(), "apexx", "scripts"),
  ];
  const present: string[] = [];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      present.push(candidate);
    }
  }

  return present.length > 0 ? present : [path.resolve(process.cwd(), "src")];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statIsDirectory(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath);
  return stat.isDirectory();
}

function printDiagnostics(file: string, diagnostics: ApexXDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const position = diagnostic.range
      ? `${diagnostic.range.start.line}:${diagnostic.range.start.column + 1}`
      : "?:?";
    console.error(
      `${path.relative(process.cwd(), file)}:${position} ${diagnostic.severity}: ${
        diagnostic.code ? `${diagnostic.code}: ` : ""
      }${diagnostic.message}`,
    );
  }
}

function printHelp(): void {
  console.log(`ApexX

Usage:
  apexx build [path=apexx/classes and apexx/scripts]
  apexx build [path] --out force-app/main/default/classes
  apexx build [path] --scripts-out scripts/apex
  apexx build [path] --script-types inline|deployed
  apexx build [path] --api-version 67.0
  apexx parse <file.clsx|file.apexx>

.clsx compiles to a deployable .cls class.
.apexx compiles to a self-contained .apex anonymous block in scripts/apex,
which the Salesforce Apex extension can Execute or Debug directly.

--script-types deployed makes a script use the deployed ApexXFuncs and
ApexXTuples members instead of declaring its structural types inline. Needed
when a script passes a Func or a tuple to or from a deployed ApexX class.
`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

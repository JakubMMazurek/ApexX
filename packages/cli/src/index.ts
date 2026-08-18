#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { transpileApexX } from "@apexx/transpiler";
import type { ApexXDiagnostic } from "@apexx/ast";
import {
  inferApexClassName,
  resolveBuildTarget,
  writeApexClassFiles,
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
  const input = path.resolve(
    process.cwd(),
    args.positional[0] ?? (await defaultSourcePath(process.cwd())),
  );
  const explicitOut = args.options.get("out");
  const explicitApiVersion = args.options.get("api-version");
  const buildTarget = await resolveBuildTarget({
    sourcePath: input,
    workspaceRoot: process.cwd(),
    explicitClassesDir:
      typeof explicitOut === "string" ? explicitOut : undefined,
    explicitApiVersion:
      typeof explicitApiVersion === "string" ? explicitApiVersion : undefined,
  });
  const files = await collectClsxFiles(input);

  if (files.length === 0) {
    console.error(`No .clsx files found at ${input}`);
    process.exitCode = 1;
    return;
  }

  let hadError = false;

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const result = transpileApexX(source, {
      sourceFileName: path.basename(file),
      workspaceRoot: process.cwd(),
    });
    const errors = result.diagnostics.filter(
      diagnostic => diagnostic.severity === "error",
    );

    printDiagnostics(file, result.diagnostics);

    if (errors.length > 0) {
      hadError = true;
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
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

async function parse(args: ParsedArgs): Promise<void> {
  const input = args.positional[0];

  if (!input) {
    console.error("parse requires a .clsx file.");
    process.exitCode = 1;
    return;
  }

  const file = path.resolve(process.cwd(), input);
  const source = await fs.readFile(file, "utf8");
  const result = transpileApexX(source, {
    sourceFileName: path.basename(file),
    workspaceRoot: process.cwd(),
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

async function collectClsxFiles(input: string): Promise<string[]> {
  if (!(await exists(input))) {
    return [];
  }

  if (!(await statIsDirectory(input))) {
    return input.toLowerCase().endsWith(".clsx") ? [input] : [];
  }

  const files: string[] = [];
  const entries = await fs.readdir(input, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(input, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectClsxFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".clsx")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function defaultSourcePath(rootDir: string): Promise<string> {
  const apexXClasses = path.join(rootDir, "apexx", "classes");
  if (await exists(apexXClasses)) {
    return apexXClasses;
  }

  return "src";
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
      `${path.relative(process.cwd(), file)}:${position} ${diagnostic.severity}: ${diagnostic.message}`,
    );
  }
}

function printHelp(): void {
  console.log(`ApexX

Usage:
  apexx build [path=apexx/classes]
  apexx build [path] --out force-app/main/default/classes
  apexx build [path] --api-version 67.0
  apexx parse <file.clsx>
`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

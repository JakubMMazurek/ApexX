import fs from "node:fs/promises";
import path from "node:path";

export const FALLBACK_API_VERSION = "67.0";
export const DEFAULT_GENERATED_CLASSES_DIR = path.join(
  "generated",
  "force-app",
  "main",
  "default",
  "classes",
);
/**
 * Where generated anonymous blocks land. `scripts/apex` is the conventional
 * Salesforce DX location, and the Apex extension offers Execute and Debug on
 * every `.apex` file there.
 */
export const DEFAULT_SCRIPTS_DIR = path.join("scripts", "apex");

export interface SalesforceProjectInfo {
  rootDir: string;
  packageDirectory: string;
  classesDir: string;
  sourceApiVersion: string;
  projectFile: string;
}

export interface BuildTarget {
  classesDir: string;
  apiVersion: string;
  project?: SalesforceProjectInfo;
}

export interface ResolveBuildTargetOptions {
  sourcePath: string;
  workspaceRoot?: string;
  explicitClassesDir?: string;
  explicitApiVersion?: string;
}

export interface ScriptTarget {
  scriptsDir: string;
  project?: SalesforceProjectInfo;
}

export interface ResolveScriptTargetOptions {
  sourcePath: string;
  workspaceRoot?: string;
  explicitScriptsDir?: string;
}

export interface WriteApexScriptFileOptions {
  scriptsDir: string;
  scriptName: string;
  source: string;
}

export interface WriteApexClassFilesOptions {
  classesDir: string;
  className: string;
  source: string;
  apiVersion: string;
}

interface SfdxProjectJson {
  packageDirectories?: Array<{
    path?: string;
    default?: boolean;
  }>;
  sourceApiVersion?: string;
}

export async function resolveBuildTarget(
  options: ResolveBuildTargetOptions,
): Promise<BuildTarget> {
  const project = await readSalesforceProjectInfo(options.sourcePath);
  const workspaceRoot =
    options.workspaceRoot ??
    project?.rootDir ??
    path.dirname(path.resolve(options.sourcePath));
  const classesDir = options.explicitClassesDir
    ? path.resolve(workspaceRoot, options.explicitClassesDir)
    : project?.classesDir ??
      path.resolve(workspaceRoot, DEFAULT_GENERATED_CLASSES_DIR);

  return {
    classesDir,
    apiVersion:
      normalizeApiVersion(options.explicitApiVersion) ??
      project?.sourceApiVersion ??
      FALLBACK_API_VERSION,
    project,
  };
}

export async function resolveScriptTarget(
  options: ResolveScriptTargetOptions,
): Promise<ScriptTarget> {
  const project = await readSalesforceProjectInfo(options.sourcePath);
  const workspaceRoot =
    options.workspaceRoot ??
    project?.rootDir ??
    path.dirname(path.resolve(options.sourcePath));

  return {
    scriptsDir: path.resolve(
      workspaceRoot,
      options.explicitScriptsDir ?? DEFAULT_SCRIPTS_DIR,
    ),
    project,
  };
}

export async function readSalesforceProjectInfo(
  startPath: string,
): Promise<SalesforceProjectInfo | undefined> {
  const rootDir = await findSalesforceProjectRoot(startPath);

  if (!rootDir) {
    return undefined;
  }

  const projectFile = path.join(rootDir, "sfdx-project.json");
  const projectJson = JSON.parse(
    await fs.readFile(projectFile, "utf8"),
  ) as SfdxProjectJson;
  const packageDirectory = selectPackageDirectory(projectJson);

  return {
    rootDir,
    packageDirectory,
    classesDir: resolveClassesDir(rootDir, packageDirectory),
    sourceApiVersion:
      normalizeApiVersion(projectJson.sourceApiVersion) ?? FALLBACK_API_VERSION,
    projectFile,
  };
}

export async function findSalesforceProjectRoot(
  startPath: string,
): Promise<string | undefined> {
  let current = path.resolve(startPath);

  try {
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    const candidate = path.join(current, "sfdx-project.json");

    try {
      await fs.access(candidate);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

export function inferApexClassName(
  apexSource: string,
  fallbackName: string,
): string {
  const match = apexSource.match(/\bclass\s+([A-Za-z][A-Za-z0-9_]*)\b/);
  return match?.[1] ?? fallbackName.replace(/\.clsx$/i, "");
}

export function inferApexScriptName(fileName: string): string {
  return path.basename(fileName).replace(/\.(apexx|apex)$/i, "");
}

/** An anonymous block is not metadata, so it is written without a manifest. */
export async function writeApexScriptFile(
  options: WriteApexScriptFileOptions,
): Promise<{ scriptFile: string }> {
  await fs.mkdir(options.scriptsDir, { recursive: true });

  const scriptFile = path.join(options.scriptsDir, `${options.scriptName}.apex`);
  await fs.writeFile(scriptFile, options.source, "utf8");

  return { scriptFile };
}

export async function writeApexClassFiles(
  options: WriteApexClassFilesOptions,
): Promise<{ classFile: string; metadataFile: string }> {
  await fs.mkdir(options.classesDir, { recursive: true });

  const classFile = path.join(options.classesDir, `${options.className}.cls`);
  const metadataFile = `${classFile}-meta.xml`;

  await fs.writeFile(classFile, options.source, "utf8");
  await fs.writeFile(
    metadataFile,
    createApexClassMetadataXml(options.apiVersion),
    "utf8",
  );

  return { classFile, metadataFile };
}

export function createApexClassMetadataXml(apiVersion: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">',
    `    <apiVersion>${apiVersion}</apiVersion>`,
    "    <status>Active</status>",
    "</ApexClass>",
    "",
  ].join("\n");
}

function selectPackageDirectory(projectJson: SfdxProjectJson): string {
  const packageDirectory =
    projectJson.packageDirectories?.find(entry => entry.default)?.path ??
    projectJson.packageDirectories?.[0]?.path;

  return packageDirectory && packageDirectory.length > 0
    ? packageDirectory
    : "force-app";
}

function resolveClassesDir(rootDir: string, packageDirectory: string): string {
  const normalized = packageDirectory.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normalized.endsWith("/classes") || normalized === "classes") {
    return path.resolve(rootDir, normalized);
  }

  if (normalized.endsWith("/main/default") || normalized === "main/default") {
    return path.resolve(rootDir, normalized, "classes");
  }

  return path.resolve(rootDir, normalized, "main", "default", "classes");
}

function normalizeApiVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : undefined;
}


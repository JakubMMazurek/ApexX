import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mapIdentifierOffset, transpileApexX } from "@apexx/transpiler";
import type { ApexXPositionMap } from "@apexx/ast";

/**
 * Translates between authored ApexX and the generated Apex the Salesforce language
 * server understands.
 *
 * For each `.clsx` the bridge keeps the transpiled output and its position map, so
 * a question asked at an authored position can be asked again at the equivalent
 * generated position, and the answer reported back in authored terms.
 */

export interface BridgedDocument {
  authoredPath: string;
  authoredUri: string;
  generatedUri: string;
  source: string;
  output: string;
  map: ApexXPositionMap;
  generatedTypeNames: Map<string, string>;
}

export interface BridgeOptions {
  workspaceRoot: string;
  /** Directory the generated `.cls` files live in, relative to the workspace. */
  generatedDirectory?: string;
}

const DEFAULT_GENERATED_DIRECTORY = path.join(
  "force-app",
  "main",
  "default",
  "classes",
);

export class ApexBridge {
  private readonly byAuthoredUri = new Map<string, { version: string; document: BridgedDocument }>();
  private readonly generatedUriToAuthored = new Map<string, string>();
  private readonly generatedDirectory: string;

  constructor(private readonly options: BridgeOptions) {
    this.generatedDirectory = path.join(
      options.workspaceRoot,
      options.generatedDirectory ?? DEFAULT_GENERATED_DIRECTORY,
    );
  }

  /**
   * Transpiles `source` and caches the result. `version` is any value that changes
   * when the text changes, so unchanged documents are not transpiled repeatedly.
   */
  bridge(authoredUri: string, source: string, version: string): BridgedDocument | undefined {
    const cached = this.byAuthoredUri.get(authoredUri);

    if (cached?.version === version) {
      return cached.document;
    }

    let authoredPath: string;

    try {
      authoredPath = fileURLToPath(authoredUri);
    } catch {
      return undefined;
    }

    const className = path.basename(authoredPath).replace(/\.clsx$/i, "");
    const generatedPath = path.join(this.generatedDirectory, `${className}.cls`);

    let result;

    try {
      result = transpileApexX(source, {
        sourceFileName: path.basename(authoredPath),
        workspaceRoot: this.options.workspaceRoot,
      });
    } catch {
      return undefined;
    }

    const document: BridgedDocument = {
      authoredPath,
      authoredUri,
      generatedUri: pathToFileURL(generatedPath).href,
      source,
      output: result.output,
      map: result.sourceMap,
      generatedTypeNames: result.generatedTypeNames,
    };

    this.byAuthoredUri.set(authoredUri, { version, document });
    this.generatedUriToAuthored.set(document.generatedUri, authoredUri);
    return document;
  }

  /**
   * Bridges every `.clsx` in the workspace. Cross-file answers arrive as positions
   * in another generated file, so those maps have to exist too.
   */
  bridgeWorkspace(authoredFiles: { uri: string; source: string; version: string }[]): void {
    for (const file of authoredFiles) {
      this.bridge(file.uri, file.source, file.version);
    }
  }

  /** The authored document a generated URI came from, if ApexX generated it. */
  authoredFor(generatedUri: string): BridgedDocument | undefined {
    const authoredUri = this.generatedUriToAuthored.get(normaliseUri(generatedUri));

    if (authoredUri) {
      return this.byAuthoredUri.get(authoredUri)?.document;
    }

    // A generated file may be indexed before its authored source was opened; match
    // on class name so cross-file jumps still land in the `.clsx`.
    const className = basenameWithoutExtension(generatedUri);

    for (const entry of this.byAuthoredUri.values()) {
      if (basenameWithoutExtension(entry.document.authoredPath) === className) {
        return entry.document;
      }
    }

    return undefined;
  }

  /** Maps an authored offset to the equivalent offset in the generated Apex. */
  toGenerated(document: BridgedDocument, authoredOffset: number): number | undefined {
    return mapIdentifierOffset(
      document.map as never,
      document.source,
      document.output,
      authoredOffset,
    );
  }

  /**
   * Maps a generated offset back to the authored source. Returns undefined when the
   * offset belongs to code ApexX generated, which has no authored origin -- that is
   * a meaningful answer, not a failure.
   */
  toAuthored(document: BridgedDocument, generatedOffset: number): number | undefined {
    return document.map.toSource(generatedOffset);
  }

  /** Reads an authored `.clsx` from disk, for files the editor has not opened. */
  readAuthored(authoredPath: string): string | undefined {
    try {
      return fs.readFileSync(authoredPath, "utf8");
    } catch {
      return undefined;
    }
  }

  documents(): BridgedDocument[] {
    return [...this.byAuthoredUri.values()].map(entry => entry.document);
  }
}

/**
 * Rewrites generated type names back into ApexX syntax, so a hover never shows a
 * signature hash like `ApexXFuncs.ApexXFunc_8420216b86a6`.
 */
export function translateGeneratedNames(
  text: string,
  documents: BridgedDocument[],
): string {
  let translated = text;

  for (const document of documents) {
    for (const [generated, authored] of document.generatedTypeNames) {
      const bare = generated.replace(/^ApexXFuncs\./, "");
      translated = translated
        .split(`ApexXFuncs.${bare}`)
        .join(authored)
        .split(bare)
        .join(authored);
    }
  }

  // Nested carrier and lambda names leak through the same way.
  return translated
    .replace(/ApexXTuples\.ApexXTuple_[0-9a-f]+/g, "tuple")
    .replace(/\bApexXTuple_[0-9a-f]+/g, "tuple")
    .replace(/\bApexXLambda\d+\b/g, "lambda");
}

/** True when a hover or symbol label describes ApexX-generated scaffolding. */
export function isGeneratedArtifact(text: string): boolean {
  return /ApexXFunc_[0-9a-f]+|ApexXTuple_[0-9a-f]+|ApexXLambda\d+|ApexX\.Invocation|ApexX\.Next/.test(
    text,
  );
}

function normaliseUri(uri: string): string {
  try {
    return pathToFileURL(fileURLToPath(uri)).href;
  } catch {
    return uri;
  }
}

function basenameWithoutExtension(value: string): string {
  const name = value.includes("://") ? value.split("/").pop() ?? value : path.basename(value);
  return name.replace(/\.(clsx|cls)$/i, "");
}

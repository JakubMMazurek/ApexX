import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  mergeGeneratedSupportClasses,
  transpileApexX,
} from "@apexx/transpiler";
import type {
  ApexXStructuralTypes,
  GeneratedApexSupportClass,
  TranspileResult,
} from "@apexx/ast";
import {
  inferApexClassName,
  inferApexScriptName,
  resolveBuildTarget,
  resolveScriptTarget,
  writeApexClassFiles,
  writeApexScriptFile,
} from "@apexx/sfdx";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node.js";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("ApexX");
  context.subscriptions.push(outputChannel);

  const serverModule = resolveServerModule(context);
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6010"] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "apexx" }],
    outputChannel,
    initializationOptions: {
      // Reuse whatever JDK the Salesforce Apex extension is configured with, so
      // ApexX resolves symbols through the same Apex language server it does.
      javaHome:
        vscode.workspace
          .getConfiguration("salesforcedx-vscode-apex")
          .get<string>("java.home") ||
        vscode.workspace.getConfiguration("apexx").get<string>("javaHome") ||
        undefined,
      useApexLanguageServer: vscode.workspace
        .getConfiguration("apexx")
        .get<boolean>("useApexLanguageServer", false),
      apexDiagnostics: vscode.workspace
        .getConfiguration("apexx")
        .get<boolean>("apexDiagnostics", false),
      standardApexLibrary: vscode.workspace
        .getConfiguration("apexx")
        .get<boolean>("standardApexLibrary", true),
      // So a script's diagnostics match how it will be built.
      scriptStructuralTypes: scriptStructuralTypes(
        vscode.workspace.getConfiguration("apexx"),
      ),
    },
  };

  client = new LanguageClient(
    "apexxLanguageServer",
    "ApexX Language Server",
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(client);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => {
      if (shouldCompileOnSave(document)) {
        void buildDocument(document).catch(reportBuildError);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("apexx.buildCurrentFile", async () => {
      const document = vscode.window.activeTextEditor?.document;

      if (!document || !isApexXDocument(document)) {
        await vscode.window.showWarningMessage("Open a .clsx or .apexx file first.");
        return;
      }

      await buildDocument(document).catch(reportBuildError);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "apexx.executeCurrentScript",
      async (target?: vscode.Uri) => {
        const document = target
          ? await vscode.workspace.openTextDocument(target)
          : vscode.window.activeTextEditor?.document;

        if (!document || !isApexXScriptDocument(document)) {
          await vscode.window.showWarningMessage("Open an .apexx script first.");
          return;
        }

        await executeScriptDocument(document).catch(error =>
          reportExtensionError("ApexX execute failed", error),
        );
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("apexx.restartLanguageServer", async () => {
      // A language service that has gone quiet, or one whose settings changed, should
      // not need the whole window reloaded to come back.
      if (!client) {
        return;
      }

      outputChannel?.appendLine("Restarting the ApexX language server.");

      try {
        await client.restart();
        void vscode.window.setStatusBarMessage("ApexX language server restarted.", 3000);
      } catch (error) {
        reportExtensionError("ApexX language server restart failed", error);
      }
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.apexx" },
      new ApexXScriptCodeLensProvider(),
    ),
  );

  client.onDidChangeState(event => {
    outputChannel?.appendLine(
      `Language server state changed: ${event.oldState} -> ${event.newState}`,
    );
  });

  try {
    await client.start();
  } catch (error) {
    reportExtensionError("ApexX language server failed to start", error);
  }
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

function resolveServerModule(context: vscode.ExtensionContext): string {
  const candidates = [
    context.asAbsolutePath(
      path.join("..", "language-server", "dist", "server.js"),
    ),
    context.asAbsolutePath(
      path.join("node_modules", "@apexx", "language-server", "dist", "server.js"),
    ),
    context.asAbsolutePath(
      path.join("..", "..", "node_modules", "@apexx", "language-server", "dist", "server.js"),
    ),
  ];

  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error("ApexX language server was not built. Run npm run build first.");
  }

  return found;
}

function shouldCompileOnSave(document: vscode.TextDocument): boolean {
  if (!isApexXDocument(document)) {
    return false;
  }

  return vscode.workspace
    .getConfiguration("apexx", document.uri)
    .get<boolean>("compileOnSave", true);
}

function isApexXDocument(document: vscode.TextDocument): boolean {
  const lowered = document.uri.fsPath.toLowerCase();

  return (
    document.uri.scheme === "file" &&
    (document.languageId === "apexx" ||
      lowered.endsWith(".clsx") ||
      lowered.endsWith(".apexx"))
  );
}

/** An `.apexx` script compiles to an anonymous block instead of a class. */
function isApexXScriptDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === "file" &&
    document.uri.fsPath.toLowerCase().endsWith(".apexx")
  );
}

/** Puts Execute where the script is authored, next to the Execute the Apex
 * extension already offers on the generated `.apex` block. */
class ApexXScriptCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isApexXScriptDocument(document)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: "Execute",
        command: "apexx.executeCurrentScript",
        arguments: [document.uri],
      }),
      new vscode.CodeLens(range, {
        title: "Compile",
        command: "apexx.buildCurrentFile",
      }),
    ];
  }
}

/** Returns the generated file, or undefined when the source has errors. */
async function buildDocument(
  document: vscode.TextDocument,
): Promise<string | undefined> {
  const filePath = document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? path.dirname(filePath);
  const config = vscode.workspace.getConfiguration("apexx", document.uri);
  const outputDirectory = config.get<string>("outputDirectory", "").trim();
  const apiVersion = config.get<string>("apiVersion", "").trim();
  const script = isApexXScriptDocument(document);
  const result = transpileApexX(document.getText(), {
    sourceFileName: path.basename(filePath),
    workspaceRoot,
    mode: script ? "anonymous" : "class",
    structuralTypes: scriptStructuralTypes(config),
  });
  const errors = result.diagnostics.filter(
    diagnostic => diagnostic.severity === "error",
  );

  if (errors.length > 0) {
    const message = `ApexX did not write generated Apex because ${errors.length} error(s) were found.`;
    outputChannel?.appendLine(message);
    for (const error of errors) {
      outputChannel?.appendLine(`error: ${error.message}`);
    }
    vscode.window.setStatusBarMessage(message, 5000);
    return undefined;
  }

  if (script) {
    const scriptTarget = await resolveScriptTarget({
      sourcePath: filePath,
      workspaceRoot,
      explicitScriptsDir: scriptOutputDirectory(config) ?? undefined,
    });
    const written = await writeApexScriptFile({
      scriptsDir: scriptTarget.scriptsDir,
      scriptName: inferApexScriptName(filePath),
      source: result.output,
    });

    outputChannel?.appendLine(`Built ${written.scriptFile}`);

    // A script declares its own structural types. Anything left here is a class
    // an anonymous block cannot declare, so it has to be deployed instead.
    for (const supportClass of result.supportClasses) {
      outputChannel?.appendLine(
        `warning: this script depends on ${supportClass.className}, which an anonymous block cannot declare. Deploy ${supportClass.className}.cls before running it.`,
      );
    }

    vscode.window.setStatusBarMessage(
      `ApexX generated ${path.basename(written.scriptFile)}`,
      3500,
    );

    return written.scriptFile;
  }

  const target = await resolveBuildTarget({
    sourcePath: filePath,
    workspaceRoot,
    explicitClassesDir: outputDirectory.length > 0 ? outputDirectory : undefined,
    explicitApiVersion: apiVersion.length > 0 ? apiVersion : undefined,
  });
  warnIfSourceIsInGeneratedClasses(filePath, target.classesDir);
  const className = inferApexClassName(result.output, path.basename(filePath));
  const written = await writeApexClassFiles({
    classesDir: target.classesDir,
    className,
    source: result.output,
    apiVersion: target.apiVersion,
  });

  outputChannel?.appendLine(`Built ${written.classFile}`);
  outputChannel?.appendLine(`Built ${written.metadataFile}`);

  const workspaceSupport = collectWorkspaceSupportClasses(
    workspaceRoot,
    filePath,
    result,
  );
  for (const supportClass of mergeGeneratedSupportClasses(workspaceSupport)) {
    const supportWritten = await writeApexClassFiles({
      classesDir: target.classesDir,
      className: supportClass.className,
      source: supportClass.source,
      apiVersion: target.apiVersion,
    });
    outputChannel?.appendLine(`Built ${supportWritten.classFile}`);
    outputChannel?.appendLine(`Built ${supportWritten.metadataFile}`);
  }

  vscode.window.setStatusBarMessage(
    `ApexX generated ${path.basename(written.classFile)}`,
    3500,
  );

  return written.classFile;
}

function scriptStructuralTypes(
  config: vscode.WorkspaceConfiguration,
): ApexXStructuralTypes {
  return config.get<string>("scriptStructuralTypes", "inline") === "deployed"
    ? "deployed"
    : "inline";
}

function scriptOutputDirectory(
  config: vscode.WorkspaceConfiguration,
): string | undefined {
  const configured = config.get<string>("scriptOutputDirectory", "").trim();
  return configured.length > 0 ? configured : undefined;
}

/** The command the Salesforce Apex extension puts behind Execute on a `.apex`
 * file. It reads the active editor, so the generated block is shown first. */
const SALESFORCE_EXECUTE_COMMAND = "sf.anon.apex.execute.document";

async function executeScriptDocument(
  document: vscode.TextDocument,
): Promise<void> {
  if (document.isDirty) {
    await document.save();
  }

  const scriptFile = await buildDocument(document);

  if (!scriptFile) {
    return;
  }

  const generated = await vscode.workspace.openTextDocument(
    vscode.Uri.file(scriptFile),
  );
  await vscode.window.showTextDocument(generated, { preview: true });

  const available = await vscode.commands.getCommands(true);

  if (available.includes(SALESFORCE_EXECUTE_COMMAND)) {
    await vscode.commands.executeCommand(SALESFORCE_EXECUTE_COMMAND);
  } else {
    // Without the Salesforce Apex extension there is no Execute to delegate to,
    // so the same run goes through the CLI where the user can watch it.
    const terminal = vscode.window.createTerminal("ApexX");
    terminal.show(true);
    terminal.sendText(`sf apex run --file "${scriptFile}"`);
  }

  await vscode.window.showTextDocument(document, { preview: false });
}

function collectWorkspaceSupportClasses(
  workspaceRoot: string,
  currentFilePath: string,
  currentResult: TranspileResult,
): GeneratedApexSupportClass[] {
  const conventionalSourceRoot = path.join(workspaceRoot, "apexx", "classes");
  const sourceRoot = fs.existsSync(conventionalSourceRoot)
    ? conventionalSourceRoot
    : path.dirname(currentFilePath);
  const supportClasses: GeneratedApexSupportClass[] = [];

  for (const sourceFile of collectClsxFiles(sourceRoot)) {
    const result = path.resolve(sourceFile) === path.resolve(currentFilePath)
      ? currentResult
      : transpileApexX(fs.readFileSync(sourceFile, "utf8"), {
          sourceFileName: path.basename(sourceFile),
          workspaceRoot,
        });

    if (result.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
      outputChannel?.appendLine(
        `warning: skipped structural contracts from ${sourceFile} because it has compiler errors.`,
      );
      continue;
    }
    supportClasses.push(...result.supportClasses);
  }

  return supportClasses;
}

function collectClsxFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectClsxFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".clsx")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function warnIfSourceIsInGeneratedClasses(
  sourcePath: string,
  classesDir: string,
): void {
  const sourceDir = path.resolve(path.dirname(sourcePath)).toLowerCase();
  const generatedDir = path.resolve(classesDir).toLowerCase();

  if (sourceDir === generatedDir) {
    outputChannel?.appendLine(
      "warning: .clsx source is inside the generated Salesforce classes folder. Prefer apexx/classes for source files.",
    );
  }
}

function reportBuildError(error: unknown): void {
  reportExtensionError("ApexX build failed", error);
}

function reportExtensionError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  outputChannel?.appendLine(`error: ${message}`);
  void vscode.window.showErrorMessage(`${prefix}: ${message}`);
}

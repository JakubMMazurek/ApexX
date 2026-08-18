import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { transpileApexX } from "@apexx/transpiler";
import {
  inferApexClassName,
  resolveBuildTarget,
  writeApexClassFiles,
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
        await vscode.window.showWarningMessage("Open a .clsx file first.");
        return;
      }

      await buildDocument(document).catch(reportBuildError);
    }),
  );

  await client.start();
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
  return (
    document.uri.scheme === "file" &&
    (document.languageId === "apexx" ||
      document.uri.fsPath.toLowerCase().endsWith(".clsx"))
  );
}

async function buildDocument(document: vscode.TextDocument): Promise<void> {
  const filePath = document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? path.dirname(filePath);
  const config = vscode.workspace.getConfiguration("apexx", document.uri);
  const outputDirectory = config.get<string>("outputDirectory", "").trim();
  const apiVersion = config.get<string>("apiVersion", "").trim();
  const result = transpileApexX(document.getText(), {
    sourceFileName: path.basename(filePath),
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
    return;
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
  vscode.window.setStatusBarMessage(
    `ApexX generated ${path.basename(written.classFile)}`,
    3500,
  );
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
  const message = error instanceof Error ? error.message : String(error);
  outputChannel?.appendLine(`error: ${message}`);
  void vscode.window.showErrorMessage(`ApexX build failed: ${message}`);
}

import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node.js";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

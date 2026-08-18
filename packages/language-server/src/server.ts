#!/usr/bin/env node
import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { transpileApexX } from "@apexx/transpiler";
import type { ApexXDiagnostic } from "@apexx/ast";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
  },
}));

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(event => validateDocument(event.document));
documents.onDidClose(event => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

async function validateDocument(document: TextDocument): Promise<void> {
  if (!document.uri.toLowerCase().endsWith(".clsx")) {
    return;
  }

  const result = transpileApexX(document.getText(), {
    sourceFileName: document.uri.split("/").at(-1),
  });

  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: result.diagnostics.map(toLspDiagnostic),
  });
}

function toLspDiagnostic(diagnostic: ApexXDiagnostic) {
  const line = Math.max((diagnostic.range?.start.line ?? 1) - 1, 0);
  const character = Math.max(diagnostic.range?.start.column ?? 0, 0);

  return {
    severity:
      diagnostic.severity === "error"
        ? DiagnosticSeverity.Error
        : diagnostic.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information,
    range: {
      start: { line, character },
      end: {
        line,
        character: Math.max(character + 1, diagnostic.range?.end.column ?? character + 1),
      },
    },
    message: diagnostic.message,
    source: diagnostic.source ?? "apexx",
  };
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A thin LSP client for the Salesforce Apex language server that ships inside the
 * `salesforcedx-vscode-apex` extension.
 *
 * The server understands plain Apex only, so it is pointed at the generated `.cls`
 * output and its answers are translated back to the authored `.clsx` by the
 * caller. Everything here degrades quietly: if Java or the jar is missing, or the
 * process dies, the client reports itself unavailable and the language server
 * falls back to its own symbol model rather than surfacing an error.
 */

export type JorjeState = "idle" | "starting" | "ready" | "unavailable";

export interface JorjeOptions {
  workspaceRoot: string;
  javaHome?: string;
  jarPath?: string;
  /** How long to wait for the initial project index before answering requests. */
  indexTimeoutMs?: number;
  log?: (message: string) => void;
}

const REQUEST_TIMEOUT_MS = 8000;
const INDEX_TIMEOUT_MS = 45000;

export class JorjeClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readyPromise: Promise<boolean> | undefined;
  private indexed = false;
  private readonly openDocuments = new Map<string, number>();

  state: JorjeState = "idle";
  unavailableReason: string | undefined;

  constructor(private readonly options: JorjeOptions) {}

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * Starts the server on first use and resolves once the project index is warm.
   * Repeated calls share one startup; a failed startup is remembered.
   */
  async ready(): Promise<boolean> {
    if (this.state === "unavailable") {
      return false;
    }

    this.readyPromise ??= this.start();
    return this.readyPromise;
  }

  /** True only when a request can be served right now. */
  get isReady(): boolean {
    return this.state === "ready" && this.indexed;
  }

  private async start(): Promise<boolean> {
    const java = resolveJava(this.options.javaHome);

    if (!java) {
      return this.giveUp(
        "no Java runtime found. Set salesforcedx-vscode-apex.java.home or JAVA_HOME to enable Apex-accurate resolution.",
      );
    }

    const jar = this.options.jarPath ?? findJorjeJar();

    if (!jar) {
      return this.giveUp(
        "apex-jorje-lsp.jar not found. Install the Salesforce Apex extension to enable Apex-accurate resolution.",
      );
    }

    this.state = "starting";
    this.log(`starting Apex language server: ${path.basename(jar)}`);

    try {
      this.process = spawn(
        java,
        [
          "-cp",
          jar,
          "-Ddebug.internal.errors=true",
          "-Ddebug.semantic.errors=false",
          "-Ddebug.completion.statistics=false",
          "-Dlwc.typegeneration.disabled=true",
          "apex.jorje.lsp.ApexLanguageServerLauncher",
        ],
        { cwd: this.options.workspaceRoot, stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      return this.giveUp(`could not launch Java: ${describe(error)}`);
    }

    this.process.on("error", error => {
      void this.giveUp(`Apex language server failed: ${describe(error)}`);
    });
    this.process.on("exit", code => {
      if (this.state !== "unavailable") {
        void this.giveUp(`Apex language server exited with code ${code}.`);
      }
    });
    this.process.stdout.on("data", chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk as Buffer]);
      this.drain();
    });
    // jorje logs indexing progress to stderr; watch it rather than guessing a delay.
    this.process.stderr.on("data", chunk => {
      const text = String(chunk);

      if (/Scanning user-defined types took|ApexIndexer: ApexFiles/.test(text)) {
        this.indexed = true;
      }
    });

    const rootUri = pathToFileURL(this.options.workspaceRoot + path.sep).href;

    try {
      await this.request("initialize", {
        processId: process.pid,
        rootPath: this.options.workspaceRoot,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.workspaceRoot) }],
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: {},
            references: {},
            documentSymbol: {},
            completion: { completionItem: { snippetSupport: false } },
          },
        },
      }, INDEX_TIMEOUT_MS);
    } catch (error) {
      return this.giveUp(`initialize failed: ${describe(error)}`);
    }

    this.notify("initialized", {});
    this.state = "ready";

    await this.waitForIndex();
    this.log("Apex language server ready");
    return true;
  }

  private async waitForIndex(): Promise<void> {
    const deadline = Date.now() + (this.options.indexTimeoutMs ?? INDEX_TIMEOUT_MS);

    while (!this.indexed && Date.now() < deadline && this.state === "ready") {
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    // Treat a quiet server as indexed rather than blocking requests forever.
    this.indexed = true;
  }

  private giveUp(reason: string): false {
    if (this.state !== "unavailable") {
      this.state = "unavailable";
      this.unavailableReason = reason;
      this.log(reason);
    }

    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }

    this.pending.clear();
    this.process?.kill();
    this.process = undefined;
    return false;
  }

  /** Mirrors a generated document into the server, replacing any earlier version. */
  syncDocument(uri: string, text: string): void {
    if (!this.process || this.state === "unavailable") {
      return;
    }

    const version = (this.openDocuments.get(uri) ?? 0) + 1;
    this.openDocuments.set(uri, version);

    if (version === 1) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "apex", version, text },
      });
      return;
    }

    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async send<T>(method: string, params: unknown): Promise<T | undefined> {
    if (!(await this.ready()) || !this.process) {
      return undefined;
    }

    try {
      return (await this.request(method, params)) as T;
    } catch (error) {
      this.log(`${method} failed: ${describe(error)}`);
      return undefined;
    }
  }

  dispose(): void {
    this.state = "unavailable";
    this.process?.kill();
    this.process = undefined;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    this.write({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) {
      return;
    }

    const payload = JSON.stringify(message);
    this.process.stdin.write(
      `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`,
    );
    this.process.stdin.write(payload);
  }

  private drain(): void {
    const separator = Buffer.from("\r\n\r\n");

    for (;;) {
      const headerEnd = this.buffer.indexOf(separator);

      if (headerEnd < 0) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = /Content-Length:\s*(\d+)/i.exec(header)?.[1];

      if (!length) {
        this.buffer = this.buffer.subarray(headerEnd + separator.length);
        continue;
      }

      const bodyStart = headerEnd + separator.length;
      const bodyEnd = bodyStart + Number(length);

      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);

      let message: { id?: number; error?: { message?: string }; result?: unknown };

      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (message.id === undefined) {
        continue;
      }

      const entry = this.pending.get(message.id);

      if (!entry) {
        continue;
      }

      clearTimeout(entry.timer);
      this.pending.delete(message.id);

      if (message.error) {
        entry.reject(new Error(message.error.message ?? "unknown error"));
      } else {
        entry.resolve(message.result);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Locates a Java runtime the same way the Salesforce extension does. */
export function resolveJava(javaHome?: string): string | undefined {
  const candidates: string[] = [];

  if (javaHome) {
    candidates.push(path.join(javaHome, "bin", "java"));
  }

  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, "bin", "java"));
  }

  if (process.platform === "darwin") {
    try {
      const home = execFileSync("/usr/libexec/java_home", { encoding: "utf8" }).trim();

      if (home) {
        candidates.push(path.join(home, "bin", "java"));
      }
    } catch {
      // No registered JDK; fall through to PATH.
    }
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return onPath("java");
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(command: string): string | undefined {
  const separator = process.platform === "win32" ? ";" : ":";

  for (const directory of (process.env.PATH ?? "").split(separator)) {
    if (!directory) {
      continue;
    }

    const candidate = path.join(
      directory,
      process.platform === "win32" ? `${command}.exe` : command,
    );

    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Finds the newest `apex-jorje-lsp.jar` across the editor extension directories.
 * Versions sort lexically well enough here because the jar path carries the
 * extension version, and the highest is the one the editor is running.
 */
export function findJorjeJar(): string | undefined {
  const roots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"),
    path.join(os.homedir(), ".cursor", "extensions"),
    path.join(os.homedir(), ".windsurf", "extensions"),
  ];
  const found: string[] = [];

  for (const root of roots) {
    let entries: string[];

    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!/^salesforce\.salesforcedx-vscode-apex-/i.test(entry)) {
        continue;
      }

      const candidate = path.join(root, entry, "dist", "apex-jorje-lsp.jar");

      if (fs.existsSync(candidate)) {
        found.push(candidate);
      }
    }
  }

  return found.sort(compareVersionPaths).at(-1);
}

function compareVersionPaths(left: string, right: string): number {
  const version = (value: string): number[] =>
    (/-(\d+(?:\.\d+)*)$/.exec(path.basename(path.dirname(path.dirname(value))))?.[1] ?? "0")
      .split(".")
      .map(Number);

  const a = version(left);
  const b = version(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

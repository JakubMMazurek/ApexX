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
  /** Grace period after the handshake before the server is relied on. */
  warmUpMs?: number;
  /**
   * Start even when the workspace already has an Apex index. Only safe when no
   * other Apex language server is running against this project.
   */
  allowSharedIndex?: boolean;
  log?: (message: string) => void;
  /** Receives server-initiated notifications, such as published diagnostics. */
  onNotification?: (method: string, params: unknown) => void;
}

const REQUEST_TIMEOUT_MS = 8000;
const INDEX_TIMEOUT_MS = 45000;
const WARM_UP_MS = 20000;

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
  private readyAt = 0;
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

  /**
   * True once the server can be relied on: the handshake is done and the project
   * index has either reported finishing or been given a grace period to do so.
   *
   * Documents opened before the index is built are silently dropped by the server,
   * so asking too early does not just return nothing, it leaves the document
   * unknown for the rest of the session. The grace period is capped rather than
   * waited on indefinitely, because the indexer's log line is not guaranteed to
   * appear; until then, callers fall back to the built-in model.
   */
  get isReady(): boolean {
    return (
      this.state === "ready" &&
      (this.indexed || Date.now() - this.readyAt > (this.options.warmUpMs ?? WARM_UP_MS))
    );
  }

  /** True once the indexer has reported finishing. */
  get isIndexed(): boolean {
    return this.indexed;
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

    // Refuse to become a second writer on an index another Apex server owns.
    // Two processes on one apex.db corrupt it, which stops the Salesforce Apex
    // extension from starting at all -- a failure well outside this project.
    const owned = existingApexIndex(this.options.workspaceRoot);

    if (owned && !this.options.allowSharedIndex) {
      return this.giveUp(
        `the Salesforce Apex extension already owns this workspace's index (${owned}). ` +
          "Starting a second Apex language server here would corrupt it, so symbol " +
          "resolution stays on ApexX's built-in model.",
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

    // A killed language server must not leave the JVM behind: it holds a few
    // hundred megabytes and several orphans will starve the machine.
    const stopChild = (): void => {
      this.process?.kill();
      this.process = undefined;
    };

    process.once("exit", stopChild);
    process.once("SIGTERM", stopChild);
    process.once("SIGINT", stopChild);

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

      if (!this.indexed && /Scanning user-defined types took|ApexIndexer: ApexFiles/.test(text)) {
        this.indexed = true;
        this.log("Apex language server indexed");
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
    this.readyAt = Date.now();
    this.log("Apex language server ready");
    return true;
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

  /** True when this URI has been mirrored into the server. */
  isOpen(uri: string): boolean {
    return this.openDocuments.has(uri);
  }

  /**
   * Forgets that a document was opened, so the next sync sends `didOpen` again.
   *
   * A `didOpen` sent before the project index is built is dropped, and every later
   * `didChange` for that document is then ignored, which would leave it broken for
   * the rest of the session. Re-opening on failure makes that self-healing.
   */
  reopen(uri: string): void {
    this.openDocuments.delete(uri);
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

      let message: {
        id?: number;
        error?: { message?: string };
        result?: unknown;
        method?: string;
        params?: unknown;
      };

      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (message.id === undefined) {
        const notification = message as unknown as { method?: string; params?: unknown };

        if (notification.method) {
          this.options.onNotification?.(notification.method, notification.params);
        }

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

/**
 * The Apex index another server has already built for this workspace, if any.
 *
 * The Apex language server keeps a persistent index at `.sfdx/tools/<version>/apex.db`
 * and does not lock it, so a second server writing the same file corrupts it.
 */
export function existingApexIndex(workspaceRoot: string): string | undefined {
  const tools = path.join(workspaceRoot, ".sfdx", "tools");

  let entries: string[];

  try {
    entries = fs.readdirSync(tools);
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const candidate = path.join(tools, entry, "apex.db");

    if (fs.existsSync(candidate)) {
      return path.relative(workspaceRoot, candidate);
    }
  }

  return undefined;
}

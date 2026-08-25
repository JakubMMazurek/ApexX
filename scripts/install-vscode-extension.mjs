#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceExtension = path.join(repoRoot, "packages", "vscode-extension");
const extensionId = "apexx.apexx-vscode-extension-0.1.0";
const rootNodeModules = path.join(repoRoot, "node_modules");

const extensionsRoot = resolveExtensionsRoot();
const targetExtension = path.join(extensionsRoot, extensionId);

if (!fs.existsSync(path.join(sourceExtension, "dist", "extension.js"))) {
    fail("ApexX extension is not built. Run npm run build first.");
}

if (!fs.existsSync(path.join(repoRoot, "packages", "language-server", "dist", "server.js"))) {
    fail("ApexX language server is not built. Run npm run build first.");
}

if (!fs.existsSync(rootNodeModules)) {
    fail("Dependencies are not installed. Run npm install first.");
}

fs.mkdirSync(targetExtension, { recursive: true });

for (const file of ["package.json", "language-configuration.json"]) {
    fs.copyFileSync(path.join(sourceExtension, file), path.join(targetExtension, file));
}

for (const directory of ["dist", "syntaxes", "snippets"]) {
    const target = path.join(targetExtension, directory);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(sourceExtension, directory), target, { recursive: true });
}

linkNodeModules();

console.log(`Installed ApexX VS Code extension to ${targetExtension}`);
console.log("Reload VS Code for .clsx and .apexx syntax highlighting, compile-on-save, and Execute on scripts.");

// The extension loads the language server and compiler from the workspace packages,
// so the install is a link back to this repo rather than a copy. Windows junctions
// are used instead of symlinks because they do not require elevated permissions.
function linkNodeModules() {
    const target = path.join(targetExtension, "node_modules");
    const linkType = process.platform === "win32" ? "junction" : "dir";

    // lstat, not existsSync: a link pointing at a moved repo is broken, and
    // existsSync follows links, so it reports a broken link as absent.
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
        const current = readLinkTarget(target);
        if (current && path.resolve(current) === path.resolve(rootNodeModules)) {
            return;
        }
        // Links are unlinked directly. rmSync resolves a link before deleting it,
        // so it silently does nothing when the link is already broken.
        if (existing.isSymbolicLink()) {
            fs.unlinkSync(target);
        } else {
            fs.rmSync(target, { recursive: true, force: true });
        }
    }

    fs.symlinkSync(rootNodeModules, target, linkType);
}

function readLinkTarget(target) {
    try {
        return fs.readlinkSync(target);
    } catch {
        return undefined;
    }
}

// VS Code keeps extensions in ~/.vscode/extensions on every platform. Forks and
// variants differ, so allow an explicit override for Insiders, VSCodium or Cursor.
function resolveExtensionsRoot() {
    const override = argumentValue("--extensions-dir") ?? process.env.APEXX_VSCODE_EXTENSIONS;
    if (override) {
        return path.resolve(untildify(override));
    }
    return path.join(os.homedir(), ".vscode", "extensions");
}

function untildify(value) {
    return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
    console.error(`ApexX VS Code extension install failed: ${message}`);
    process.exit(1);
}

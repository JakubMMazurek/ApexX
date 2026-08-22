$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceExtension = Join-Path $repoRoot "packages\vscode-extension"
$extensionId = "apexx.apexx-vscode-extension-0.1.0"
$extensionsRoot = Join-Path $env:USERPROFILE ".vscode\extensions"
$targetExtension = Join-Path $extensionsRoot $extensionId
$rootNodeModules = Join-Path $repoRoot "node_modules"

if (-not (Test-Path (Join-Path $sourceExtension "dist\extension.js"))) {
    throw "ApexX extension is not built. Run npm run build first."
}

if (-not (Test-Path (Join-Path $repoRoot "packages\language-server\dist\server.js"))) {
    throw "ApexX language server is not built. Run npm run build first."
}

if (-not (Test-Path $rootNodeModules)) {
    throw "Dependencies are not installed. Run npm install first."
}

New-Item -ItemType Directory -Path $extensionsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $targetExtension -Force | Out-Null

Copy-Item (Join-Path $sourceExtension "package.json") $targetExtension -Force
Copy-Item (Join-Path $sourceExtension "language-configuration.json") $targetExtension -Force
Copy-Item (Join-Path $sourceExtension "dist") $targetExtension -Recurse -Force
Copy-Item (Join-Path $sourceExtension "syntaxes") $targetExtension -Recurse -Force
Copy-Item (Join-Path $sourceExtension "snippets") $targetExtension -Recurse -Force

$targetNodeModules = Join-Path $targetExtension "node_modules"
if (-not (Test-Path $targetNodeModules)) {
    New-Item -ItemType Junction -Path $targetNodeModules -Target $rootNodeModules | Out-Null
}

Write-Host "Installed ApexX VS Code extension to $targetExtension"
Write-Host "Reload VS Code for .clsx syntax highlighting and compile-on-save."

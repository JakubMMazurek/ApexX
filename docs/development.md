# Development

## Install And Build

```powershell
cd C:\Users\qba05\Documents\ApexX
npm install
npm run build
```

## Run The PoC

```powershell
npm run apexx -- build examples --out generated
```

This writes `.cls` files under `generated`.

## Validate

```powershell
npm run test
```

The smoke test builds the examples and checks that the generated output contains the expected typed loop.

## Parse A Single File

```powershell
npm run apexx -- parse examples\AccountService.clsx
```

`parse` runs the ApexX lowering path and validates the generated Apex through `@apexdevtools/apex-parser`.

## VS Code Extension

The extension package contributes the `apexx` language for `.clsx` files and starts the minimal ApexX language server in local development after the repo is built.

Open `packages/vscode-extension` as an extension development host target after running:

```powershell
npm install
npm run build
```

The extension is intentionally thin for v0.1. Its main job is to prove `.clsx` language registration and diagnostics wiring while the CLI/compiler shape settles.


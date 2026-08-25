// Generates the ApexX half of the showcase's code panels from the authored
// sources, so what the presentation claims is executable is the source that
// actually compiles and runs. The plain-Apex "before" panels stay hand-written
// in the component: they are a fair conventional equivalent, not a real file.
//
//   node scripts/build-showcase-snippets.mjs           write the module
//   node scripts/build-showcase-snippets.mjs --check    fail if it is stale

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  root,
  "force-app",
  "main",
  "default",
  "lwc",
  "apexxShowcase",
  "showcaseSource.js",
);

const ACCOUNT_SERVICE = "apexx/classes/AccountService.clsx";

// Every panel that shows ApexX. `member` is extracted from `file` by name;
// `text` is literal prose that frames it, such as the call shapes a default
// argument enables.
const SNIPPETS = [
  {
    name: "EMAIL_APEXX",
    parts: [{ file: ACCOUNT_SERVICE, member: "inspectPortfolio" }],
  },
  {
    name: "STRATEGY_APEXX",
    parts: [
      { file: ACCOUNT_SERVICE, member: "evaluateMode" },
      { file: ACCOUNT_SERVICE, member: "evaluateRenewalStrategy" },
    ],
  },
  {
    name: "TUPLE_APEXX",
    parts: [
      {
        file: "apexx/classes/AccountSignalProvider.clsx",
        member: "calculate",
        header: "// AccountSignalProvider.clsx",
      },
      {
        file: "apexx/classes/AccountSignalConsumer.clsx",
        member: "buildResult",
        header: "// AccountSignalConsumer.clsx",
      },
    ],
  },
  {
    name: "DEFAULT_APEXX",
    parts: [
      {
        text: [
          "// 1 · both defaults",
          "Boolean exactMatch = compareRevenue(left, right);",
          "",
          "// 2 · override the first default",
          "Boolean within1000 = compareRevenue(left, right, 1000);",
          "",
          "// 3 · override both defaults",
          "Boolean withinEither = compareRevenue(left, right, 250, 0.5);",
        ].join("\n"),
      },
      { file: ACCOUNT_SERVICE, member: "compareRevenue" },
    ],
  },
  {
    name: "DECORATOR_APEXX",
    parts: [
      { file: ACCOUNT_SERVICE, member: "triggerUserFriendlyError", annotations: true },
    ],
  },
  {
    name: "DECORATOR_IMPLEMENTATION",
    parts: [{ file: "apexx/classes/UserFriendlyError.clsx", whole: true }],
  },
  {
    name: "DECORATOR_CONTRACT",
    parts: [
      {
        file: "force-app/main/default/classes/ApexX.cls",
        members: ["Invocation", "Next", "Decorator"],
        header: "// ApexX.cls · the generated support contract",
      },
    ],
  },
  {
    name: "WORKFLOW_APEXX",
    parts: [
      {
        file: "apexx/classes/PortfolioRuleProvider.clsx",
        member: "resolve",
        header: "// PortfolioRuleProvider.clsx",
      },
      {
        file: ACCOUNT_SERVICE,
        member: "runPortfolioBriefing",
        annotations: true,
        header: "// AccountService.clsx · four of the class's thirteen decorated endpoints",
      },
      { file: ACCOUNT_SERVICE, member: "runEmailPipeline", annotations: true },
      { file: ACCOUNT_SERVICE, member: "runRenewalStrategy", annotations: true },
      { file: ACCOUNT_SERVICE, member: "runTupleDemo", annotations: true },
      { file: ACCOUNT_SERVICE, member: "buildSelectedWork" },
      { file: ACCOUNT_SERVICE, member: "buildPortfolioBriefing" },
    ],
  },
  {
    name: "SCRIPT_APEXX",
    parts: [
      {
        file: "apexx/scripts/AccountAudit.apexx",
        whole: true,
        header: "// apexx/scripts/AccountAudit.apexx",
        stripLeadingComments: true,
      },
    ],
  },
  {
    name: "SCRIPT_GENERATED",
    parts: [
      {
        file: "scripts/apex/AccountAudit.apex",
        whole: true,
        header: "// scripts/apex/AccountAudit.apex · Execute Anonymous, nothing deployed",
        stripLeadingComments: true,
      },
    ],
  },
];

const sources = new Map();

function read(relativePath) {
  if (!sources.has(relativePath)) {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute)) {
      fail(`Source is missing: ${relativePath}. Run npm run apexx -- build.`);
    }
    sources.set(relativePath, fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n"));
  }
  return sources.get(relativePath);
}

// Braces inside a string literal or a comment must not be counted, and the
// mask keeps every index aligned with the original so offsets stay usable.
function mask(source) {
  const masked = source.split("");
  let index = 0;

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      while (index < source.length && source[index] !== "\n") {
        masked[index++] = " ";
      }
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) {
        masked[index] = source[index] === "\n" ? "\n" : " ";
        index++;
      }
      continue;
    }

    if (source[index] === "'") {
      masked[index++] = " ";
      while (index < source.length && source[index] !== "'") {
        masked[index] = source[index] === "\\" ? " " : " ";
        if (source[index] === "\\") {
          masked[index + 1] = " ";
          index++;
        }
        index++;
      }
      if (index < source.length) {
        masked[index++] = " ";
      }
      continue;
    }

    index++;
  }

  return masked.join("");
}

function matchBrace(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index++) {
    if (masked[index] === "{") {
      depth++;
    } else if (masked[index] === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function lineStart(source, index) {
  const newline = source.lastIndexOf("\n", index);
  return newline === -1 ? 0 : newline + 1;
}

// Walks back over the annotation lines above a declaration, so a decorated
// method can be shown with the decorator that is the point of the panel.
function annotationStart(source, declarationStart) {
  let start = declarationStart;

  for (;;) {
    const previousStart = lineStart(source, start - 2);
    if (start === 0 || previousStart >= start) {
      return start;
    }
    const previousLine = source.slice(previousStart, start - 1).trim();
    if (!previousLine.startsWith("@")) {
      return start;
    }
    start = previousStart;
  }
}

const MODIFIER = /\b(?:public|private|protected|global|static|override|virtual|abstract|testmethod)\b/i;

function extractMember(relativePath, name, includeAnnotations) {
  const source = read(relativePath);
  const masked = mask(source);
  const declaration = new RegExp(`\\b${name}\\b\\s*[({]`, "g");
  let match;

  while ((match = declaration.exec(masked)) !== null) {
    const start = lineStart(source, match.index);
    // A declaration's own line carries the modifiers; a multi-line return type
    // is not used in these sources, so the line is enough to tell a
    // declaration from a call.
    const head = source.slice(start, match.index);
    if (!MODIFIER.test(head) && !/\b(?:class|interface|enum)\b/i.test(head)) {
      continue;
    }

    const open = masked.indexOf("{", match.index);
    if (open === -1) {
      continue;
    }
    const close = matchBrace(masked, open);
    if (close === -1) {
      fail(`Unbalanced braces reading ${name} from ${relativePath}.`);
    }

    const from = includeAnnotations ? annotationStart(source, start) : start;
    return dedent(source.slice(from, close + 1));
  }

  fail(`Could not find ${name} in ${relativePath}.`);
}

function extractWhole(relativePath, stripLeadingComments) {
  let source = read(relativePath).replace(/\s+$/, "");
  if (stripLeadingComments) {
    source = source.replace(/^(?:\s*\/\/[^\n]*\n)+\s*/, "");
  }
  return source;
}

function dedent(text) {
  const lines = text.split("\n");
  const indents = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.match(/^ */)[0].length);
  const shortest = Math.min(...indents);
  return lines
    .map(line => (line.length >= shortest ? line.slice(shortest) : line.trim()))
    .join("\n")
    .replace(/\s+$/, "");
}

function renderPart(part) {
  const body = part.text !== undefined
    ? part.text
    : part.whole
      ? extractWhole(part.file, part.stripLeadingComments)
      : (part.members ?? [part.member])
          .map(member => extractMember(part.file, member, part.annotations))
          .join("\n\n");

  return part.header ? `${part.header}\n${body}` : body;
}

function template(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const module = [
  "// AUTO-GENERATED BY scripts/build-showcase-snippets.mjs.",
  "// The ApexX shown in the showcase is sliced out of the authored sources, so a",
  "// panel cannot claim code the compiler would refuse. Regenerate with",
  "// `npm run showcase:snippets`; `npm run demo:check` fails when it is stale.",
  "// DO NOT EDIT.",
  "",
  ...SNIPPETS.map(snippet => {
    const body = snippet.parts.map(renderPart).join("\n\n");
    return `export const ${snippet.name} = \`${template(body)}\`;\n`;
  }),
].join("\n");

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== module) {
    fail(
      "showcaseSource.js is stale against the authored ApexX. Run npm run showcase:snippets.",
    );
  }
  console.log("Showcase snippets are in sync with the authored ApexX sources.");
} else {
  fs.writeFileSync(outputPath, module, "utf8");
  console.log(`Wrote ${path.relative(root, outputPath)}`);
  for (const snippet of SNIPPETS) {
    console.log(`  ${snippet.name}`);
  }
}

function fail(message) {
  console.error(`Showcase snippet build failed: ${message}`);
  process.exit(1);
}

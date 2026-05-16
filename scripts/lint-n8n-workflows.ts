#!/usr/bin/env bun
/**
 * n8n Workflow Linter
 * Checks exported workflow JSON files against a set of quality rules.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

const WORKFLOWS_DIR =
  process.argv[2] ??
  join(import.meta.dir, "../artifacts/n8n-workflows");

type Severity = "error" | "warning";
interface Finding {
  workflow: string;
  rule: string;
  severity: Severity;
  message: string;
}

const findings: Finding[] = [];

function report(
  workflow: string,
  rule: string,
  severity: Severity,
  message: string,
) {
  findings.push({ workflow, rule, severity, message });
}

async function lintWorkflow(filePath: string) {
  const raw = await readFile(filePath, "utf-8");
  const wf = JSON.parse(raw);
  const name: string = wf.name ?? basename(filePath, ".json");
  const nodes: any[] = wf.nodes ?? [];

  // Rule 1: Workflow has name
  if (!wf.name) {
    report(name, "has-name", "error", "Workflow is missing a 'name' field");
  }

  // Rule 2: Settings has timezone
  if (!wf.settings?.timezone) {
    report(
      name,
      "has-timezone",
      "error",
      "Workflow settings missing 'timezone'",
    );
  }

  // Rule 3: Telegram nodes have appendAttribution: false
  for (const node of nodes) {
    if (node.type?.includes("telegram")) {
      const aa =
        node.parameters?.additionalFields?.appendAttribution;
      if (aa !== false) {
        report(
          name,
          "telegram-no-attribution",
          "warning",
          `Telegram node "${node.name}" missing appendAttribution: false`,
        );
      }
    }
  }

  // Rule 4: Webhook auth not "none"
  for (const node of nodes) {
    if (node.type?.includes("webhook")) {
      const auth = node.parameters?.authentication;
      if (auth === "none") {
        report(
          name,
          "webhook-auth",
          "error",
          `Webhook node "${node.name}" has authentication set to "none"`,
        );
      }
    }
  }

  // Rule 5: HTTP Request nodes don't have tokens in URL
  for (const node of nodes) {
    if (node.type?.includes("httpRequest")) {
      const url: string = node.parameters?.url ?? "";
      if (/[?&](token|api_key|apikey|key|secret|access_token)=/i.test(url)) {
        report(
          name,
          "no-token-in-url",
          "warning",
          `HTTP Request node "${node.name}" may have a token in URL`,
        );
      }
    }
  }

  // Rule 6: At least one error-handling mechanism
  const hasTelegramNode = nodes.some((n) =>
    n.type?.includes("telegram"),
  );
  const hasErrorWorkflow = !!wf.settings?.errorWorkflow;
  if (!hasTelegramNode && !hasErrorWorkflow) {
    report(
      name,
      "has-error-handling",
      "warning",
      "Workflow has no error handling (no Telegram node and no errorWorkflow)",
    );
  }
}

// Main
const files = await readdir(WORKFLOWS_DIR);
const jsonFiles = files.filter((f) => f.endsWith(".json"));

if (jsonFiles.length === 0) {
  console.error(`No JSON files found in ${WORKFLOWS_DIR}`);
  process.exit(1);
}

for (const file of jsonFiles) {
  await lintWorkflow(join(WORKFLOWS_DIR, file));
}

// Output results
const errors = findings.filter((f) => f.severity === "error");
const warnings = findings.filter((f) => f.severity === "warning");

console.log(`Linted ${jsonFiles.length} workflow(s)\n`);

for (const f of findings) {
  const icon = f.severity === "error" ? "ERROR" : "WARN ";
  console.log(`  [${icon}] ${f.workflow}: ${f.message}`);
}

if (findings.length === 0) {
  console.log("  All checks passed.");
}

console.log(
  `\nSummary: ${errors.length} error(s), ${warnings.length} warning(s)`,
);

process.exit(errors.length > 0 ? 1 : 0);

#!/usr/bin/env bun

import { VERSION, APP_NAME } from "./constants";
import { listCommand } from "./commands/list";
import { selectCommand } from "./commands/select";
import { updateCommand } from "./commands/update";
import { configCommand } from "./commands/config";
import { completionCommand } from "./commands/completion";
import { uninstallCommand } from "./commands/uninstall";

const HELP_TEXT = `
${APP_NAME} v${VERSION}
CLI tool for managing multiple Claude Code / Codex CLI configurations

Usage:
  ${APP_NAME}                              Interactive provider selection
  ${APP_NAME} list [--type <type>]         List all providers (optionally filter by type)
  ${APP_NAME} config                       Open WebUI to manage providers
  ${APP_NAME} update                       Check for updates
  ${APP_NAME} uninstall                    Uninstall cc-use
  ${APP_NAME} completion <shell>           Generate shell completion script
  ${APP_NAME} --help                       Show this help message
  ${APP_NAME} --version                    Show version

Supported CLI Types:
  🟠 claude                               Claude Code
  🟢 codex                                Codex CLI

Examples:
  ${APP_NAME}                              # Interactive selection
  ${APP_NAME} list                         # List all providers
  ${APP_NAME} list --type claude           # List only Claude Code providers
  ${APP_NAME} config                       # Open WebUI to manage providers
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Handle flags
  if (command === "--help" || command === "-h") {
    console.log(HELP_TEXT);
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(`${APP_NAME} v${VERSION}`);
    return;
  }

  // Handle commands
  switch (command) {
    case "list":
    case "ls":
      listCommand(args.slice(1));
      break;

    case "config":
      await configCommand();
      break;

    case "update":
      await updateCommand();
      break;

    case "uninstall":
      await uninstallCommand();
      break;

    case "completion":
      completionCommand(args[1]);
      break;

    default:
      // Default: interactive selection
      // Pass all args (including any that look like commands) to CLI
      await selectCommand(args);
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

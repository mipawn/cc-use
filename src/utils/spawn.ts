import { spawn } from "child_process";
import type { Profile } from "../config/types";
import { CLI_TYPES } from "../config/types";
import { getMergedEnv } from "../config/storage";
import { getTerminalIcon, getColoredTypeName } from "./cli-icons";

export function launchCLI(profile: Profile, args: string[] = []): void {
  const cliConfig = CLI_TYPES[profile.type];

  if (!cliConfig) {
    console.error(`Unknown CLI type: ${profile.type}`);
    process.exit(1);
  }

  const icon = getTerminalIcon(profile.type);
  const typeName = getColoredTypeName(profile.type);

  console.log(`${icon} Launching ${typeName} with profile: ${profile.name}`);

  const mergedEnv = getMergedEnv(profile);

  const child = spawn(cliConfig.command, args, {
    env: { ...process.env, ...mergedEnv },
    stdio: "inherit",
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Error: '${cliConfig.command}' command not found. Please install ${cliConfig.displayName} first.`);
    } else {
      console.error(`Error launching ${cliConfig.command}:`, err.message);
    }
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

// 保留旧函数名以保持兼容性
export function launchClaude(profile: Profile, args: string[] = []): void {
  launchCLI(profile, args);
}

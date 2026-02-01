import { confirm } from "@inquirer/prompts";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync, unlinkSync, rmSync } from "fs";
import { APP_NAME, CONFIG_DIR } from "../constants";

const INSTALL_PATH = "/usr/local/bin/cc-use";

const COMPLETION_FILES = [
  join(homedir(), ".zsh/completions", `_${APP_NAME}`),
  join(homedir(), ".local/share/bash-completion/completions", APP_NAME),
  join(homedir(), ".config/fish/completions", `${APP_NAME}.fish`),
];

export async function uninstallCommand(): Promise<void> {
  console.log("\nThis will uninstall cc-use and remove:\n");
  console.log(`  • Binary: ${INSTALL_PATH}`);
  console.log(`  • Config: ${CONFIG_DIR}`);
  console.log(`  • Completion files\n`);

  const confirmed = await confirm({
    message: "Are you sure you want to uninstall cc-use?",
    default: false,
  });

  if (!confirmed) {
    console.log("Uninstall cancelled.");
    return;
  }

  // Remove completion files
  for (const file of COMPLETION_FILES) {
    if (existsSync(file)) {
      try {
        unlinkSync(file);
        console.log(`Removed: ${file}`);
      } catch {
        console.warn(`Warning: Could not remove ${file}`);
      }
    }
  }

  // Remove config directory
  if (existsSync(CONFIG_DIR)) {
    try {
      rmSync(CONFIG_DIR, { recursive: true });
      console.log(`Removed: ${CONFIG_DIR}`);
    } catch {
      console.warn(`Warning: Could not remove ${CONFIG_DIR}`);
    }
  }

  // Remove binary (needs sudo)
  if (existsSync(INSTALL_PATH)) {
    console.log(`\nRemoving binary (requires sudo)...`);
    try {
      execSync(`sudo rm "${INSTALL_PATH}"`, { stdio: "inherit" });
      console.log(`Removed: ${INSTALL_PATH}`);
    } catch {
      console.error(`\nFailed to remove binary. Try manually:\n`);
      console.error(`  sudo rm ${INSTALL_PATH}\n`);
    }
  }

  console.log("\n✓ cc-use uninstalled.");
  console.log("\nNote: If completions were added to ~/.zshrc, remove these lines manually:");
  console.log('  - Lines containing "cc-use completions"');
  console.log('  - Lines containing "fpath=(~/.zsh/completions"');
}

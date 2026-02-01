import { select, Separator } from "@inquirer/prompts";
import { getProviders } from "../config/storage";
import { launchCLI } from "../utils/spawn";
import { CLIType, CLI_TYPES } from "../config/types";
import { getTerminalIcon } from "../utils/cli-icons";

export async function selectCommand(args: string[]): Promise<void> {
  const providers = getProviders();

  if (providers.length === 0) {
    console.log("No providers configured. Use 'cc-use config' to manage providers.");
    return;
  }

  // 按类型分组
  const groupedProviders = new Map<CLIType, typeof providers>();
  for (const provider of providers) {
    const type = provider.type || 'claude';
    if (!groupedProviders.has(type)) {
      groupedProviders.set(type, []);
    }
    groupedProviders.get(type)!.push(provider);
  }

  // 构建带分隔符的选项列表
  const choices: Array<{ name: string; value: string } | Separator> = [];

  for (const [type, typeProviders] of groupedProviders) {
    const icon = getTerminalIcon(type);
    const displayName = CLI_TYPES[type]?.displayName || type;

    // 添加类型分隔符
    choices.push(new Separator(`── ${icon} ${displayName} ──`));

    // 添加该类型下的所有 providers
    for (const p of typeProviders) {
      choices.push({
        name: p.description ? `${p.name} - ${p.description}` : p.name,
        value: p.id,
      });
    }
  }

  const selectedId = await select({
    message: "Select a provider to use:",
    choices,
  });

  const provider = providers.find((p) => p.id === selectedId);
  if (!provider) {
    console.error(`Provider not found`);
    process.exit(1);
  }

  launchCLI(provider, args);
}

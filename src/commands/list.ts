import { getProviders, getProvidersByType, getCommon } from "../config/storage";
import { CLIType, CLI_TYPES } from "../config/types";
import { getTerminalIcon, getShortTypeLabel } from "../utils/cli-icons";

export function listCommand(args: string[] = []): void {
  // 解析 --type 参数
  let filterType: CLIType | undefined;
  const typeIndex = args.indexOf("--type");
  if (typeIndex !== -1 && args[typeIndex + 1]) {
    const typeArg = args[typeIndex + 1] as CLIType;
    if (CLI_TYPES[typeArg]) {
      filterType = typeArg;
    } else {
      console.error(`Unknown CLI type: ${typeArg}. Available types: ${Object.keys(CLI_TYPES).join(", ")}`);
      process.exit(1);
    }
  }

  const common = getCommon();
  const providers = filterType ? getProvidersByType(filterType) : getProviders();

  // Show common config if any (按类型分组显示)
  const hasCommon = Object.keys(common).some(key =>
    common[key as keyof typeof common] && Object.keys(common[key as keyof typeof common]!).length > 0
  );

  if (hasCommon) {
    console.log("Common environment variables:\n");

    // 显示 _global common
    if (common._global && Object.keys(common._global).length > 0) {
      console.log("  [Global]");
      for (const [key, value] of Object.entries(common._global)) {
        const displayValue = shouldMask(key) ? maskValue(value) : value;
        console.log(`    ${key}=${displayValue}`);
      }
    }

    // 显示各类型的 common
    for (const type of Object.keys(CLI_TYPES) as CLIType[]) {
      const typeCommon = common[type];
      if (typeCommon && Object.keys(typeCommon).length > 0) {
        const icon = getTerminalIcon(type);
        console.log(`  ${icon} [${CLI_TYPES[type].displayName}]`);
        for (const [key, value] of Object.entries(typeCommon)) {
          const displayValue = shouldMask(key) ? maskValue(value) : value;
          console.log(`    ${key}=${displayValue}`);
        }
      }
    }
    console.log();
  }

  if (providers.length === 0) {
    if (filterType) {
      console.log(`No ${CLI_TYPES[filterType].displayName} providers configured.`);
    } else {
      console.log("No providers configured. Use 'cc-use config' to manage providers.");
    }
    return;
  }

  console.log("Providers:\n");

  // 按类型分组显示
  const groupedProviders = new Map<CLIType, typeof providers>();
  for (const provider of providers) {
    const type = provider.type || 'claude';
    if (!groupedProviders.has(type)) {
      groupedProviders.set(type, []);
    }
    groupedProviders.get(type)!.push(provider);
  }

  for (const [type, typeProviders] of groupedProviders) {
    const typeLabel = getShortTypeLabel(type);
    console.log(`  ${typeLabel}`);

    for (const provider of typeProviders) {
      console.log(`    ${provider.name}`);
      if (provider.description) {
        console.log(`      Description: ${provider.description}`);
      }
      const envKeys = Object.keys(provider.env);
      if (envKeys.length > 0) {
        console.log(`      Environment variables:`);
        for (const [key, value] of Object.entries(provider.env)) {
          const displayValue = shouldMask(key) ? maskValue(value) : value;
          console.log(`        ${key}=${displayValue}`);
        }
      } else if (hasCommon) {
        console.log(`      (uses common config only)`);
      }
    }
    console.log();
  }
}

function shouldMask(key: string): boolean {
  const sensitivePatterns = ["token", "key", "secret", "password", "auth"];
  const lowerKey = key.toLowerCase();
  return sensitivePatterns.some((p) => lowerKey.includes(p));
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return value.slice(0, 4) + "****" + value.slice(-4);
}

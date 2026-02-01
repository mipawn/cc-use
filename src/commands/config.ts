import { ensureConfigDir, loadConfig } from "../config/storage";
import { startServer, PORT } from "../server";
import open from "open";

export async function configCommand(): Promise<void> {
  // Ensure config file exists
  ensureConfigDir();
  loadConfig(); // This will create default config if not exists

  console.log(`Starting cc-use WebUI server on port ${PORT}...`);

  try {
    const { url } = await startServer();
    console.log(`\n🚀 WebUI is running at: ${url}`);
    console.log(`\nPress Ctrl+C to stop the server.\n`);

    // Open browser
    await open(url);

    // Keep the process running
    await new Promise(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to start server: ${message}`);
    process.exit(1);
  }
}

// Development server - starts API server without opening browser
import { ensureConfigDir, loadConfig } from "../config/storage";
import { startServer, PORT } from "./index";

ensureConfigDir();
loadConfig();

console.log(`Starting cc-use API server on port ${PORT}...`);

try {
  await startServer();
  console.log(`\n🚀 API server is running at: http://localhost:${PORT}`);
  console.log(`\n📝 For development, open WebUI at: http://localhost:5173`);
  console.log(`   (Run 'bun run dev:webui' in another terminal)`);
  console.log(`\nPress Ctrl+C to stop the server.\n`);

  // Keep the process running
  await new Promise(() => {});
} catch (err) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error(`Failed to start server: ${message}`);
  process.exit(1);
}

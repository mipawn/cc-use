import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "bun";
import { providersRouter } from "./handlers/providers";
import { providerOrderRouter } from "./handlers/provider-order";
import { commonRouter } from "./handlers/common";
import { cliTypesRouter } from "./handlers/cli-types";
import { configRouter } from "./handlers/config";
import { serveStatic } from "./static";

const PORT = 9527;

export function createServer() {
  const app = new Hono();

  // Enable CORS for development
  app.use("/*", cors());

  // API routes
  app.route("/api/providers", providersRouter);
  app.route("/api/provider-order", providerOrderRouter);
  app.route("/api/common", commonRouter);
  app.route("/api/cli-types", cliTypesRouter);
  app.route("/api/config", configRouter);

  // Static files (WebUI)
  app.get("/*", serveStatic);

  return app;
}

export async function startServer(): Promise<{ url: string; close: () => void }> {
  const app = createServer();

  const server = serve({
    port: PORT,
    fetch: app.fetch,
  });

  const url = `http://localhost:${PORT}`;

  return {
    url,
    close: () => server.stop(),
  };
}

export { PORT };

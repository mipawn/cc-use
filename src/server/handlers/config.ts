import { Hono } from "hono";
import { exportConfig, importConfig } from "../../config/storage";
import { Config } from "../../config/types";

export const configRouter = new Hono();

// POST /api/config/export - 导出配置
configRouter.post("/export", (c) => {
  const config = exportConfig();
  return c.json(config);
});

// POST /api/config/import - 导入配置
configRouter.post("/import", async (c) => {
  try {
    const body = await c.req.json<{ config: Config; force?: boolean }>();

    if (!body.config) {
      return c.json({ error: "Config is required" }, 400);
    }

    const result = importConfig(body.config, body.force || false);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

import { Hono } from "hono";
import { CLI_TYPES } from "../../config/types";

export const cliTypesRouter = new Hono();

// GET /api/cli-types - 获取所有 CLI 类型
cliTypesRouter.get("/", (c) => {
  const types = Object.values(CLI_TYPES).map((config) => ({
    type: config.type,
    command: config.command,
    displayName: config.displayName,
    icon: config.icon.terminal,
  }));

  return c.json(types);
});

import { Hono } from "hono";
import {
  getCommon,
  getCommonForType,
  setCommonForType,
  updateCommonForType,
  removeCommonKeysForType,
} from "../../config/storage";
import { CLIType, CLI_TYPES } from "../../config/types";

export const commonRouter = new Hono();

type CommonType = CLIType | "_global";

function isValidCommonType(type: string): type is CommonType {
  return type === "_global" || type in CLI_TYPES;
}

// GET /api/common - 获取所有 common 配置
commonRouter.get("/", (c) => {
  return c.json(getCommon());
});

// GET /api/common/:type - 获取指定类型的 common 配置
commonRouter.get("/:type", (c) => {
  const type = c.req.param("type");

  if (!isValidCommonType(type)) {
    return c.json({ error: `Invalid common type: ${type}` }, 400);
  }

  return c.json(getCommonForType(type));
});

// PUT /api/common/:type - 更新指定类型的 common 配置 (完全替换)
commonRouter.put("/:type", async (c) => {
  try {
    const type = c.req.param("type");

    if (!isValidCommonType(type)) {
      return c.json({ error: `Invalid common type: ${type}` }, 400);
    }

    const body = await c.req.json<Record<string, string>>();
    setCommonForType(type, body);

    return c.json(getCommonForType(type));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// PATCH /api/common/:type - 部分更新指定类型的 common 配置
commonRouter.patch("/:type", async (c) => {
  try {
    const type = c.req.param("type");

    if (!isValidCommonType(type)) {
      return c.json({ error: `Invalid common type: ${type}` }, 400);
    }

    const body = await c.req.json<Record<string, string>>();
    updateCommonForType(type, body);

    return c.json(getCommonForType(type));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// DELETE /api/common/:type - 删除指定类型的某些 keys
commonRouter.delete("/:type", async (c) => {
  try {
    const type = c.req.param("type");

    if (!isValidCommonType(type)) {
      return c.json({ error: `Invalid common type: ${type}` }, 400);
    }

    const body = await c.req.json<{ keys: string[] }>();

    if (!body.keys || !Array.isArray(body.keys)) {
      return c.json({ error: "keys array is required" }, 400);
    }

    removeCommonKeysForType(type, body.keys);

    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

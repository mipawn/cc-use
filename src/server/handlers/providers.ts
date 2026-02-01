import { Hono } from "hono";
import {
  getProviders,
  getProvidersByType,
  getProvider,
  getProviderByName,
  addProvider,
  updateProvider,
  removeProvider,
  duplicateProvider,
} from "../../config/storage";
import { CLIType, CLI_TYPES, Provider } from "../../config/types";

export const providersRouter = new Hono();

// GET /api/providers - 获取所有 providers (可选 type 过滤)
providersRouter.get("/", (c) => {
  const type = c.req.query("type") as CLIType | undefined;

  if (type) {
    if (!CLI_TYPES[type]) {
      return c.json({ error: `Unknown CLI type: ${type}` }, 400);
    }
    return c.json(getProvidersByType(type));
  }

  return c.json(getProviders());
});

// GET /api/providers/:id - 获取单个 provider
providersRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const provider = getProvider(id);

  if (!provider) {
    return c.json({ error: `Provider "${id}" not found` }, 404);
  }

  return c.json(provider);
});

// POST /api/providers - 创建新 provider
providersRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<Partial<Provider>>();

    if (!body.name) {
      return c.json({ error: "Provider name is required" }, 400);
    }

    if (!body.type || !CLI_TYPES[body.type]) {
      return c.json({ error: "Valid CLI type is required" }, 400);
    }

    const provider = addProvider({
      name: body.name,
      type: body.type,
      description: body.description,
      websiteUrl: body.websiteUrl,
      env: body.env || {},
      usageConfig: body.usageConfig,
    });

    return c.json(provider, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// PUT /api/providers/:id - 更新 provider
providersRouter.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const existing = getProvider(id);

    if (!existing) {
      return c.json({ error: `Provider "${id}" not found` }, 404);
    }

    const body = await c.req.json<Partial<Provider>>();

    const updated = updateProvider(id, {
      name: body.name,
      type: body.type,
      description: body.description,
      websiteUrl: body.websiteUrl,
      env: body.env,
      order: body.order,
      usageConfig: body.usageConfig,
    });

    return c.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// DELETE /api/providers/:id - 删除 provider
providersRouter.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const existing = getProvider(id);

    if (!existing) {
      return c.json({ error: `Provider "${id}" not found` }, 404);
    }

    removeProvider(id);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// POST /api/providers/:id/duplicate - 复制 provider
providersRouter.post("/:id/duplicate", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ newName: string }>();

    if (!body.newName) {
      return c.json({ error: "New provider name is required" }, 400);
    }

    const duplicated = duplicateProvider(id, body.newName);
    return c.json(duplicated, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// POST /api/providers/:id/refresh-usage - 刷新用量
providersRouter.post("/:id/refresh-usage", async (c) => {
  try {
    const id = c.req.param("id");
    const provider = getProvider(id);

    if (!provider) {
      return c.json({ error: `Provider "${id}" not found` }, 404);
    }

    if (!provider.usageConfig?.enabled) {
      return c.json({ error: "Usage query not enabled for this provider" }, 400);
    }

    const { queryUsage } = await import("../../utils/usage");
    const usageData = await queryUsage(provider.usageConfig, provider.id);
    return c.json(usageData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// POST /api/providers/:id/test-connection - 测试 API 连接
providersRouter.post("/:id/test-connection", async (c) => {
  try {
    const id = c.req.param("id");
    const provider = getProvider(id);

    if (!provider) {
      return c.json({ error: `Provider "${id}" not found` }, 404);
    }

    // 简单测试：检查环境变量中是否有 API URL
    const baseUrl = provider.env.ANTHROPIC_BASE_URL || provider.env.OPENAI_BASE_URL;
    if (!baseUrl) {
      return c.json({ success: false, message: "No API URL configured" });
    }

    // 尝试连接
    try {
      const response = await fetch(baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return c.json({ success: response.ok, message: response.ok ? "Connection successful" : `HTTP ${response.status}` });
    } catch (fetchErr) {
      return c.json({ success: false, message: fetchErr instanceof Error ? fetchErr.message : "Connection failed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

// POST /api/providers/:id/test-usage - 测试用量查询
providersRouter.post("/:id/test-usage", async (c) => {
  try {
    const id = c.req.param("id");
    const provider = getProvider(id);

    if (!provider) {
      return c.json({ error: `Provider "${id}" not found` }, 404);
    }

    if (!provider.usageConfig?.enabled) {
      return c.json({ error: "Usage query not enabled for this provider" }, 400);
    }

    const { queryUsage } = await import("../../utils/usage");
    const usageData = await queryUsage(provider.usageConfig, provider.id);
    return c.json(usageData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

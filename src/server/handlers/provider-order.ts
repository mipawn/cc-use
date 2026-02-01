import { Hono } from "hono";
import { reorderProviders } from "../../config/storage";

export const providerOrderRouter = new Hono();

// PUT /api/provider-order - 更新 providers 排序
providerOrderRouter.put("/", async (c) => {
  try {
    const body = await c.req.json<{ orderedIds: string[] }>();

    if (!body.orderedIds || !Array.isArray(body.orderedIds)) {
      return c.json({ error: "orderedIds array is required" }, 400);
    }

    reorderProviders(body.orderedIds);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});

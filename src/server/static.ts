import type { Context } from "hono";

// 嵌入的 WebUI 静态文件 (构建时生成)
// 这个文件会在构建时被 scripts/embed-webui.ts 替换
let embeddedFiles: Record<string, { content: string; contentType: string }> = {};

// 尝试加载嵌入的 WebUI
try {
  const embedded = await import("./embedded-webui");
  embeddedFiles = embedded.files;
} catch {
  // 开发模式下没有嵌入的文件，使用占位符
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function getContentType(path: string): string {
  const ext = path.substring(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

// 开发模式下的 HTML 占位符
const DEV_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cc-switch WebUI</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; }
    p { font-size: 1.2rem; opacity: 0.9; }
    code {
      background: rgba(255,255,255,0.2);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
    }
    .api-info {
      margin-top: 2rem;
      text-align: left;
      background: rgba(0,0,0,0.2);
      padding: 1rem;
      border-radius: 8px;
    }
    .api-info h3 { margin-top: 0; }
    .api-info ul { margin: 0; padding-left: 1.5rem; }
    .api-info li { margin: 0.5rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔧 cc-switch WebUI</h1>
    <p>WebUI is not built yet.</p>
    <p>Run <code>bun run build:webui</code> to build the WebUI.</p>
    <div class="api-info">
      <h3>Available API Endpoints:</h3>
      <ul>
        <li>GET /api/profiles - List all profiles</li>
        <li>POST /api/profiles - Create profile</li>
        <li>PUT /api/profiles/:name - Update profile</li>
        <li>DELETE /api/profiles/:name - Delete profile</li>
        <li>GET /api/defaults - Get defaults</li>
        <li>PUT /api/defaults/:type - Update defaults</li>
        <li>GET /api/cli-types - Get CLI types</li>
        <li>POST /api/config/export - Export config</li>
        <li>POST /api/config/import - Import config</li>
      </ul>
    </div>
  </div>
</body>
</html>`;

export async function serveStatic(c: Context) {
  let path = c.req.path;

  // 默认返回 index.html
  if (path === "/" || path === "") {
    path = "/index.html";
  }

  // 移除开头的斜杠
  const filePath = path.startsWith("/") ? path.slice(1) : path;

  // 检查嵌入的文件
  if (embeddedFiles[filePath]) {
    const file = embeddedFiles[filePath];
    return new Response(Buffer.from(file.content, "base64"), {
      headers: { "Content-Type": file.contentType },
    });
  }

  // 对于 SPA，非 API 路由都返回 index.html
  if (!path.startsWith("/api") && !path.includes(".")) {
    if (embeddedFiles["index.html"]) {
      const file = embeddedFiles["index.html"];
      return new Response(Buffer.from(file.content, "base64"), {
        headers: { "Content-Type": file.contentType },
      });
    }
    // 开发模式返回占位符
    return new Response(DEV_HTML, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // 开发模式下返回占位符 HTML
  if (filePath === "index.html" && Object.keys(embeddedFiles).length === 0) {
    return new Response(DEV_HTML, {
      headers: { "Content-Type": "text/html" },
    });
  }

  return c.notFound();
}

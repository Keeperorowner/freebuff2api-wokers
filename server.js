import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 每账号代理出口：注入 undici ProxyAgent 工厂供 worker.js 使用（仅 Node 运行时；
// Cloudflare Workers 下无此工厂，worker 自动回退直连）。undici 缺失时优雅降级。
let ProxyAgent = null;
try {
  ({ ProxyAgent } = await import('undici'));
  globalThis.__freebuffProxyAgentFactory = (uri) => new ProxyAgent(uri);
  console.log('[server] per-account proxy support: ready (undici)');
} catch {
  console.warn('[server] undici not installed — per-account proxy disabled (run: npm install)');
}

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;

// === Build env from config ===

// Read tokens from credentials/ directory
const credDir = resolve(__dirname, 'credentials');
let tokenLines = [];
let accountList = [];
if (existsSync(credDir)) {
  for (const f of readdirSync(credDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(resolve(credDir, f), 'utf-8');
      const obj = JSON.parse(raw);
      // 单账号格式：顶层 authToken（credentials/<name>.json）
      if (obj.authToken) {
        tokenLines.push(obj.authToken.trim());
        accountList.push({ email: obj.email || '', authToken: obj.authToken.trim() });
      }
      // 多账号聚合格式（freebuff_credentials.json）：accounts.<key>.authToken
      if (obj.accounts && typeof obj.accounts === 'object') {
        for (const acct of Object.values(obj.accounts)) {
          if (acct && acct.authToken) {
            tokenLines.push(acct.authToken.trim());
            accountList.push({ email: acct.email || '', authToken: acct.authToken.trim() });
          }
        }
      }
    } catch (err) {
      console.error(`[server] skip bad credential ${f}: ${err.message}`);
    }
  }
}

// Also allow FREEBUFF_TOKEN env var for non-credential token sources
const envToken = process.env.FREEBUFF_TOKEN || '';
if (envToken) {
  for (const tok of envToken.split(/[\n,]/)) {
    const t = tok.trim();
    if (t && !tokenLines.includes(t)) tokenLines.push(t);
  }
}

const env = {
  FREEBUFF_TOKEN: tokenLines.join(','),
  FREEBUFF_ACCOUNTS: accountList.length > 0 ? JSON.stringify(accountList) : '',
  FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
  RELAY_KEY: process.env.RELAY_KEY || '',
  // 每账号代理出口（mihomo 多监听端口）
  PROXY_ENABLED: process.env.PROXY_ENABLED || '',
  PROXY_HOST: process.env.PROXY_HOST || 'mihomo',
  PROXY_PORT_BASE: process.env.PROXY_PORT_BASE || '24001',
  PROXY_REGIONS: process.env.PROXY_REGIONS || '',
  ADMIN_KEY: process.env.ADMIN_KEY || '',
};

// admin 面板设置持久化（容器层 settings.json：restart 保留，rebuild 重置为 .env 默认）
const settingsPath = resolve(__dirname, 'settings.json');
try {
  if (existsSync(settingsPath)) {
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (s && typeof s === 'object') env.ADMIN_SETTINGS = JSON.stringify(s);
  }
} catch (err) {
  console.warn('[server] settings.json unreadable, using defaults:', err.message);
}
env.ADMIN_SETTINGS = env.ADMIN_SETTINGS || '';
globalThis.__freebuffSettingsWriter = (json) => {
  try { writeFileSync(settingsPath, String(json), 'utf-8'); } catch (err) {
    console.error('[server] settings write failed:', err.message);
  }
};

console.log(`[server] start: ${tokenLines.length} tokens, apiKey=${env.FREEBUFF_API_KEY.slice(0,8)}..., debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log(`[server] CODEBUFF_API=${env.CODEBUFF_API}`);
if (env.RELAY_KEY) console.log(`[server] RELAY_KEY set`);
if (ProxyAgent && (process.env.PROXY_ENABLED === '1' || process.env.PROXY_ENABLED === 'true')) {
  console.log(`[server] per-account proxy: enabled via ${env.PROXY_HOST} (port base ${env.PROXY_PORT_BASE}, regions: ${env.PROXY_REGIONS || 'default'})`);
}

// === HTTP server ===
const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    // Build array of raw bytes from Node request
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build a CF-compatible Request
    const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
    });

    // Call the worker's fetch handler
    const response = await handler.fetch(request, env);

    // Write response back to Node socket
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch (err) {
        // Stream errors are expected on client disconnect
        if (!nodeRes.writableEnded) nodeRes.end();
        return;
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (err) {
    console.error('[server] request error:', err.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`[server] listening on ${host}:${port}`);
});
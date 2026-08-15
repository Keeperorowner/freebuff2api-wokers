import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load worker module
const worker = await import('./worker.js');
const handler = worker.default;

// === Build env from config ===

// Read tokens from credentials/ directory
const credDir = resolve(__dirname, 'credentials');
let tokenLines = [];
if (existsSync(credDir)) {
  for (const f of readdirSync(credDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(resolve(credDir, f), 'utf-8');
      const obj = JSON.parse(raw);
      // 单账号格式：顶层 authToken（credentials/<name>.json）
      if (obj.authToken) tokenLines.push(obj.authToken.trim());
      // 多账号聚合格式（freebuff_credentials.json）：accounts.<key>.authToken
      if (obj.accounts && typeof obj.accounts === 'object') {
        for (const acct of Object.values(obj.accounts)) {
          if (acct && acct.authToken) tokenLines.push(acct.authToken.trim());
        }
      }
    } catch (err) {
      console.error(`[server] skip bad credential ${f}: ${err.message}`);
    }
  }
}

// === Per-account proxy mapping (feat/proxy-accounts) ===
// 与本地 extract_freebuff.py 的 proxy 字段一致：每个账号可配 http/https/socks5 出口。
// 默认关闭（FREE_PROXY_ACCOUNTS != 1 时完全直连，行为与原来一致）。
const tokenProxyMap = new Map(); // token -> proxy string ('' = direct)
const accountRecords = [];       // panel 展示用（不带 authToken 明文）
function readAccountsProxy() {
  tokenProxyMap.clear();
  accountRecords.length = 0;
  if (!existsSync(credDir)) return;
  for (const f of readdirSync(credDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(readFileSync(resolve(credDir, f), 'utf-8'));
      if (obj.accounts && typeof obj.accounts === 'object') {
        for (const [key, acct] of Object.entries(obj.accounts)) {
          if (!acct || !acct.authToken) continue;
          const tok = String(acct.authToken).trim();
          tokenProxyMap.set(tok, String(acct.proxy || '').trim());
          accountRecords.push({ key, email: acct.email || '?', hasToken: !!tok, proxy: String(acct.proxy || '') });
        }
      }
    } catch (err) {
      console.error(`[server] skip bad credential ${f}: ${err.message}`);
    }
  }
}
readAccountsProxy();

const PROXY_ACCOUNTS = process.env.FREE_PROXY_ACCOUNTS === '1';

// undici 代理派发：http/https 用 ProxyAgent；socks5 需要 undici 支持或自定义 dispatcher。
// 这里采用轻量做法：HTTP(S) 用 undici ProxyAgent；SOCKS5 提示需要 socks 包（可后续扩展）。
let undiciMod = null;
let proxyDispatchReady = false;
let dispatchError = '';
async function buildProxyDispatch(proxyUrl) {
  try {
    if (!proxyUrl) return null;
    if (/^(socks4|socks5|socks5h):\/\//i.test(proxyUrl)) {
      dispatchError = `socks5 出口暂未接入（proxy=${proxyUrl}），先用 http/https 代理测试`;
      return null;
    }
    if (!undiciMod) undiciMod = await import('undici');
    if (process.env.FREEBUFF_DEBUG === 'true') console.error(`[proxy] building agent for ${proxyUrl}, undici=${typeof undiciMod.ProxyAgent}`);
    const agent = new undiciMod.ProxyAgent(proxyUrl);
    return agent;
  } catch (e) {
    dispatchError = `proxy agent 构建失败: ${e.message}`;
    return null;
  }
}

// 若开启按账号代理，则包装全局 fetch 让 worker.js 的上游请求走对应出口。
const originalFetch = globalThis.fetch;
if (PROXY_ACCOUNTS) {
  const dispatcherCache = new Map(); // proxy -> dispatcher
  globalThis.fetch = (input, init) => {
    const url = resolveFetchUrl(input);
    const headers = (init && init.headers) ? new Headers(init.headers) : (input instanceof Request ? input.headers : new Headers());
    const auth = headers.get('authorization') || '';
    const m = /Bearer\s+(\S+)/i.exec(auth);
    let proxy = '';
    if (m) proxy = tokenProxyMap.get(m[1]) || '';
    if (process.env.FREEBUFF_DEBUG === 'true') {
      try {
        console.error(`[proxy] url=${url.slice(0,120)} auth=${m ? m[1].slice(0,8) + '...' : '(none)'} proxy=${proxy || '(direct)'} dispatchError=${dispatchError || ''}`);
      } catch { }
    }
    if (!proxy) return originalFetch(input, init);
    let d = dispatcherCache.get(proxy);
    if (!d) {
      if (process.env.FREEBUFF_DEBUG === 'true') console.error(`[proxy] no cached agent for ${proxy}, building…`);
      const p = buildProxyDispatch(proxy);
      if (p && typeof p.then === 'function') return p.then(dp => {
        dispatcherCache.set(proxy, dp);
        if (process.env.FREEBUFF_DEBUG === 'true') console.error(`[proxy] dispatch via ${proxy} dp=${dp ? 'set' : 'NULL'}`);
        return dp ? originalFetch(input, { ...init, dispatcher: dp }) : originalFetch(input, init);
      }).catch(err => {
        if (process.env.FREEBUFF_DEBUG === 'true') console.error(`[proxy] agent build failed: ${err.message}`);
        return originalFetch(input, init);
      });
      dispatcherCache.set(proxy, p);
      d = p;
    }
    if (!d) return originalFetch(input, init);
    return originalFetch(input, { ...init, dispatcher: d });
  };
  proxyDispatchReady = true;
}

function resolveFetchUrl(input) {
  try { return input instanceof Request ? input.url : String(input); }
  catch { return String(input); }
}

function verifyProxy(proxyUrl) {
  try {
    if (!proxyUrl) return { ok: true, detail: '未设置（直连）' };
    const u = new URL(proxyUrl);
    if (!/^https?:$/i.test(u.protocol) && !/^socks5?:$/i.test(u.protocol)) {
      return { ok: false, detail: `不支持的协议 ${u.protocol}` };
    }
    return { ok: true, detail: `${u.protocol}//${u.host}` };
  } catch (e) {
    return { ok: false, detail: 'URL 非法: ' + e.message };
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
  FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
  RELAY_KEY: process.env.RELAY_KEY || '',
};

console.log(`[server] start: ${tokenLines.length} tokens, apiKey=${env.FREEBUFF_API_KEY.slice(0,8)}..., debug=${env.FREEBUFF_DEBUG}`);
if (env.CODEBUFF_API) console.log(`[server] CODEBUFF_API=${env.CODEBUFF_API}`);
if (env.RELAY_KEY) console.log(`[server] RELAY_KEY set`);

// === HTTP server ===
const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';

const PANEL_HTML = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>freebuff2api 账号面板</title></head><body><h1>freebuff2api 账号代理面板</h1><p id="status">加载中…</p><table id="t"><thead><tr><th>账号</th><th>邮箱</th><th>转发(代理)</th><th>操作</th></tr></thead><tbody></tbody></table><script>
async function load(){const r=await fetch('/api/accounts');const d=await r.json();document.getElementById('status').textContent=d.enabled?'按账号代理: 开启':'按账号代理: 关闭(直连) '+(d.dispatchError||'');const tb=document.querySelector('#t tbody');tb.innerHTML='';for(const a of d.accounts){const tr=document.createElement('tr');const td1=document.createElement('td');td1.textContent=a.key;const td2=document.createElement('td');td2.textContent=a.email;const td3=document.createElement('td');const inp=document.createElement('input');inp.size=32;inp.value=a.proxy;inp.placeholder='http://user:pass@host:port 或 socks5://host:port';const td3b=document.createElement('span');td3b.textContent=a.proxyValid?((a.proxy?('✅ '+a.proxyValid.detail):'直连')):('❌ '+a.proxyValid.detail);td3.append(inp,td3b);const td4=document.createElement('td');const btn=document.createElement('button');btn.textContent='保存';btn.onclick=async()=>{const resp=await fetch('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:a.key,proxy:inp.value})});const j=await resp.json();alert(j.ok?'已保存: '+j.proxy:(j.error||'保存失败'));load();};td4.appendChild(btn);tr.append(td1,td2,td3,td4);tb.appendChild(tr);}}
load();setInterval(load,30000);</script></body></html>`;

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const urlObj = new URL(nodeReq.url, `http://${nodeReq.headers.host || 'localhost'}`);
    if (urlObj.pathname === '/panel' || urlObj.pathname === '/') {
      nodeRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      nodeRes.end(PANEL_HTML);
      return;
    }
    if (urlObj.pathname === '/api/accounts') {
      if (nodeReq.method === 'GET') {
        nodeRes.writeHead(200, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ enabled: PROXY_ACCOUNTS, dispatchError, dispatchReady: proxyDispatchReady, accounts: accountRecords.map(a => ({ ...a, proxyValid: verifyProxy(a.proxy) })) }));
        return;
      }
      if (nodeReq.method === 'POST') {
        const chunks = [];
        for await (const chunk of nodeReq) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { }
        const key = String(body.key || '');
        const proxy = String(body.proxy || '').trim();
        if (!key) { nodeRes.writeHead(400, { 'content-type': 'application/json' }); nodeRes.end(JSON.stringify({ error: 'key 必填' })); return; }
        const v = verifyProxy(proxy);
        if (!v.ok) { nodeRes.writeHead(400, { 'content-type': 'application/json' }); nodeRes.end(JSON.stringify({ error: v.detail })); return; }
        let updated = false;
        for (const f of readdirSync(credDir)) {
          if (!f.endsWith('.json')) continue;
          const fp = resolve(credDir, f);
          const obj = JSON.parse(readFileSync(fp, 'utf-8'));
          if (obj.accounts && typeof obj.accounts === 'object' && key in obj.accounts) {
            obj.accounts[key].proxy = proxy;
            writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
            updated = true;
          }
        }
        readAccountsProxy();
        nodeRes.writeHead(updated ? 200 : 404, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify(updated ? { ok: true, key, proxy } : { error: '账号不存在' }));
        return;
      }
      nodeRes.writeHead(405, { 'content-type': 'application/json' }); nodeRes.end(JSON.stringify({ error: 'method not allowed' })); return;
    }

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
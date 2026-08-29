#!/usr/bin/env node
// 生成 mihomo 多区域出口配置：
//   1) 读 <dir>/.env 的 SUB_URL / PROXY_REGIONS_REQUEST / PROXY_PORT_BASE
//   2) 拉取订阅（失败回退本地缓存 providers/westdata.yaml），解析节点名
//   3) 只为「请求区域 ∩ 订阅里真实有节点的区域」生成 url-test 组 + HTTP 监听
//      （端口 = PROXY_PORT_BASE + 序号）
//   4) 把生效区域列表写回 .env 的 PROXY_REGIONS —— worker.js 据此绑定账号出口，
//      保证账号永远不会被路由到没有监听的端口
// 区域白名单 = freebuff 官方支持的国家（服务可用区域），HK/TW/JP/KR 不在内。
// 订阅地址只存在于本地文件（deploy/mihomo/config.yaml 已 gitignore），不入库。
// 用法：node scripts/gen-mihomo-config.mjs [部署目录（默认脚本仓库根）]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..');

// 区域 -> 订阅节点名过滤正则（中英双语，兼容常见命名）
const FILTERS = {
  US: 'United States|美国',
  CA: 'Canada|加拿大|多伦多|温哥华',
  UK: 'United Kingdom|英国|伦敦',
  AU: 'Australia|澳大利亚|澳洲|悉尼|墨尔本|珀斯',
  NZ: 'New Zealand|新西兰|奥克兰',
  NO: 'Norway|挪威|奥斯陆',
  SE: 'Sweden|瑞典|斯德哥尔摩',
  NL: 'Netherlands|荷兰|阿姆斯特丹',
  DK: 'Denmark|丹麦|哥本哈根',
  DE: 'Germany|德国|法兰克福',
  FR: 'France|法国|巴黎',
  IT: 'Italy|意大利|米兰|罗马',
  ES: 'Spain|西班牙|马德里',
  PT: 'Portugal|葡萄牙|里斯本',
  FI: 'Finland|芬兰|赫尔辛基',
  BE: 'Belgium|比利时|布鲁塞尔',
  LU: 'Luxembourg|卢森堡',
  LI: 'Liechtenstein|列支敦士登',
  CH: 'Switzerland|瑞士|苏黎世',
  AT: 'Austria|奥地利|维也纳',
  SG: 'Singapore|新加坡|狮城',
  MT: 'Malta|马耳他',
  IL: 'Israel|以色列|特拉维夫',
  IE: 'Ireland|爱尔兰|都柏林',
  IS: 'Iceland|冰岛|雷克雅未克',
};
const DEFAULT_REQUEST = 'US,CA,UK,AU,NZ,NO,SE,NL,DK,DE,FR,IT,ES,PT,FI,BE,LU,LI,CH,AT,SG,MT,IL,IE,IS';

function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// 只重写指定键，保留 .env 其余行
function writeEnv(path, kv) {
  const lines = existsSync(path) ? readFileSync(path, 'utf-8').split(/\r?\n/) : [];
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && kv[m[1]] !== undefined) {
      out.push(m[1] + '=' + kv[m[1]]);
      seen.add(m[1]);
    } else out.push(line);
  }
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(k + '=' + v);
  writeFileSync(path, out.join('\n'), 'utf-8');
}

const env = readEnv(resolve(root, '.env'));
const subUrl = env.SUB_URL || process.env.SUB_URL;
if (!subUrl) {
  console.error('error: SUB_URL not found in ' + resolve(root, '.env'));
  process.exit(1);
}
const requested = (env.PROXY_REGIONS_REQUEST || process.env.PROXY_REGIONS_REQUEST || DEFAULT_REQUEST)
  .split(',').map((s) => s.trim().toUpperCase()).filter((c) => FILTERS[c]);
const portBase = parseInt(env.PROXY_PORT_BASE || process.env.PROXY_PORT_BASE || '24001', 10) || 24001;

// 订阅内容：优先在线拉取，失败回退本地缓存
let subText = null;
try {
  const r = await fetch(subUrl, { headers: { 'User-Agent': 'clash-verge/1.6.0' }, signal: AbortSignal.timeout(20000) });
  if (r.ok) subText = await r.text();
  else console.warn('warn: 订阅拉取返回 HTTP ' + r.status + '，尝试本地缓存');
} catch (e) {
  console.warn('warn: 订阅拉取失败（' + String(e.message || e).slice(0, 80) + '），尝试本地缓存');
}
const cache = resolve(root, 'deploy/mihomo/providers/westdata.yaml');
if (!subText && existsSync(cache)) {
  subText = readFileSync(cache, 'utf-8');
  console.log('using cached subscription: ' + cache);
}
if (!subText) {
  console.error('error: 无法获取订阅（在线失败且无本地缓存）');
  process.exit(1);
}

// 解析节点名：只扫描 proxies 段（proxy-groups 之前），兼容 flow/block 两种写法
const proxiesPart = subText.split('proxy-groups:')[0];
const names = [...proxiesPart.matchAll(/name:\s*("[^"]*"|'[^']*'|[^,{\n]+)/g)]
  .map((m) => m[1].trim().replace(/^["']|["']$/g, '').trim())
  .filter((n) => n && !/^(Traffic|Expire)\s*:/i.test(n));
if (names.length === 0) {
  console.error('error: 订阅里没有解析到任何节点名');
  process.exit(1);
}

// 请求区域 ∩ 实际有节点的区域
const effective = [];
const regionCounts = {};
for (const code of requested) {
  const re = new RegExp(FILTERS[code], 'i');
  const n = names.filter((name) => re.test(name)).length;
  regionCounts[code] = n;
  if (n > 0) effective.push(code);
}
if (effective.length === 0) {
  console.error('error: 订阅中没有匹配任何请求区域的节点');
  console.error('requested: ' + requested.join(','));
  process.exit(1);
}

const groups = effective.map((r) =>
  `  - name: exit-${r}\n    type: url-test\n    use: [westdata]\n    filter: "(?i)${FILTERS[r]}"\n    url: https://www.gstatic.com/generate_204\n    interval: 600\n    tolerance: 80`
).join('\n');
const listeners = effective.map((r, i) =>
  `  - name: in-${r}\n    type: http\n    listen: 0.0.0.0\n    port: ${portBase + i}\n    proxy: exit-${r}`
).join('\n');

const yaml = `# 由 scripts/gen-mihomo-config.mjs 生成（勿手改；含订阅地址，不入库）
mode: rule
log-level: warning
external-controller: 0.0.0.0:9090

proxy-providers:
  westdata:
    type: http
    url: "${subUrl}"
    interval: 86400
    path: ./providers/westdata.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 600

proxy-groups:
${groups}

listeners:
${listeners}

rules:
  - MATCH,DIRECT
`;

const outDir = resolve(root, 'deploy/mihomo');
mkdirSync(resolve(outDir, 'providers'), { recursive: true });
writeFileSync(resolve(outDir, 'config.yaml'), yaml, 'utf-8');
// 生效区域写回 .env（worker 据此绑定账号出口；下次重跑脚本仍从 REQUEST 列表收敛）
writeEnv(resolve(root, '.env'), { PROXY_REGIONS: effective.join(',') });

console.log('written ' + resolve(outDir, 'config.yaml'));
console.log('effective regions: ' + effective.join(', ') + ' (ports ' + portBase + '-' + (portBase + effective.length - 1) + ')');
for (const code of requested) {
  console.log('  ' + code + ': ' + (regionCounts[code] > 0 ? regionCounts[code] + ' nodes' : 'no nodes, skipped'));
}

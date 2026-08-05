// 本地后端：给浏览器补上两件浏览器自己做不到的事
//   1. WebSocket 无法自定义 Authorization 头 -> 这里代理 /live/ws/live/connect
//   2. 隐藏 API Key，并绕开跨域限制
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } else {
    const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex <= 0) continue;
      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
} catch {
  // 没有 .env 就用进程环境变量
}

const API_KEY = process.env.VIDU_API_KEY || '';
const HOST = (process.env.VIDU_HOST || 'api.vidu.cn').replace(/^https?:\/\//, '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 5178);
const REC_DIR = path.resolve(ROOT, process.env.RECORDINGS_DIR || 'recordings');
const PUBLIC_DIR = path.join(ROOT, 'public');

await fsp.mkdir(REC_DIR, { recursive: true });

const authHeader = () => `Token ${API_KEY}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 把请求透传到 Vidu 开放平台，原样回传状态码与响应体
async function proxy(res, { method, apiPath, body, contentType = 'application/json' }) {
  if (!API_KEY) return sendJson(res, 500, { message: '未配置 VIDU_API_KEY，请在 .env 中填写后重启服务' });
  const url = `https://${HOST}${apiPath}`;
  try {
    const upstream = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(),
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    const text = await upstream.text();
    if (!upstream.ok) log(`↑ ${method} ${apiPath} -> ${upstream.status} ${text.slice(0, 300)}`);
    else log(`↑ ${method} ${apiPath} -> ${upstream.status}`);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    log(`↑ ${method} ${apiPath} 失败: ${err.message}`);
    sendJson(res, 502, { code: 502, reason: 'UPSTREAM_ERROR', message: err.message });
  }
}

// 图片上传三步走：建链接 -> PUT 二进制 -> finish 换 uri
async function uploadImage(req, res) {
  if (!API_KEY) return sendJson(res, 500, { message: '未配置 VIDU_API_KEY，请在 .env 中填写后重启服务' });
  const contentType = req.headers['content-type'] || 'image/png';
  const bytes = await readBody(req, 50 * 1024 * 1024);
  if (!bytes.length) return sendJson(res, 400, { message: '图片内容为空' });

  const mk = await fetch(`https://${HOST}/tools/v2/files/uploads`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'vidu' }),
  });
  if (!mk.ok) return sendJson(res, mk.status, { message: `创建上传链接失败: ${await mk.text()}` });
  const { id, put_url } = await mk.json();

  const put = await fetch(put_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes });
  if (!put.ok) return sendJson(res, 502, { message: `上传图片失败: ${put.status}` });
  const etag = (put.headers.get('etag') || '').replaceAll('"', '');

  const fin = await fetch(`https://${HOST}/tools/v2/files/uploads/${id}/finish`, {
    method: 'PUT',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag }),
  });
  const text = await fin.text();
  if (!fin.ok) return sendJson(res, fin.status, { message: `finish 失败: ${text}` });
  log(`图片上传完成 ${bytes.length} bytes -> ${text}`);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ ok: false, out: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// 录像落盘。ffmpeg 存在时顺带转 mp4，并用 ffprobe 校验音轨确实是单声道
async function saveRecording(req, res, url) {
  const raw = url.searchParams.get('name') || `demo-${Date.now()}.webm`;
  const safe = path.basename(raw).replace(/[^\w.\-]/g, '_');
  const webm = path.join(REC_DIR, safe.endsWith('.webm') ? safe : `${safe}.webm`);
  const wantMp4 = url.searchParams.get('mp4') !== '0';

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(webm);
    req.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    req.on('error', reject);
  });

  const size = (await fsp.stat(webm)).size;
  log(`录像已保存 ${webm} (${(size / 1e6).toFixed(1)} MB)`);
  const result = { webm, size, dir: REC_DIR };

  const probe = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels,codec_name,sample_rate',
    '-of', 'json', webm,
  ]);
  if (probe.ok) {
    try {
      const s = JSON.parse(probe.out).streams?.[0];
      if (s) result.audio = { channels: s.channels, codec: s.codec_name, sampleRate: s.sample_rate };
    } catch {}
  }

  if (wantMp4) {
    const mp4 = webm.replace(/\.webm$/, '.mp4');
    // -ac 1 兜底保证单声道；-r 30 -fps_mode cfr 把画布的可变帧率拍成恒定帧率
    const ff = await run('ffmpeg', [
      '-y', '-i', webm,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', '30', '-fps_mode', 'cfr',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '1',
      '-movflags', '+faststart', mp4,
    ]);
    if (ff.ok) {
      result.mp4 = mp4;
      log(`已转码 ${mp4}`);
    } else {
      result.mp4Error = ff.out.split('\n').slice(-6).join('\n');
      log(`转码失败: ${result.mp4Error}`);
    }
  }
  sendJson(res, 200, result);
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { message: 'forbidden' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/config') {
      return sendJson(res, 200, { host: HOST, hasKey: Boolean(API_KEY), recordingsDir: REC_DIR });
    }
    if (!p.startsWith('/api/')) return serveStatic(res, p);

    if (p === '/api/lives' && req.method === 'POST') {
      return proxy(res, { method: 'POST', apiPath: '/live/v1/lives', body: await readBody(req) });
    }
    if (p === '/api/lives' && req.method === 'GET') {
      return proxy(res, { method: 'GET', apiPath: `/live/v1/lives${url.search}` });
    }
    if (p.startsWith('/api/lives/') && req.method === 'GET') {
      const id = p.slice('/api/lives/'.length);
      return proxy(res, { method: 'GET', apiPath: `/live/v1/lives/${encodeURIComponent(id)}` });
    }
    if (p === '/api/voices' && req.method === 'GET') {
      return proxy(res, { method: 'GET', apiPath: '/live/v1/voices' });
    }
    if (p === '/api/voices/clone' && req.method === 'POST') {
      return proxy(res, { method: 'POST', apiPath: '/live/v1/voices/clone', body: await readBody(req) });
    }
    if (p === '/api/upload-image' && req.method === 'POST') {
      return uploadImage(req, res);
    }
    if (p === '/api/recordings' && req.method === 'POST') {
      return saveRecording(req, res, url);
    }
    return sendJson(res, 404, { message: `no route ${req.method} ${p}` });
  } catch (err) {
    log('请求处理异常', err);
    if (!res.headersSent) sendJson(res, 500, { message: err.message });
  }
});

// ---- WebSocket 代理：浏览器 -> 本地 -> Vidu（补 Authorization 头）----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/ws') return socket.destroy();
  if (!API_KEY) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (client) => {
    const liveId = url.searchParams.get('live_id') || '';
    const connId = url.searchParams.get('conn_id') || '';
    const qs = new URLSearchParams({ live_id: liveId });
    if (connId) qs.set('conn_id', connId);
    const upstreamUrl = `wss://${HOST}/live/ws/live/connect?${qs}`;
    log(`WS 打开 live_id=${liveId} -> ${upstreamUrl}`);

    const upstream = new WebSocket(upstreamUrl, { headers: { Authorization: authHeader() } });
    const pending = [];

    upstream.on('open', () => {
      log(`WS 上游已连接 live_id=${liveId}`);
      client.send(JSON.stringify({ __proxy: 'upstream_open' }));
      for (const { data, isBinary } of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => {
      const text = reason?.toString() || '';
      log(`WS 上游关闭 live_id=${liveId} code=${code} ${text}`);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ __proxy: 'upstream_close', code, reason: text }));
        // 1005/1006 等保留码不能直接转发，统一用 1000 关闭本地连接
        client.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 ? code : 1000, text.slice(0, 120));
      }
    });
    upstream.on('error', (err) => {
      log(`WS 上游错误 live_id=${liveId}: ${err.message}`);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ __proxy: 'upstream_error', message: err.message }));
      }
    });

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, isBinary });
    });
    client.on('close', () => {
      log(`WS 客户端关闭 live_id=${liveId}`);
      if (upstream.readyState <= WebSocket.OPEN) upstream.close(1000, 'client closed');
    });
    client.on('error', () => upstream.close());
  });
});

server.listen(PORT, () => {
  console.log(`\n  Vidu S1 demo recorder`);
  console.log(`  打开        http://localhost:${PORT}`);
  console.log(`  上游 host   ${HOST}`);
  console.log(`  API Key     ${API_KEY ? `已配置 (${API_KEY.slice(0, 8)}…)` : '缺失！请复制 .env.example 为 .env 并填写'}`);
  console.log(`  录像目录    ${REC_DIR}\n`);
});

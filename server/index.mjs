import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BridgeError, NotesService, MODEL, publicError } from './codex.mjs';
import { analyzeStudy, extractImage } from './study.mjs';
import { VaultService } from './vault.mjs';
import { AsrService } from './asr.mjs';

const DEFAULT_PORTS = [4317, 4318, 4319, 4482, 4416];
export function createBridge({ service = new NotesService(), vault = new VaultService(), asr = new AsrService(), port = 4319, allowedPorts = DEFAULT_PORTS } = {}) {
  const ports = new Set([...allowedPorts, port]);
  const origins = new Set([...ports].flatMap(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
  const hosts = new Set([...ports].flatMap(p => [`127.0.0.1:${p}`, `localhost:${p}`]));
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Vary', 'Origin');
    if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) return json(403, { code: 'FORBIDDEN_ORIGIN', message: '只允许听澜本机页面访问。' });
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tinglan-Client, X-Tinglan-Filename'); return res.writeHead(204).end(); }
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/api/health') return json(200, { ok: true, service: 'tinglan-codex-bridge', model: MODEL });
    if (req.method === 'POST' && (!req.headers.origin || req.headers['x-tinglan-client'] !== '1' || !req.headers['content-type']?.startsWith(['/api/library/upload', '/api/asr/transcribe'].includes(path) ? 'application/octet-stream' : 'application/json'))) return json(403, { code: 'FORBIDDEN_REQUEST', message: '请求未通过本机来源校验。' });
    try {
      if (req.method === 'GET' && path === '/api/asr/status') return json(200, await asr.status());
      if (req.method === 'POST' && path === '/api/asr/transcribe') {
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        req.once('aborted', () => controller.abort());
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
        const emit = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
        const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
        try { await asr.transcribe(req, new URL(req.url, 'http://localhost').searchParams.get('language'), emit, controller.signal); }
        catch (error) { emit({ type: 'error', ...publicError(error) }); }
        finally { clearInterval(heartbeat); res.end(); }
        return;
      }
      if (req.method === 'GET' && path === '/api/codex/status') return json(200, await service.status());
      if (req.method === 'GET' && path === '/api/library/status') return json(200, await vault.status());
      if (req.method === 'POST' && path === '/api/library/upload') return json(200, await vault.upload(req));
      if (req.method === 'POST' && path === '/api/library/finalize') {
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1500000) throw new BridgeError('TOO_LARGE', '学习笔记过大，请缩小范围。', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('BAD_INPUT', '学习笔记格式无效。', 400); }
        return json(200, await vault.finalize(body));
      }
      if (req.method === 'POST' && path === '/api/codex/login') return json(200, await service.login());
      if (req.method === 'POST' && ['/api/codex/notes', '/api/study/analyze', '/api/study/image'].includes(path)) {
        let bytes = 0, chunks = [];
        const limit = path === '/api/study/image' ? 12000000 : 1500000;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new BridgeError('TOO_LARGE', '提交内容超过单次上限，请减少资料数量或图片大小。', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError('BAD_INPUT', '请求不是有效的 JSON。', 400); }
        const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
        const emit = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
        const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
        try {
          emit({ type: 'status', message: path === '/api/study/image' ? 'Codex 正在读取图片…' : 'Codex 正在核对资料…' });
          const result = path === '/api/codex/notes' ? await service.generate(body, emit, controller.signal) : path === '/api/study/image' ? await extractImage(service, body, emit, controller.signal) : await analyzeStudy(service, body, emit, controller.signal);
          emit(path === '/api/codex/notes' ? { type: 'result', notes: result } : { type: 'result', result });
        }
        catch (error) { emit({ type: 'error', ...publicError(error) }); }
        finally { clearInterval(heartbeat); res.end(); }
        return;
      }
      return json(404, { code: 'NOT_FOUND', message: '接口不存在。' });
    } catch (error) { return json(error.status || 503, publicError(error)); }
  });
  server.requestTimeout = 300000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 100;
  return { server, service, listen: () => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)), close: () => { service.close(); asr.close(); server.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TINGLAN_BRIDGE_PORT || 4319);
  const extra = (process.env.TINGLAN_ALLOWED_PORTS || '').split(',').map(Number).filter(p => Number.isInteger(p) && p > 1024 && p < 65536);
  const bridge = createBridge({ port, allowedPorts: [...DEFAULT_PORTS, ...extra] });
  bridge.server.on('error', () => { console.error(`听澜 Codex 服务无法启动：请检查本机端口 ${port}。`); process.exitCode = 1; });
  await bridge.listen(); console.log(`Tinglan Codex bridge: http://127.0.0.1:${port}`);
  process.on('SIGINT', () => { bridge.close(); }); process.on('SIGTERM', () => { bridge.close(); });
}

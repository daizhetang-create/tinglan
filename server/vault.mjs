import { spawn } from 'node:child_process';
import { access, mkdtemp, open, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './codex.mjs';
import { normalizeSources, validateStudy } from './study.mjs';

export class VaultService {
  constructor(options = {}) {
    this.root = options.root || process.env.TINGLAN_LIBRARY_ROOT || join(homedir(), 'Documents', 'AI对话记忆系统', 'AI记忆库');
    this.ingest = options.ingest || process.env.TINGLAN_LIBRARY_INGEST || join(homedir(), 'Documents', 'AI对话记忆系统', 'AI记忆库', '06_更新系统', '日常库', 'ingest.py');
    this.python = options.python || process.env.TINGLAN_PYTHON || join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe');
    this.receipts = new Map(); this.active = false;
  }
  async status() {
    const configured = await Promise.all([this.root, this.ingest, this.python].map(p => access(p).then(() => true, () => false))).then(values => values.every(Boolean));
    return { configured, localOnly: true, message: configured ? '本机学习资料库已连接；仅归档你本次上传或选择的资料，不扫描私人目录。' : '尚未找到本机学习资料库或 Python；资料仍保存在浏览器，可导出完整备份。' };
  }
  run(script, args, body) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-X', 'utf8', script, ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let text = '', bytes = 0, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new BridgeError('VAULT_TIMEOUT', '资料归档超时，浏览器原件保留，请重试。', 504)); }, 120000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 2000000) { child.kill(); return; } text += chunk; });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { child.kill(); finish(new BridgeError('VAULT_FAILED', '归档助手提前停止，浏览器原件保留，请重试。')); });
      child.once('error', () => finish(new BridgeError('VAULT_OFFLINE', '本机资料库助手无法启动。', 503)));
      child.once('close', code => { if (code !== 0) return finish(new BridgeError('VAULT_FAILED', '资料库归档或校验未完成，浏览器原件保留，请重试。')); try { finish(null, JSON.parse(text)); } catch { finish(new BridgeError('VAULT_FAILED', '资料库未返回可验证的结果。')); } });
      child.stdin.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async upload(req) {
    if (!(await this.status()).configured) throw new BridgeError('VAULT_OFFLINE', '尚未连接本机学习资料库。', 503);
    if (this.active) throw new BridgeError('BUSY', '另一份资料正在归档，请稍后。', 429);
    let name; try { name = decodeURIComponent(String(req.headers['x-tinglan-filename'] || '')); } catch { throw new BridgeError('BAD_INPUT', '文件名无效。', 400); }
    const safeName = basename(name.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-160);
    if (!/\.(png|jpe?g|webp|txt|md|mp3|m4a|wav|webm|ogg|mp4)$/i.test(safeName)) throw new BridgeError('BAD_INPUT', '不支持归档此文件类型。', 400);
    this.active = true;
    let directory, path;
    try {
      directory = await mkdtemp(join(tmpdir(), 'tinglan-intake-')); path = join(directory, safeName);
      const file = await open(path, 'wx'), hash = createHash('sha256'); let bytes = 0;
      try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 512 * 1024 * 1024) throw new BridgeError('TOO_LARGE', '单份资料归档上限为 512 MB。', 413); hash.update(chunk); await file.writeFile(chunk); } await file.sync(); }
      finally { await file.close(); }
      if (!bytes) throw new BridgeError('BAD_INPUT', '不能归档空文件。', 400);
      const sha256 = hash.digest('hex');
      const result = await this.run(this.ingest, ['add', '--vault', this.root, '--category', '学习资料/听澜', '--', path]);
      const item = result.items?.find(x => x.sha256 === sha256 && ['ingested', 'duplicate'].includes(x.result));
      if (!item || typeof item.note !== 'string') throw new BridgeError('VAULT_FAILED', '资料未通过归档校验，浏览器原件保留。');
      for (const [key, receipt] of this.receipts) if (receipt.expires < Date.now()) this.receipts.delete(key);
      const ticket = randomUUID(); this.receipts.set(ticket, { sha256, note: item.note, state: item.state, expires: Date.now() + 600000 });
      return { ticket, sha256, note: item.note, state: item.state };
    } finally {
      this.active = false;
      // Only our freshly created staging copy is removed. The browser and vault originals remain.
      if (path) await unlink(path).catch(() => {}); if (directory) await rmdir(directory).catch(() => {});
    }
  }
  async finalize(body) {
    const receipt = this.receipts.get(body?.ticket);
    if (!receipt || receipt.expires < Date.now() || receipt.sha256 !== body.sha256) throw new BridgeError('VAULT_TICKET', '归档凭据已过期，请重新同步这份资料。', 400);
    const input = normalizeSources({ query: '保存已核对的学习笔记', sources: body.sources, courses: body.analysis?.courseName ? [body.analysis.courseName] : [] });
    const analysis = validateStudy(JSON.stringify(body.analysis), input);
    const result = await this.run(fileURLToPath(new URL('./vault_finalize.py', import.meta.url)), ['--vault', this.root, '--ingest', this.ingest], { sha256: receipt.sha256, note: receipt.note, sources: [...input.sources.values()], analysis, warnings: Array.isArray(body.warnings) ? body.warnings.filter(x => typeof x === 'string').slice(0, 100) : [] });
    if (result.sha256 !== receipt.sha256 || result.note !== receipt.note) throw new BridgeError('VAULT_FAILED', '笔记同步结果未通过校验。');
    this.receipts.delete(body.ticket);
    return { sha256: result.sha256, note: result.note, state: result.state };
  }
}

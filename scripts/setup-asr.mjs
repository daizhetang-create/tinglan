import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AsrService } from '../server/asr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', () => reject(new Error('未找到 Python。请先从 python.org 安装 Python 3.12（勾选 Add Python to PATH），再运行配置。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('本机转写配置未完成，请检查网络和 Python 版本。网站中的录音不会被删除。')));
  });
}
try {
  const existing = new AsrService();
  if ((await existing.status()).available) console.log('本机 Small 精校已可用，无需重复安装。');
  else {
    const known = join(homedir(), 'AppData/Local/Programs/Python/Python312/python.exe');
    const python = process.env.TINGLAN_PYTHON || (existsSync(known) ? known : process.platform === 'win32' ? 'python' : 'python3');
    const env = join(root, '.runtime/asr-venv'); mkdirSync(join(root, '.runtime'), { recursive: true });
    console.log('准备独立转写环境，不修改系统 Python 包。首次会下载依赖与约 500 MB 的 Small 模型。');
    await run(python, ['-m', 'venv', env]);
    const localPython = join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    await run(localPython, ['-m', 'pip', 'install', 'faster-whisper==1.2.1', 'av==18.0.0', 'ctranslate2==4.8.1']);
    await run(localPython, ['-X', 'utf8', '-c', "from faster_whisper.utils import download_model; download_model('small'); print('Small model cached')"]);
    if (!(await new AsrService({ python: localPython }).status()).available) throw new Error('安装完成但引擎自检失败，请保留终端提示并联系维护者。');
    if (!(await new AsrService().status()).available) throw new Error('独立环境已安装，但网站实际选用的 Python 未通过自检。请检查 TINGLAN_PYTHON：移除无效覆盖或指向 .runtime/asr-venv 中的 Python，再重新配置。原录音保留。');
    console.log('本机分窗精校配置成功。请保存录音并重启听澜以启用。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

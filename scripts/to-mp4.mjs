// 把 recordings/ 下的 webm 批量转成单声道音频的 mp4
// 用法: npm run mp4            转换所有还没有 mp4 的
//      npm run mp4 -- 文件名   只转指定文件
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegBin from 'ffmpeg-static';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}
const REC_DIR = path.resolve(ROOT, process.env.RECORDINGS_DIR || 'recordings');

const only = process.argv[2];
const files = (await fs.readdir(REC_DIR))
  .filter((f) => f.endsWith('.webm'))
  .filter((f) => !only || f === only || f === path.basename(only));

if (!files.length) {
  console.log(`${REC_DIR} 下没有待转换的 webm`);
  process.exit(0);
}

const ffmpeg = (args) =>
  new Promise((resolve) => {
    const bin = ffmpegBin || 'ffmpeg';
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    p.on('error', (e) => resolve(e.message));
    p.on('close', (code) => resolve(code === 0 ? null : `${bin} exit ${code}`));
  });

for (const f of files) {
  const src = path.join(REC_DIR, f);
  const dst = src.replace(/\.webm$/, '.mp4');
  if (!only) {
    try {
      await fs.access(dst);
      console.log(`跳过（已存在）${path.basename(dst)}`);
      continue;
    } catch {}
  }
  console.log(`转换 ${f} …`);
  const err = await ffmpeg([
    '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '1',
    '-movflags', '+faststart', dst,
  ]);
  console.log(err ? `  失败: ${err}` : `  完成 -> ${path.basename(dst)}`);
}

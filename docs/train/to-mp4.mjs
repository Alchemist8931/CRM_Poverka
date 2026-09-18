/* Конвертация роликов в mp4 (пункт docs-train).
 *
 *   node to-mp4.mjs [путь-к-ffmpeg]     # video/*.webm → video/mp4/*.mp4 + .srt, код 0 — все сконвертированы
 *
 * Ролик по заданию — 2–4 минуты. Запись идёт в реальном времени, и при
 * медленном стенде она выходит на десяток секунд длиннее; такой ролик здесь
 * ускоряется ровно настолько, чтобы уложиться в MAX_SEC, а времена в .srt
 * пересчитываются тем же коэффициентом. Ускорение до 10 % на записи экрана без
 * озвучки незаметно. Ролик длиннее MAX_SEC/0.9 — ошибка: его надо перезаписать. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { here } from './lib.mjs';

const MAX_SEC = 238;
const MIN_SEC = 120;
const dir = join(here, 'video');
const outDir = join(dir, 'mp4');
mkdirSync(outDir, { recursive: true });
const ffmpeg = process.argv[2] || process.env.FFMPEG || 'ffmpeg';
const ffprobe = ffmpeg.replace(/ffmpeg$/, 'ffprobe');

const duration = (f) => Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ts = (ms) => new Date(Math.max(0, Math.round(ms))).toISOString().slice(11, 23).replace('.', ',');
const parseTs = (s) => { const [h, m, rest] = s.split(':'); const [sec, ms] = rest.split(','); return ((+h * 60 + +m) * 60 + +sec) * 1000 + +ms; };

let bad = 0;
for (const name of readdirSync(dir).filter((f) => /^[a-z]+\.webm$/.test(f))) {
  const src = join(dir, name), role = name.replace(/\.webm$/, '');
  const dst = join(outDir, role + '.mp4');
  const secIn = duration(src);
  const k = Math.min(1, MAX_SEC / secIn);
  if (k < 0.9 || secIn < MIN_SEC) { console.error(`${role}: ${secIn.toFixed(1)} с — вне 2–4 минут, перезаписать`); bad++; continue; }
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', src, '-filter:v', `setpts=${k.toFixed(4)}*PTS`, '-r', '25',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst], { stdio: 'inherit' });
  const srt = join(dir, role + '.srt');
  if (existsSync(srt)) {
    /* Исходный .srt из video.mjs не трогаем: пересчитанный кладётся рядом с mp4. */
    if (k < 1) writeFileSync(join(outDir, role + '.srt'), readFileSync(srt, 'utf8').replace(
      /(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g, (_, a, b) => `${ts(parseTs(a) * k)} --> ${ts(parseTs(b) * k)}`));
    else copyFileSync(srt, join(outDir, role + '.srt'));
  }
  const secOut = duration(dst);
  if (secOut > 240 || secOut < MIN_SEC) { console.error(`${role}: mp4 ${secOut.toFixed(1)} с — вне 2–4 минут`); bad++; continue; }
  console.log(`${role}: ${secIn.toFixed(1)} с → ${secOut.toFixed(1)} с${k < 1 ? ` (×${(1 / k).toFixed(3)}, .srt пересчитан)` : ''}`);
}
process.exit(bad ? 1 : 0);

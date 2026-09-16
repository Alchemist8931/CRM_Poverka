/* Где взять браузер для проверок. Ставится playwright-core — без браузеров,
   поэтому путь либо задают переменной PLAYWRIGHT_CHROME, либо берём самый
   свежий chromium из кэша playwright. */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function chromePath() {
  if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
  const root = join(homedir(), '.cache', 'ms-playwright');
  const dir = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().at(-1);
  return join(root, dir, 'chrome-linux64', 'chrome');
}

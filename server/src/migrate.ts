/* Миграции в облаке — отдельным шагом выкладки, до перезапуска приложения.
 *
 *   npm run migrate:cloud        # внутри образа: docker compose run --rm api npm run migrate:cloud
 *
 * Отличается от `npm run migrate:up` одним: строку подключения не надо
 * подсовывать руками. Адрес и пароль берутся оттуда же, откуда их берёт само
 * приложение при старте, — из Lockbox по сервисному аккаунту ВМ (src/secrets.ts).
 * Значит, мигрируется ровно та база, с которой потом работает API, и пароль не
 * проходит через переменные выкладки.
 *
 * Почему отдельный шаг, а не миграции при старте API: на ВМ контейнер
 * перезапускается по любому поводу (падение, перезагрузка машины), и схему
 * при каждом таком перезапуске трогать нельзя. Порядок релиза — docs/release.md.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSecrets } from './secrets.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));

const loaded = await loadSecrets();
if (loaded.length) console.log(`Из Lockbox прочитано: ${loaded.join(', ')}`);
if (!process.env.DATABASE_URL) {
  throw new Error(
    'Не задана строка подключения: ни DATABASE_URL в окружении, ни LOCKBOX_DB_SECRET_ID '
    + 'для чтения из Lockbox. Проверьте /etc/uchetkin/app.env на машине.',
  );
}

// node-pg-migrate запускается так же, как в проверке схемы (scripts/check-schema.ts):
// своим процессом, с наследованным выводом — весь применяемый SQL уходит в журнал
// выкладки, и по нему видно, что именно накатилось.
const code = await new Promise<number>((resolve, reject) => {
  const child = spawn('npx', ['node-pg-migrate', 'up'], {
    cwd: appDir,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', reject);
  child.on('exit', (status) => resolve(status ?? 1));
});

process.exit(code);

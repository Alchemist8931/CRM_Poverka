/* Запуск приложения: соединение с базой, порт, аккуратная остановка.
 *
 *   npm start            — поднять API на PORT (по умолчанию 3000)
 *   docker compose up -d — то же самое рядом с базой
 */
import 'dotenv/config';
import { buildApp } from './app.ts';
import { pgDb } from './db.ts';
import { loadSecrets } from '../secrets.ts';
import { cabinetUrls } from '../novofon/config.ts';
import { startRecordings } from '../novofon/recordings.ts';

const port = Number(process.env.PORT || 3000);
// Внутри контейнера слушать localhost бессмысленно: снаружи до него не достучаться.
const host = process.env.HOST || '0.0.0.0';

// Пароль к базе и ключ подписи сессий приходят из Lockbox — до первого
// обращения к базе и до сборки приложения. На машине разработчика брать
// нечего: там всё уже в окружении, и шаг проходит впустую (src/secrets.ts).
const loaded = await loadSecrets();
if (loaded.length) console.log(`Из Lockbox прочитано: ${loaded.join(', ')}`);

const db = pgDb();
const app = await buildApp({ db, logger: true });

// Записи разговоров забираются фоном: событие о записи только помечает звонок,
// файл тянет очередь, а раз в сутки идёт сверка с журналом АТС.
const stopRecordings = startRecordings({
  db, store: app.records, api: app.novofon, log: (m, e) => app.log.warn({ err: e }, m),
});

// Адреса приёмников печатаются при старте нарочно. Они считаются от
// PUBLIC_BASE_URL, и в кабинете Новофон вписаны руками: при переезде на боевой
// домен строки из этого лога — и есть список того, что там надо заменить.
for (const { what, url } of cabinetUrls(app.novofonConfig)) app.log.info(`Новофон, ${what}: ${url}`);
if (!app.novofonConfig.publicBaseUrl) {
  app.log.warn('PUBLIC_BASE_URL не задан: адрес приёмника вебхуков показать нечем.');
}

// Балансировщик снимает экземпляр из-под нагрузки по TERM: сначала перестаём
// принимать запросы, потом закрываем соединения с базой.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}: останавливаемся`);
    stopRecordings();
    app.close().then(() => db.close()).then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ port, host });

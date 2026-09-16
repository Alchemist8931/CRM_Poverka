/* Запуск приложения: соединение с базой, порт, аккуратная остановка.
 *
 *   npm start            — поднять API на PORT (по умолчанию 3000)
 *   docker compose up -d — то же самое рядом с базой
 */
import 'dotenv/config';
import { buildApp } from './app.ts';
import { pgDb } from './db.ts';

const port = Number(process.env.PORT || 3000);
// Внутри контейнера слушать localhost бессмысленно: снаружи до него не достучаться.
const host = process.env.HOST || '0.0.0.0';

const db = pgDb();
const app = await buildApp({ db, logger: true });

// Балансировщик снимает экземпляр из-под нагрузки по TERM: сначала перестаём
// принимать запросы, потом закрываем соединения с базой.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}: останавливаемся`);
    app.close().then(() => db.close()).then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ port, host });

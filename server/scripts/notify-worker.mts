/* Проход очереди уведомлений (пункт int-notify).
 *
 *   npm run notify:tick            # поставить срочные события и отправить готовое
 *   npm run notify:tick -- --plan  # только поставить в очередь, ничего не отправлять
 *
 * Запускается таймером на машине приложения раз в четверть часа (пункт
 * cloud-ops, рядом с `audit:prune`). Чаще незачем: напоминание и утреннее
 * сообщение ставятся в очередь заранее, со своим сроком отправки, и проход
 * только забирает то, чему срок подошёл.
 *
 * Один проход делает три вещи по порядку:
 *   1) снимает с очереди то, что отправлять уже незачем (заявка отменена,
 *      согласие отозвано);
 *   2) ставит напоминания на завтра и утренние сообщения на сегодня;
 *   3) отправляет всё, чему подошёл срок, повторяя неудавшееся.
 *
 * Канал без ключей молчит, но очередь не теряет: сообщения дождутся настроек.
 */
import { pgDb } from '../src/api/db.ts';
import { notifyConfig, canSendEmail, canSendSms } from '../src/notify/config.ts';
import { notifiers } from '../src/notify/notifier.ts';
import { runOutbox, stuck } from '../src/notify/outbox.ts';
import { cancelStale, planMorning, planReminders } from '../src/notify/schedule.ts';

const planOnly = process.argv.includes('--plan');
const cfg = notifyConfig();
const db = pgDb();

try {
  const cancelled = await cancelStale(db);
  if (cancelled) console.log(`Снято с очереди: ${cancelled} (заявка отменена или согласие отозвано).`);

  const evening = await planReminders(db, cfg);
  const morning = await planMorning(db, cfg);
  console.log(`Напоминания на завтра: заявок ${evening.requests}, поставлено сообщений ${evening.queued}.`);
  console.log(`Окно прибытия на сегодня: заявок ${morning.requests}, поставлено сообщений ${morning.queued}.`);

  if (planOnly) {
    console.log('Отправка пропущена (--plan).');
  } else {
    if (!canSendEmail(cfg)) console.log('Почта не настроена (NOTIFY_FROM, SMTP_*): письма ждут в очереди.');
    if (!canSendSms(cfg)) console.log('СМС-шлюз не настроен (SMS_LOGIN, SMS_PASSWORD): сообщения ждут в очереди.');
    const result = await runOutbox(db, await notifiers(cfg), { cfg });
    console.log(`Отправлено: ${result.sent}, не прошло: ${result.failed}, отложено до настройки канала: ${result.skipped}.`);
  }

  const dead = await stuck(db, cfg);
  if (dead) console.log(`Внимание: сообщений с исчерпанными попытками — ${dead}. Экран «Уведомления» у руководителя.`);
} finally {
  await db.close();
}

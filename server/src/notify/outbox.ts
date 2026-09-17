/* Очередь отправки: повторы и журнал доставки.
 *
 * Почта и СМС-шлюз — чужие службы, и отказ у них дело обычное: истёк пароль
 * приложения, кончились деньги на счёте шлюза, у провайдера полчаса плохо.
 * Поэтому сообщение не отправляется из обработчика запроса. Обработчик кладёт
 * его в таблицу, а проход очереди (эта функция) забирает то, чему подошёл срок,
 * и пробует отправить.
 *
 * Что здесь важно и почему:
 *
 * — Строку занимаем одним UPDATE … RETURNING со сверкой счётчика попыток: кто
 *   успел увеличить его первым, тот и отправляет. Два прохода одновременно
 *   (таймер на ВМ и запуск руками) не отправят одно и то же дважды — у второго
 *   условие `attempts = прочитанное` уже не сойдётся, и строку он не получит.
 * — Повтор ждёт дольше с каждым разом: 10 минут, 20, 40, 80. Долбить упавший
 *   шлюз раз в минуту — верный способ получить от него блокировку.
 * — После `maxAttempts` сообщение останавливается в состоянии «ошибка» с
 *   последней причиной. Оно не исчезает: руководитель видит его на экране
 *   журнала, а причина написана словами шлюза.
 * — Каждая попытка пишется отдельной строкой в `notification_attempts`. Итог
 *   в очереди отвечает на вопрос «дошло ли», журнал — на вопрос «что было».
 */
import type { Db } from '../api/db.ts';
import type { Notifier } from './notifier.ts';
import type { Channel } from './templates.ts';
import { notifyConfig, type NotifyConfig } from './config.ts';

interface Due {
  id: number;
  channel: Channel;
  address: string;
  subject: string;
  body: string;
  attempts: number;
}

export interface OutboxResult {
  sent: number;
  failed: number;
  /** Сообщения, для которых канал не настроен: они остались ждать ключей. */
  skipped: number;
}

/** Пауза перед следующей попыткой в минутах: 10, 20, 40, 80… */
export const backoffMinutes = (attempts: number, base: number): number => base * 2 ** Math.max(0, attempts - 1);

/**
 * Один проход очереди.
 *
 * `senders` — отправители по каналам; `null` значит «канал не настроен».
 * Такое сообщение не трогаем вовсе: ни попытки, ни ошибки. Ключей от шлюза
 * нет — это не вина сообщения, и терять его из-за этого нельзя.
 */
export async function runOutbox(
  db: Db,
  senders: Partial<Record<Channel, Notifier | null>>,
  opts: { limit?: number; cfg?: NotifyConfig } = {},
): Promise<OutboxResult> {
  const cfg = opts.cfg ?? notifyConfig();
  const limit = opts.limit ?? 50;
  const out: OutboxResult = { sent: 0, failed: 0, skipped: 0 };

  const { rows: due } = await db.query<Due>(
    `SELECT id, channel, address, subject, body, attempts
       FROM notifications
      WHERE status IN ('в очереди', 'ошибка')
        AND attempts < $1
        AND send_after <= now()
      ORDER BY send_after
      LIMIT $2`, [cfg.maxAttempts, limit]);

  for (const row of due) {
    const sender = senders[row.channel] ?? null;
    if (!sender) { out.skipped++; continue; }

    // Занимаем строку: чужой проход её уже не возьмёт, а если этот упадёт
    // посреди отправки — строка останется с потраченной попыткой и сроком
    // повтора, а не в вечном «отправляется».
    const taken = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: number }>(
        `UPDATE notifications
            SET attempts = attempts + 1,
                send_after = now() + make_interval(mins => $2::int)
          WHERE id = $1 AND status IN ('в очереди', 'ошибка') AND attempts = $3
          RETURNING id`,
        [row.id, backoffMinutes(row.attempts + 1, cfg.retryMinutes), row.attempts]);
      return !!rows[0];
    });
    if (!taken) continue;

    try {
      const sent = await sender.send({ address: row.address, subject: row.subject, body: row.body });
      await db.query(
        `UPDATE notifications SET status = 'отправлено', sent_at = now(), provider_id = $2, last_error = NULL
          WHERE id = $1`, [row.id, sent.id]);
      await db.query(
        'INSERT INTO notification_attempts (notification_id, ok, response) VALUES ($1, true, $2)',
        [row.id, sent.response.slice(0, 2000)]);
      out.sent++;
    } catch (err) {
      const reason = (err as Error).message.slice(0, 2000);
      await db.query(`UPDATE notifications SET status = 'ошибка', last_error = $2 WHERE id = $1`, [row.id, reason]);
      await db.query(
        'INSERT INTO notification_attempts (notification_id, ok, response) VALUES ($1, false, $2)',
        [row.id, reason]);
      out.failed++;
    }
  }
  return out;
}

/** Сообщения, которые больше не будут отправлены: попытки кончились.
 *  Отдельным запросом, потому что это и есть то, о чём руководителю надо
 *  сказать вслух, — остальное система доделает сама. */
export async function stuck(db: Db, cfg: NotifyConfig = notifyConfig()): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications WHERE status = 'ошибка' AND attempts >= $1`,
    [cfg.maxAttempts]);
  return Number(rows[0]?.count ?? 0);
}

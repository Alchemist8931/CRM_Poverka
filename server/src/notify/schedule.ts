/* Кого сегодня надо предупредить: напоминание накануне и окно прибытия утром.
 *
 * Два события из четырёх привязаны не к действию человека, а ко времени, и
 * поставить их в очередь некому — приём заявки случился неделю назад. Их
 * ставит проход планировщика (`scripts/notify-worker.mts`), который на ВМ
 * запускается таймером раз в четверть часа.
 *
 * Отсюда устройство: планировщик смотрит вперёд, а не назад. Он ставит в
 * очередь все напоминания на завтрашние выезды и все утренние сообщения на
 * сегодняшние — со сроком отправки 18:00 и 8:00 по месту (его считает
 * `enqueue`). Дальше очередь сама решает, когда их отдать. Промахнуться мимо
 * минуты запуска при таком порядке нельзя: сообщение уже лежит и ждёт.
 *
 * Повторная постановка ничего не портит: ключ разбора в очереди уникален.
 */
import type { Db } from '../api/db.ts';
import { enqueue } from './events.ts';
import { notifyConfig, type NotifyConfig } from './config.ts';
import type { NotifyEvent } from './templates.ts';

/** Статусы, при которых клиента ещё есть смысл предупреждать: отменённую и
 *  выполненную заявку не напоминают, перенесённую напомнят по новой дате. */
const LIVE = ['создана', 'в маршруте', 'ожидание'];

async function idsFor(db: Db, event: NotifyEvent, tz: string): Promise<string[]> {
  // «Сегодня» считается по часовому поясу конторы, а не по часам машины: ВМ
  // стоит в UTC, и в её полночь у клиента ещё вчерашний вечер.
  const shift = event === 'напоминание' ? 1 : 0;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM requests
      WHERE date = (now() AT TIME ZONE $1)::date + $2::int
        AND notify_consent
        AND status = ANY($3)
      ORDER BY id`, [tz, shift, LIVE]);
  return rows.map((r) => r.id);
}

export interface PlanResult {
  /** Сколько сообщений добавилось в очередь; уже стоявшие не считаются. */
  queued: number;
  /** Сколько заявок просмотрено — видно, что планировщик вообще нашёл работу. */
  requests: number;
}

/** Напоминание накануне: завтрашние выезды, отправка в 18:00 сегодня. */
export async function planReminders(db: Db, cfg: NotifyConfig = notifyConfig()): Promise<PlanResult> {
  return planEvent(db, 'напоминание', cfg);
}

/** Утреннее сообщение: сегодняшние выезды, отправка в 8:00. Имя поверителя
 *  берётся из маршрута — к утру он уже собран; если нет, подстановка пустая,
 *  и клиент всё равно получает окно прибытия. */
export async function planMorning(db: Db, cfg: NotifyConfig = notifyConfig()): Promise<PlanResult> {
  return planEvent(db, 'выезд', cfg);
}

async function planEvent(db: Db, event: NotifyEvent, cfg: NotifyConfig): Promise<PlanResult> {
  const ids = await idsFor(db, event, cfg.timezone);
  let queued = 0;
  for (const id of ids) queued += (await enqueue(db, event, id, {}, cfg)).length;
  return { queued, requests: ids.length };
}

/** Снять с очереди то, что отправлять уже незачем: заявка отменена или клиент
 *  отозвал согласие. Сообщение не удаляется — остаётся след с причиной. */
export async function cancelStale(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE notifications n
        SET status = 'отменено',
            last_error = CASE WHEN r.notify_consent THEN 'заявка отменена' ELSE 'согласие отозвано' END
       FROM requests r
      WHERE r.id = n.request_id
        AND n.status IN ('в очереди', 'ошибка')
        AND (r.status = 'отменена' OR NOT r.notify_consent)
      RETURNING n.id`);
  return rows.length;
}

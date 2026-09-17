/* ФГИС «Аршин»: очередь передачи, выгрузка и ответ реестра (пункт int-arshin).
 *
 * Экран руководителя ходит сюда и никуда больше: очередь со статусами, текст
 * ошибки, повторная отправка, выгрузка за период. Записи создаются не здесь —
 * их создаёт закрытие акта (`routes/act.ts`), потому что запись о поверке
 * рождается вместе с самой поверкой, а не в момент, когда на неё посмотрели.
 *
 * Роль всюду одна — руководитель: передача сведений в фонд лежит на
 * аккредитованном лице, и отвечает за неё он.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { nextId } from '../store.ts';
import { arshinConfig, canSend, channelOf } from '../../arshin/config.ts';
import { ChannelOff, sendBatch } from '../../arshin/channel.ts';
import { ANSWER_WORKDAYS, DUE_WORKDAYS, draftsFor, problemsOf, subWorkdays } from '../../arshin/records.ts';
import { buildXml, fileNameOf, type ExportRecord } from '../../arshin/xml.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
const NUM_ID = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } as const;

/** Потолок одной выгрузки: личный кабинет ФГИС Росаккредитации принимает файлом
 *  не более 999 записей за раз, поэтому очередь режется на части. */
const BATCH_MAX = 999;

/** За сколько дней до срока очередь начинает предупреждать. Срок — 40 рабочих
 *  дней с даты поверки (пункт 21 приказа Минпромторга России № 2510), и неделя
 *  запаса оставляет время дозаполнить справочник и отправить повторно. */
const SOON_DAYS = 7;

interface Query { status?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }

const SELECT = `SELECT a.*, a.verified_on::text AS verified_on, a.valid_to::text AS valid_to,
       a.due_date::text AS due_date, r.city, r.name AS client_name, r.street, r.house, r.flat,
       d.position, d.device_type
  FROM arshin_records a
  JOIN requests r ON r.id = a.request_id
  JOIN devices d ON d.id = a.device_id`;

function where(q: Query): { sql: string; params: unknown[] } {
  return {
    sql: `($1::text IS NULL OR a.status = $1)
      AND ($2::date IS NULL OR a.verified_on >= $2::date)
      AND ($3::date IS NULL OR a.verified_on <= $3::date)
      AND ($4::text IS NULL OR a.serial ILIKE '%' || $4 || '%' OR a.request_id ILIKE '%' || $4 || '%'
           OR a.fgis_number ILIKE '%' || $4 || '%' OR a.mi_name ILIKE '%' || $4 || '%')`,
    params: [q.status || null, q.from || null, q.to || null, q.q || null],
  };
}

const toExport = (r: Record<string, unknown>): ExportRecord => ({
  id: String(r.id),
  mi_name: String(r.mi_name), mi_modification: String(r.mi_modification ?? ''),
  grsi: String(r.grsi ?? ''), serial: String(r.serial ?? ''),
  etalons: String(r.etalons ?? ''), method_doc: String(r.method_doc ?? ''),
  verified_on: String(r.verified_on), valid_to: r.valid_to ? String(r.valid_to) : null,
  applicable: !!r.applicable, fail_reason: String(r.fail_reason ?? ''),
  verifier_name: String(r.verifier_name ?? ''), owner_name: String(r.owner_name ?? ''),
});

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/arshin/queue', {
    schema: {
      tags: ['аршин'],
      summary: 'Очередь передачи во ФГИС «Аршин»: записи, статусы, ошибки и просрочка',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['готово', 'передано', 'принято', 'ошибка'] },
          from: DATE, to: DATE, q: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const q = req.query as Query;
    const { sql, params } = where(q);
    const { rows } = await app.db.query(
      `${SELECT} WHERE ${sql} ORDER BY a.due_date, a.id LIMIT $5 OFFSET $6`,
      [...params, q.limit ?? 200, q.offset ?? 0]);
    const { rows: count } = await app.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM arshin_records a WHERE ${sql}`, params);

    // Сводка считается по всей очереди, а не по показанному куску: руководителю
    // важно, сколько просрочено вообще, а не сколько видно на экране.
    // Ответ реестра ждём не дольше пяти рабочих дней (пункт 30 приказа № 2906).
    // Граница считается здесь, а не в SQL: рабочие дни — не арифметика дат.
    const answerBy = subWorkdays(new Date().toISOString().slice(0, 10), ANSWER_WORKDAYS);
    const { rows: sum } = await app.db.query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE status = 'готово')   AS ready,
              count(*) FILTER (WHERE status = 'передано') AS sent,
              count(*) FILTER (WHERE status = 'принято')  AS accepted,
              count(*) FILTER (WHERE status = 'ошибка')   AS failed,
              count(*) FILTER (WHERE status IN ('готово', 'ошибка') AND due_date < current_date) AS overdue,
              count(*) FILTER (WHERE status IN ('готово', 'ошибка')
                               AND due_date >= current_date
                               AND due_date <= current_date + $1::int) AS soon,
              count(*) FILTER (WHERE status = 'передано' AND sent_at < $2::date) AS silent
         FROM arshin_records`, [SOON_DAYS, answerBy]);
    const cfg = arshinConfig();
    return {
      records: rows,
      total: Number(count[0]?.n ?? 0),
      summary: Object.fromEntries(Object.entries(sum[0] ?? {}).map(([k, v]) => [k, Number(v)])),
      channel: channelOf(cfg),
      org_code: cfg.orgCode,
      due_workdays: DUE_WORKDAYS,
      answer_workdays: ANSWER_WORKDAYS,
      soon_days: SOON_DAYS,
    };
  });

  app.get('/arshin/batches', {
    schema: {
      tags: ['аршин'], summary: 'Выгрузки: чем и когда сведения уходили в реестр',
      security: [{ session: [] }],
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { limit } = req.query as { limit?: number };
    const { rows } = await app.db.query(
      `SELECT b.*, count(a.id) FILTER (WHERE a.status = 'принято') AS accepted,
              count(a.id) FILTER (WHERE a.status = 'ошибка') AS failed
         FROM arshin_batches b LEFT JOIN arshin_records a ON a.batch_id = b.id
        GROUP BY b.id ORDER BY b.created_at DESC LIMIT $1`, [limit ?? 50]);
    return { batches: rows };
  });

  /* ── выгрузка ───────────────────────────────────────────────── */

  app.post('/arshin/batches', {
    schema: {
      tags: ['аршин'],
      summary: 'Собрать выгрузку из готовых записей: файл или обращение к API — смотря что подключено',
      security: [{ session: [] }],
      body: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: BATCH_MAX, default: BATCH_MAX } },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { limit } = (req.body ?? {}) as { limit?: number };
    const cfg = arshinConfig();

    const { rows } = await app.db.query<Record<string, unknown>>(
      `${SELECT} WHERE a.status = 'готово' ORDER BY a.due_date, a.id LIMIT $1`, [limit ?? BATCH_MAX]);
    if (!rows.length) throw ruleError('Готовых к передаче записей нет.', 'empty');

    const batchId = await app.db.tx((db) => nextId(db, 'arshin_batches', 'A'));
    const xml = buildXml(rows.map(toExport), {
      orgName: cfg.orgName, orgCode: cfg.orgCode, batchId,
    });
    const channel = channelOf(cfg);

    await app.db.query(
      `INSERT INTO arshin_batches (id, channel, records, file_name, by_staff)
       VALUES ($1, $2, $3, $4, $5)`,
      [batchId, channel, rows.length, fileNameOf(batchId), user.id]);
    await app.db.query(
      `UPDATE arshin_records SET status = 'передано', batch_id = $2, sent_at = now(),
              attempts = attempts + 1, error_text = '', updated_at = now()
        WHERE id = ANY($1)`, [rows.map((r) => Number(r.id)), batchId]);

    // Файл руководитель загружает в кабинете сам, поэтому выгрузка сразу уходит
    // ему в ответе: второй раз её можно скачать по адресу файла выгрузки.
    if (!canSend(cfg)) {
      return { batch_id: batchId, channel, records: rows.length, file_name: fileNameOf(batchId), xml };
    }
    try {
      const outcome = await sendBatch(cfg, xml, batchId);
      await applyOutcome(batchId, outcome.accepted, outcome.failed);
      return {
        batch_id: batchId, channel, records: rows.length,
        accepted: outcome.accepted.length, failed: outcome.failed.length,
      };
    } catch (err) {
      const text = err instanceof ChannelOff ? err.message : String((err as Error).message ?? err);
      await app.db.query(
        `UPDATE arshin_batches SET status = 'ошибка', error_text = $2, answered_at = now() WHERE id = $1`,
        [batchId, text]);
      await app.db.query(
        `UPDATE arshin_records SET status = 'ошибка', error_text = $2, updated_at = now() WHERE batch_id = $1`,
        [batchId, text]);
      throw ruleError(`Реестр не принял выгрузку: ${text}`, 'channel');
    }
  });

  app.get('/arshin/batches/:id/file.xml', {
    schema: {
      tags: ['аршин'], summary: 'Скачать файл выгрузки заново', security: [{ session: [] }], params: ID,
    },
  }, async (req, reply) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const { rows: batches } = await app.db.query<{ id: string; created_at: string; org: string }>(
      'SELECT id, created_at FROM arshin_batches WHERE id = $1', [id]);
    if (!batches[0]) throw notFound(`Нет выгрузки «${id}».`);
    const { rows } = await app.db.query<Record<string, unknown>>(
      `${SELECT} WHERE a.batch_id = $1 ORDER BY a.id`, [id]);
    const cfg = arshinConfig();
    // Шифр и наименование берутся текущие: файл пересобирается, а не хранится
    // байт в байт — в реестр он уходит один раз, дальше это справка для человека.
    const xml = buildXml(rows.map(toExport), {
      orgName: String(rows[0]?.org_name ?? cfg.orgName), orgCode: String(rows[0]?.org_code ?? cfg.orgCode),
      batchId: id, created: new Date(batches[0].created_at),
    });
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileNameOf(id)}"`)
      .send(xml);
  });

  app.get('/arshin/export.xml', {
    schema: {
      tags: ['аршин'],
      summary: 'Выгрузка за период по дате поверки: тот же формат, статусы не меняются',
      security: [{ session: [] }],
      querystring: {
        type: 'object', required: ['from', 'to'],
        properties: { from: DATE, to: DATE, status: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    requireRole(req, 'supervisor');
    const q = req.query as Query;
    const { sql, params } = where(q);
    const { rows } = await app.db.query<Record<string, unknown>>(
      `${SELECT} WHERE ${sql} ORDER BY a.verified_on, a.id LIMIT ${BATCH_MAX}`, params);
    const cfg = arshinConfig();
    const batchId = `${q.from}_${q.to}`;
    const xml = buildXml(rows.map(toExport), { orgName: cfg.orgName, orgCode: cfg.orgCode, batchId });
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="arshin-${q.from}_${q.to}.xml"`)
      .send(xml);
  });

  /* ── ответ реестра ──────────────────────────────────────────── */

  /** Разбор ответа по записям: принятым — номер в реестре и отметка в приборе,
   *  непринятым — текст ошибки. Номер записи печатается в свидетельстве о
   *  поверке и в извещении о непригодности, поэтому он идёт в прибор. */
  async function applyOutcome(
    batchId: string,
    accepted: { source_id: string; number: string }[],
    failed: { source_id: string; error: string }[],
  ): Promise<{ accepted: number; failed: number }> {
    return app.db.tx(async (db) => {
      let ok = 0;
      for (const a of accepted) {
        if (!a.number) throw ruleError('Принятая запись без номера в реестре — это не приём.', 'number');
        const { rows } = await db.query<{ device_id: string }>(
          `UPDATE arshin_records SET status = 'принято', fgis_number = $2, error_text = '',
                  accepted_at = now(), updated_at = now()
            WHERE id = $1 AND batch_id = $3 RETURNING device_id`,
          [Number(a.source_id), a.number, batchId]);
        if (!rows[0]) continue;
        await db.query('UPDATE devices SET arshin_number = $2 WHERE id = $1', [rows[0].device_id, a.number]);
        ok++;
      }
      let bad = 0;
      for (const f of failed) {
        const { rows } = await db.query(
          `UPDATE arshin_records SET status = 'ошибка', error_text = $2, updated_at = now()
            WHERE id = $1 AND batch_id = $3 RETURNING id`,
          [Number(f.source_id), f.error || 'Реестр не принял запись без объяснения.', batchId]);
        bad += rows.length;
      }
      await db.query(
        `UPDATE arshin_batches SET status = $2, answered_at = now() WHERE id = $1`,
        [batchId, bad ? 'ошибка' : 'принята']);
      return { accepted: ok, failed: bad };
    });
  }

  app.post('/arshin/batches/:id/result', {
    schema: {
      tags: ['аршин'],
      summary: 'Ответ реестра на выгрузку: номера принятых записей и ошибки непринятых',
      security: [{ session: [] }], params: ID,
      body: {
        type: 'object',
        properties: {
          accepted: {
            type: 'array',
            items: {
              type: 'object', required: ['source_id', 'number'],
              properties: { source_id: { type: 'string' }, number: { type: 'string' } },
            },
          },
          failed: {
            type: 'array',
            items: {
              type: 'object', required: ['source_id'],
              properties: { source_id: { type: 'string' }, error: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as {
      accepted?: { source_id: string; number: string }[];
      failed?: { source_id: string; error?: string }[];
    };
    const { rows } = await app.db.query('SELECT id FROM arshin_batches WHERE id = $1', [id]);
    if (!rows[0]) throw notFound(`Нет выгрузки «${id}».`);
    const done = await applyOutcome(id, b.accepted ?? [],
      (b.failed ?? []).map((f) => ({ source_id: f.source_id, error: f.error ?? '' })));
    return { batch_id: id, ...done };
  });

  app.post('/arshin/records/:id/retry', {
    schema: {
      tags: ['аршин'],
      summary: 'Повторная отправка: запись пересобирается из акта и возвращается в очередь',
      security: [{ session: [] }], params: NUM_ID,
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: number };
    const { rows } = await app.db.query<{ request_id: string; device_id: string; status: string }>(
      'SELECT request_id, device_id, status FROM arshin_records WHERE id = $1', [id]);
    const rec = rows[0];
    if (!rec) throw notFound(`Нет записи о поверке №${id}.`);
    if (rec.status === 'принято') {
      throw ruleError('Запись уже в реестре: исправляют её в личном кабинете, а не повторной отправкой.', 'accepted');
    }
    // Пересобираем из акта: пока запись ждала, справочник могли дозаполнить, а
    // поверитель — поправить заводской номер. Отправлять прежний снимок значило
    // бы получить ту же ошибку второй раз.
    const cfg = arshinConfig();
    const draft = (await draftsFor(app.db, rec.request_id, cfg))
      .find((d) => String(d.device_id) === String(rec.device_id));
    if (!draft) throw ruleError('Строки прибора в акте больше нет — запись передавать не из чего.', 'device');
    const problems = problemsOf(draft);
    const { rows: back } = await app.db.query(
      `UPDATE arshin_records SET mi_name = $2, grsi = $3, serial = $4, etalons = $5, method_doc = $6,
              verified_on = $7, valid_to = $8, applicable = $9, org_name = $10, org_code = $11,
              verifier_id = $12, verifier_name = $13, fail_reason = $14,
              status = $15, error_text = $16, batch_id = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, draft.mi_name, draft.grsi, draft.serial, draft.etalons, draft.method_doc,
       draft.verified_on, draft.valid_to, draft.applicable, draft.org_name, draft.org_code,
       draft.verifier_id, draft.verifier_name, draft.fail_reason,
       problems.length ? 'ошибка' : 'готово',
       problems.length ? `Не заполнено: ${problems.join(', ')}.` : '']);
    return { record: back[0], problems };
  });
};

export default plugin;

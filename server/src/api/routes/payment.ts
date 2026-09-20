/* Эквайринг: QR и ссылка для поверителя, приёмник уведомлений провайдера,
 * сверка за день у руководителя, возвраты и отмены.
 *
 * Как это работает целиком (пункт int-pay, решение — «Учёткин — эквайринг и
 * фискализация, решение»):
 *
 *   акт ──«СБП по QR»──▶ POST /requests/:id/online-payment ──▶ провайдер ──▶ QR
 *   телефон ──GET /online-payments/:id/qr.svg──▶ картинка клиенту
 *   провайдер ──POST /webhooks/payment/:secret──▶ «оплачен» ──▶ чек ──▶ уведомление «чек»
 *   руководитель ──GET /online-payments?date──▶ сверка; export.csv ──▶ бухгалтеру
 *   руководитель ──POST /online-payments/:id/refund──▶ возврат с чеком
 *
 * Правила и переходы состояний — в src/payment/service.ts; здесь только
 * права, разбор запроса и ответ.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireRole, requireUser } from '../auth.ts';
import { ApiError, notFound, ruleError } from '../errors.ts';
import { actorOr403 } from '../store.ts';
import { canPay, canReceive, webhookUrl } from '../../payment/config.ts';
import { qrSvg } from '../../payment/qr.ts';
import {
  activeOf, applyEvent, cancelOnline, createOnlinePayment, onlineById, reconciliation, refreshReceipt,
  refundOnline, registerReceipt, syncOnline, type OnlinePayment,
} from '../../payment/service.ts';
import type { OnlineKind } from '../../rules.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } as const;

/** Поле CSV под Excel с русскими настройками — как у выгрузки журнала. */
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const local = (v: unknown): string => (v ? new Date(String(v)).toISOString().replace('T', ' ').slice(0, 19) : '');

const plugin: FastifyPluginAsync = async (app) => {
  const cfg = app.paymentConfig;
  const log = { warn: (o: unknown, m: string) => app.log.warn(o as object, m), error: (o: unknown, m: string) => app.log.error(o as object, m) };

  /** Провайдер или 503: без ключей эквайринг выключен, и это рабочее состояние. */
  const providerOr503 = () => {
    if (!app.payments || !canPay(cfg)) {
      throw new ApiError(503, 'Эквайринг не подключён к этому контуру: принимайте наличными или переводом.');
    }
    return app.payments;
  };

  /** Поверителю — платежи только по своим адресам; остальным — все. */
  const visibleOr403 = async (req: FastifyRequest, p: OnlinePayment) => {
    const user = requireUser(req);
    await actorOr403(app.db, user, p.request_id);
    return user;
  };

  app.get('/payments/config', {
    schema: {
      tags: ['деньги'],
      summary: 'Подключён ли эквайринг: какие безналичные способы показывать в акте',
      security: [{ session: [] }],
    },
  }, async (req) => {
    const user = requireUser(req);
    const enabled = !!app.payments && canPay(cfg);
    return {
      enabled,
      provider: enabled ? cfg.provider : null,
      kinds: enabled ? ['qr', 'link'] : [],
      // Адрес приёмника и коды чека показываются руководителю: их он вписывает
      // в кабинет провайдера и сверяет с бухгалтером.
      ...(user.role === 'supervisor' ? {
        webhook_url: webhookUrl(cfg), receiving: canReceive(cfg),
        tax_system: cfg.taxSystem, vat_code: cfg.vatCode, ttl_minutes: cfg.ttlMinutes,
      } : {}),
    };
  });

  app.post('/requests/:id/online-payment', {
    schema: {
      tags: ['деньги'],
      summary: 'Создать платёж на сумму акта: QR СБП или платёжная ссылка',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['qr', 'link'] } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const provider = providerOr503();
    const { id } = req.params as { id: string };
    const { kind } = req.body as { kind: OnlineKind };
    await actorOr403(app.db, user, id);
    const payment = await createOnlinePayment(app.db, provider, cfg, { requestId: id, kind, userId: user.id, log });
    return { payment, qr_url: kind === 'qr' ? `/api/online-payments/${payment.id}/qr.svg` : null };
  });

  app.get('/requests/:id/online-payment', {
    schema: {
      tags: ['деньги'], summary: 'Действующий платёж по заявке', security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await actorOr403(app.db, user, id);
    return { payment: await activeOf(app.db, id) };
  });

  app.get('/online-payments/:id', {
    schema: {
      tags: ['деньги'],
      summary: 'Состояние платежа. С sync=1 — спросить провайдера и применить ответ, как уведомление',
      security: [{ session: [] }],
      params: ID,
      querystring: { type: 'object', properties: { sync: { type: 'boolean', default: false } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: number };
    const { sync } = req.query as { sync?: boolean };
    let p = await onlineById(app.db, id);
    await visibleOr403(req, p);
    if (sync && app.payments) {
      p = await syncOnline(app.db, app.payments, cfg, id, log);
      if (p.receipt_id && p.receipt_status !== 'зарегистрирован') p = await refreshReceipt(app.db, app.payments, id, log);
    }
    return { payment: p, qr_url: p.kind === 'qr' ? `/api/online-payments/${p.id}/qr.svg` : null };
  });

  app.get('/online-payments/:id/qr.svg', {
    schema: { tags: ['деньги'], summary: 'QR-код платежа картинкой для экрана телефона', security: [{ session: [] }], params: ID },
  }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const p = await onlineById(app.db, id);
    await visibleOr403(req, p);
    if (p.kind !== 'qr' || !p.confirmation) throw notFound(`У платежа №${id} нет QR-кода.`);
    return reply.header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'private, max-age=300')
      .send(await qrSvg(p.confirmation));
  });

  /* ── руководитель: сверка, выгрузка, возврат, отмена ─────────────────── */

  app.get('/online-payments', {
    schema: {
      tags: ['деньги'],
      summary: 'Сверка эквайринга за день или период: платежи, чеки, возвраты, итоги — руководитель',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: { date: DATE, from: DATE, to: DATE, status: { type: 'string' } },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const q = req.query as { date?: string; from?: string; to?: string; status?: string };
    const today = new Date().toISOString().slice(0, 10);
    const from = q.from ?? q.date ?? today;
    const to = q.to ?? q.date ?? from;
    return { from, to, ...(await reconciliation(app.db, from, to, q.status)) };
  });

  app.get('/online-payments/export.csv', {
    schema: {
      tags: ['деньги'],
      summary: 'Выгрузка сверки для бухгалтера: CSV под Excel — руководитель',
      security: [{ session: [] }],
      querystring: { type: 'object', properties: { date: DATE, from: DATE, to: DATE, status: { type: 'string' } } },
    },
  }, async (req, reply) => {
    requireRole(req, 'supervisor');
    const q = req.query as { date?: string; from?: string; to?: string; status?: string };
    const today = new Date().toISOString().slice(0, 10);
    const from = q.from ?? q.date ?? today;
    const to = q.to ?? q.date ?? from;
    const { payments, totals } = await reconciliation(app.db, from, to, q.status);
    const head = ['Дата оплаты', 'Заявка', 'Дата выезда', 'Город', 'Адрес', 'Клиент', 'Тип клиента', 'Способ',
      'Сумма акта', 'Оплачено', 'Состояние', 'Платёж у провайдера', 'Чек №', 'Чек отправлен', 'Возврат', 'Причина возврата',
      'Чек возврата №', 'Расхождение', 'Кто показал', 'Кто отменил/вернул', 'Ошибка'];
    const lines = (payments as Record<string, unknown>[]).map((p) => [
      local(p.paid_at), p.request_id, p.request_date, p.city,
      `${p.street}, ${p.house}${p.flat ? ', кв. ' + p.flat : ''}`, p.name, p.client_type,
      p.kind === 'qr' ? 'СБП по QR' : 'платёжная ссылка',
      p.amount, p.paid_amount ?? '', p.status, p.external_id ?? '', p.receipt_number ?? '', local(p.receipt_sent_at),
      p.refund_amount ?? '', p.refund_reason ?? '', p.refund_receipt_number ?? '', p.mismatch ? 'да' : '',
      p.created_by_name ?? '', p.handled_by_name ?? '', p.error ?? '',
    ].map(cell).join(';'));
    const foot = ['Итого', '', '', '', '', '', '', '', '', totals.paid, `оплачено ${totals.n_paid}, чеков ${totals.n_receipts}`,
      '', '', '', totals.refunded, '', '', totals.n_mismatch ? `расхождений ${totals.n_mismatch}` : ''].map(cell).join(';');
    const csv = '﻿' + [head.join(';'), ...lines, foot].join('\r\n') + '\r\n';
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="acquiring-${from}${to !== from ? '_' + to : ''}.csv"`)
      .send(csv);
  });

  app.post('/online-payments/:id/cancel', {
    schema: { tags: ['деньги'], summary: 'Отменить неоплаченный платёж — только руководитель, с записью в журнал', security: [{ session: [] }], params: ID },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const provider = providerOr503();
    const { id } = req.params as { id: number };
    return { payment: await cancelOnline(app.db, provider, { id, userId: user.id, log }) };
  });

  app.post('/online-payments/:id/refund', {
    schema: {
      tags: ['деньги'], summary: 'Вернуть оплату клиенту с чеком возврата — только руководитель', security: [{ session: [] }], params: ID,
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 300 } } },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const provider = providerOr503();
    const { id } = req.params as { id: number };
    const { reason } = req.body as { reason: string };
    return { payment: await refundOnline(app.db, provider, cfg, { id, userId: user.id, reason, log }) };
  });

  app.post('/online-payments/:id/receipt', {
    schema: { tags: ['деньги'], summary: 'Пробить чек повторно, если касса его не приняла — руководитель', security: [{ session: [] }], params: ID },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const provider = providerOr503();
    const { id } = req.params as { id: number };
    const p = await onlineById(app.db, id);
    if (p.receipt_status === 'зарегистрирован') throw ruleError(`Чек по платежу №${id} уже зарегистрирован: № ${p.receipt_number}.`, 'receipt');
    const out = p.receipt_id ? await refreshReceipt(app.db, provider, id, log) : await registerReceipt(app.db, provider, cfg, id, log);
    return { payment: out };
  });

  /* ── приёмник уведомлений провайдера ─────────────────────────────────── */

  app.post('/webhooks/payment/:secret', {
    schema: {
      tags: ['деньги'],
      summary: 'Уведомление провайдера об оплате, отмене или возврате. Секрет в адресе, подтверждение — у провайдера',
      params: { type: 'object', required: ['secret'], properties: { secret: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { secret } = req.params as { secret: string };
    const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
    let ok = canReceive(cfg) && !!app.payments;
    let reason = ok ? '' : 'приёмник не настроен: нет PAYMENT_WEBHOOK_SECRET или ключей провайдера';
    if (ok && secret !== cfg.webhookSecret) { ok = false; reason = 'секрет в адресе не сходится'; }
    const verified = ok && app.payments ? await app.payments.verifyWebhook({ rawBody: raw, headers: req.headers as Record<string, unknown>, ip: req.ip }) : null;
    if (verified && !verified.ok) { ok = false; reason = verified.reason; }
    const ev = verified?.ok ? verified.event : verified?.event ?? null;
    const provider = app.payments?.name ?? cfg.provider ?? '—';
    const objectId = ev?.paymentId ?? ev?.refundId ?? null;
    // Ключ повтора: то же событие о том же объекте в том же состоянии второй
    // раз не обрабатывается, но записывается — по журналу видно, что провайдер
    // повторял доставку.
    const dedup = ok && ev ? `${provider}:${ev.event}:${objectId}:${ev.status}` : null;
    const { rows: seen } = await app.db.query<{ id: number }>(
      `INSERT INTO payment_events (provider, event, external_id, dedup_key, ok, reason, source_ip, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
      [provider, ev?.event ?? '—', objectId, dedup, ok, reason, req.ip, raw && raw.trim().startsWith('{') ? raw : JSON.stringify({ raw })]);
    if (!ok) {
      // Провайдер повторяет доставку при любом ответе, кроме 200: чужому
      // уведомлению 200 не даём, а некорректный запрос по секрету — 401/403.
      throw new ApiError(reason.includes('секрет') || reason.includes('адрес') ? 403 : 400, `Уведомление не принято: ${reason}`);
    }
    if (!seen[0]) {
      // Повторная доставка: в журнал — да (видно, что провайдер повторял),
      // в обработку — нет.
      await app.db.query(
        `INSERT INTO payment_events (provider, event, external_id, dedup_key, ok, reason, source_ip, payload)
         VALUES ($1, $2, $3, NULL, true, 'повторная доставка', $4, $5::jsonb)`,
        [provider, ev?.event ?? '—', objectId, req.ip, raw]);
      return reply.code(200).send({ accepted: true, applied: 'повтор' });
    }
    const out = await applyEvent(app.db, app.payments!, cfg, ev as never, log);
    return reply.code(200).send({ accepted: true, applied: out.applied });
  });
};

export default plugin;

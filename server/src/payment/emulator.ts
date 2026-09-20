/* Эмулятор ЮKassa: HTTP-интерфейс провайдера и кассы на свободном порту.
 *
 * Нужен там, где настоящего провайдера нет: в тестах, в сквозной проверке
 * (`npm run check:payment`) и на машине разработчика (`npm run payment:emulator`).
 * Притворяется самим API (те же адреса, те же поля, те же ошибки), а не
 * реализует интерфейс провайдера второй раз: так проверяется тот самый клиент
 * (yookassa.ts), который в облаке ходит к настоящему провайдеру.
 *
 * Что умеет: создать платёж (с ключом повтора), отдать его, отменить, вернуть,
 * зарегистрировать чек и «отправить» его на почту (запоминает письмо), прислать
 * уведомление об оплате на адрес приёмника. Оплата запускается вызовом `pay()`
 * из проверки или кнопкой на странице `/pay/<id>` — той самой, куда ведёт
 * платёжная ссылка.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface EmulatorOptions {
  shopId: string;
  secretKey: string;
  /** Куда слать уведомления. Не задан — уведомления не шлются, `pay()` только
   *  возвращает тело, которое приёмник получил бы. */
  webhookUrl?: string | null;
  port?: number;
  host?: string;
}

export interface EmPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid: boolean;
  amount: { value: string; currency: string };
  description: string;
  metadata: Record<string, string>;
  confirmation: { type: string; confirmation_data?: string; confirmation_url?: string };
  payment_method: { type: string };
  created_at: string;
  captured_at?: string;
  test: true;
}

export interface EmReceipt {
  id: string;
  type: 'payment' | 'refund';
  payment_id?: string;
  refund_id?: string;
  status: 'succeeded';
  fiscal_document_number: string;
  fiscal_storage_number: string;
  fiscal_attribute: string;
  fiscal_provider_id: string;
  registered_at: string;
  tax_system_code?: number;
  customer: { email?: string; phone?: string };
  items: unknown[];
  settlements: unknown[];
}

export interface EmRefund {
  id: string;
  status: 'succeeded';
  amount: { value: string; currency: string };
  payment_id: string;
  created_at: string;
}

export interface Mail { to: string; receipt_id: string; fiscal_document_number: string; kind: 'payment' | 'refund' }

export interface Emulator {
  url: string;
  payments: Map<string, EmPayment>;
  receipts: Map<string, EmReceipt>;
  refunds: Map<string, EmRefund>;
  /** Что касса «отправила» клиенту. */
  mails: Mail[];
  /** Все уведомления, которые эмулятор отправил или собрал. */
  notifications: unknown[];
  /** Клиент оплатил: платёж становится succeeded, уведомление уходит на приёмник. */
  pay(id: string): Promise<{ notification: unknown; delivered: number | null }>;
  stop(): Promise<void>;
}

const now = () => new Date().toISOString();

export function startEmulator(opts: EmulatorOptions): Promise<Emulator> {
  const payments = new Map<string, EmPayment>();
  const receipts = new Map<string, EmReceipt>();
  const refunds = new Map<string, EmRefund>();
  const mails: Mail[] = [];
  const notifications: unknown[] = [];
  const byKey = new Map<string, unknown>();
  let seq = 1000;
  let url = '';
  const auth = 'Basic ' + Buffer.from(`${opts.shopId}:${opts.secretKey}`).toString('base64');

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, code: number, description: string, parameter?: string) =>
    json(res, code, { type: 'error', id: randomUUID(), code: code === 404 ? 'not_found' : 'invalid_request', description, parameter });

  const read = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });

  async function notify(event: string, object: unknown): Promise<{ notification: unknown; delivered: number | null }> {
    const notification = { type: 'notification', event, object };
    notifications.push(notification);
    if (!opts.webhookUrl) return { notification, delivered: null };
    try {
      const res = await fetch(opts.webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(notification),
      });
      return { notification, delivered: res.status };
    } catch {
      return { notification, delivered: 0 };
    }
  }

  async function pay(id: string) {
    const p = payments.get(id);
    if (!p) throw new Error(`Эмулятор: нет платежа ${id}`);
    if (p.status === 'pending' || p.status === 'waiting_for_capture') {
      p.status = 'succeeded';
      p.paid = true;
      p.captured_at = now();
    }
    return notify('payment.succeeded', p);
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const path = u.pathname;
    const method = req.method ?? 'GET';

    // Страница оплаты по ссылке: то, что клиент видит в браузере.
    if (path.startsWith('/pay/')) {
      const id = path.split('/')[2] ?? '';
      const p = payments.get(id);
      if (!p) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Нет такого платежа'); return; }
      if (method === 'POST') {
        await pay(id);
        res.writeHead(302, { location: `/pay/${id}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Эмулятор оплаты</title>
<body style="font-family:sans-serif;max-width:420px;margin:40px auto">
<h2>Эмулятор провайдера</h2><p>${p.description}</p><p><b>${p.amount.value} ₽</b> · ${p.status}</p>
${p.status === 'succeeded' ? '<p>Оплачено.</p>' : `<form method="post"><button style="font-size:18px;padding:10px 20px">Оплатить</button></form>`}
</body>`);
      return;
    }

    if (!path.startsWith('/v3/')) { error(res, 404, 'Нет такого адреса'); return; }
    if (req.headers.authorization !== auth) {
      json(res, 401, { type: 'error', code: 'invalid_credentials', description: 'Неверные shopId или секретный ключ' });
      return;
    }
    const body = method === 'POST' ? await read(req) : '';
    const data = body ? JSON.parse(body) as Record<string, unknown> : {};
    const key = String(req.headers['idempotence-key'] ?? '');
    if (method === 'POST' && !key) { error(res, 400, 'Не передан заголовок Idempotence-Key'); return; }
    // Повтор с тем же ключом — тот же ответ, без второго объекта.
    if (method === 'POST' && byKey.has(key)) { json(res, 200, byKey.get(key)); return; }
    const remember = (obj: unknown) => { if (key) byKey.set(key, obj); return obj; };

    const seg = path.split('/').filter(Boolean); // ['v3', 'payments', id?, action?]

    if (seg[1] === 'payments' && method === 'POST' && seg.length === 2) {
      const amount = data.amount as { value: string; currency: string } | undefined;
      if (!amount || !(Number(amount.value) > 0)) { error(res, 400, 'Сумма платежа должна быть больше нуля', 'amount'); return; }
      const conf = (data.confirmation ?? {}) as { type?: string; return_url?: string };
      const id = `em-${++seq}`;
      const kop = Math.round(Number(amount.value) * 100);
      const p: EmPayment = {
        id, status: 'pending', paid: false, amount: { value: Number(amount.value).toFixed(2), currency: amount.currency ?? 'RUB' },
        description: String(data.description ?? ''), metadata: (data.metadata ?? {}) as Record<string, string>,
        confirmation: conf.type === 'qr'
          // Строка НСПК того же вида, что у настоящего QR СБП: её и кодируем в картинку.
          ? { type: 'qr', confirmation_data: `https://qr.nspk.ru/EM${String(seq).padStart(8, '0')}?type=02&bank=100000000001&sum=${kop}&cur=RUB&crc=EM${seq}` }
          : { type: 'redirect', confirmation_url: `${url}/pay/${id}` },
        payment_method: { type: ((data.payment_method_data as { type?: string })?.type) ?? 'bank_card' },
        created_at: now(), test: true,
      };
      payments.set(id, p);
      json(res, 200, remember(p));
      return;
    }
    if (seg[1] === 'payments' && seg[2]) {
      const p = payments.get(seg[2]);
      if (!p) { error(res, 404, `Платёж ${seg[2]} не найден`); return; }
      if (method === 'GET') { json(res, 200, p); return; }
      if (method === 'POST' && seg[3] === 'cancel') {
        if (p.status !== 'waiting_for_capture') { error(res, 400, 'Отменить можно только платёж в статусе waiting_for_capture'); return; }
        p.status = 'canceled';
        json(res, 200, remember(p));
        return;
      }
    }
    if (seg[1] === 'refunds' && method === 'POST') {
      const p = payments.get(String(data.payment_id ?? ''));
      if (!p) { error(res, 404, 'Платёж для возврата не найден', 'payment_id'); return; }
      if (p.status !== 'succeeded') { error(res, 400, 'Возврат возможен только по оплаченному платежу'); return; }
      const amount = data.amount as { value: string; currency: string };
      if (Number(amount?.value) > Number(p.amount.value)) { error(res, 400, 'Сумма возврата больше суммы платежа', 'amount'); return; }
      const id = `rf-${++seq}`;
      const r: EmRefund = { id, status: 'succeeded', amount: { value: Number(amount.value).toFixed(2), currency: 'RUB' }, payment_id: p.id, created_at: now() };
      refunds.set(id, r);
      // Чек возврата — сразу, если передали позиции (так делает и провайдер).
      if (data.receipt) {
        const rc = data.receipt as { customer?: { email?: string; phone?: string }; items?: unknown[]; tax_system_code?: number };
        const rid = `rc-${++seq}`;
        const receipt: EmReceipt = {
          id: rid, type: 'refund', refund_id: id, status: 'succeeded',
          fiscal_document_number: String(seq), fiscal_storage_number: '9960440300000001', fiscal_attribute: String(1e9 + seq),
          fiscal_provider_id: 'em-ofd', registered_at: now(), tax_system_code: rc.tax_system_code,
          customer: rc.customer ?? {}, items: rc.items ?? [], settlements: [{ type: 'cashless', amount: r.amount }],
        };
        receipts.set(rid, receipt);
        if (receipt.customer.email) mails.push({ to: receipt.customer.email, receipt_id: rid, fiscal_document_number: receipt.fiscal_document_number, kind: 'refund' });
      }
      json(res, 200, remember(r));
      void notify('refund.succeeded', r);
      return;
    }
    if (seg[1] === 'refunds' && seg[2] && method === 'GET') {
      const r = refunds.get(seg[2]);
      if (!r) { error(res, 404, `Возврат ${seg[2]} не найден`); return; }
      json(res, 200, r);
      return;
    }
    if (seg[1] === 'receipts' && method === 'POST') {
      const type = data.type === 'refund' ? 'refund' : 'payment';
      const items = (data.items ?? []) as { amount: { value: string }; quantity: string }[];
      if (!items.length) { error(res, 400, 'В чеке нет позиций', 'items'); return; }
      const customer = (data.customer ?? {}) as { email?: string; phone?: string };
      if (!customer.email && !customer.phone) { error(res, 400, 'У покупателя нужен email или телефон', 'customer'); return; }
      const sum = items.reduce((a, i) => a + Number(i.amount.value) * Number(i.quantity), 0);
      const settlements = (data.settlements ?? []) as { amount: { value: string } }[];
      const paid = settlements.reduce((a, s) => a + Number(s.amount.value), 0);
      if (Math.abs(sum - paid) > 0.005) { error(res, 400, `Сумма позиций ${sum.toFixed(2)} не равна сумме расчёта ${paid.toFixed(2)}`, 'settlements'); return; }
      if (type === 'payment') {
        const p = payments.get(String(data.payment_id ?? ''));
        if (!p) { error(res, 404, 'Платёж для чека не найден', 'payment_id'); return; }
        if (p.status !== 'succeeded') { error(res, 400, 'Чек пробивается только по оплаченному платежу'); return; }
      }
      const id = `rc-${++seq}`;
      const receipt: EmReceipt = {
        id, type, status: 'succeeded',
        ...(type === 'payment' ? { payment_id: String(data.payment_id) } : { refund_id: String(data.refund_id ?? '') }),
        fiscal_document_number: String(seq), fiscal_storage_number: '9960440300000001', fiscal_attribute: String(1e9 + seq),
        fiscal_provider_id: 'em-ofd', registered_at: now(), tax_system_code: data.tax_system_code as number | undefined,
        customer, items, settlements,
      };
      receipts.set(id, receipt);
      if (data.send && customer.email) mails.push({ to: customer.email, receipt_id: id, fiscal_document_number: receipt.fiscal_document_number, kind: type });
      json(res, 200, remember(receipt));
      return;
    }
    if (seg[1] === 'receipts' && seg[2] && method === 'GET') {
      const r = receipts.get(seg[2]);
      if (!r) { error(res, 404, `Чек ${seg[2]} не найден`); return; }
      json(res, 200, r);
      return;
    }
    error(res, 404, `Нет такого адреса: ${method} ${path}`);
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const a = server.address() as { address: string; port: number };
      url = `http://${a.address}:${a.port}`;
      resolve({
        url, payments, receipts, refunds, mails, notifications, pay,
        stop: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

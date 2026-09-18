// Сторож CRM «Учёткин». Cloud Function, запускается таймером раз в минуту
// (infra/watchdog.tf). Что проверяет и куда пишет — комментарий в watchdog.tf,
// что значит каждое оповещение и что делать — docs/ops.md.
//
// Внешних зависимостей нет: fetch, tls и crypto есть в Node 22.
'use strict';

const tls = require('node:tls');
const net = require('node:net');

const env = process.env;
const T = {
  downMinutes: Number(env.DOWN_MINUTES || 2),
  http5xxPercent: Number(env.HTTP_5XX_PERCENT || 2),
  diskPercent: Number(env.DISK_PERCENT || 80),
  backupMaxAgeHours: Number(env.BACKUP_MAX_AGE_HOURS || 26),
  certDays: Number(env.CERT_DAYS || 14),
  remindHours: Number(env.REMIND_HOURS || 6),
  statusIntervalMin: Number(env.STATUS_INTERVAL_MIN || 5),
  // Меньше запросов за пять минут — доля 5xx не считается: одна ошибка на
  // три запроса — это 33 %, а не авария.
  min5xxSample: 20,
};

const STATE_KEY = 'watchdog/state.json';
const MONITORING = 'https://monitoring.api.cloud.yandex.net/monitoring/v2/data/read';
const STORAGE = 'https://storage.yandexcloud.net';
const LOCKBOX = 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets';

// ─── Вспомогательное ────────────────────────────────────────────────────────

const fmtTime = (ms) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: env.TZ || 'Asia/Yekaterinburg',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));

const minutesWord = (n) => {
  const r10 = n % 10, r100 = n % 100;
  if (r10 === 1 && r100 !== 11) return `${n} минуту`;
  if (r10 >= 2 && r10 <= 4 && (r100 < 12 || r100 > 14)) return `${n} минуты`;
  return `${n} минут`;
};

async function http(url, init = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

async function readState(token) {
  const res = await http(`${STORAGE}/${env.OPS_BUCKET}/${STATE_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { streak: 0, active: {} };
  if (!res.ok) throw new Error(`state: GET ${res.status}`);
  const s = await res.json();
  s.active = s.active || {};
  s.streak = s.streak || 0;
  return s;
}

async function writeState(token, state) {
  const res = await http(`${STORAGE}/${env.OPS_BUCKET}/${STATE_KEY}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`state: PUT ${res.status} ${await res.text()}`);
}

async function lockbox(token, secretId) {
  if (!secretId) return null;
  const res = await http(`${LOCKBOX}/${secretId}/payload`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null; // пустой секрет (нет версий) отвечает 404
  const body = await res.json();
  const out = {};
  for (const e of body.entries || []) out[e.key] = e.textValue;
  return out;
}

// Последние точки метрики за окно. Возвращает список {labels, points:[[ts, v]]}.
async function readMetrics(token, query, minutes) {
  const to = new Date();
  const from = new Date(to.getTime() - minutes * 60_000);
  const res = await http(`${MONITORING}?folderId=${env.FOLDER_ID}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      fromTime: from.toISOString(),
      toTime: to.toISOString(),
      downsampling: { disabled: true },
    }),
  });
  if (!res.ok) throw new Error(`monitoring: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.metrics || []).map((m) => {
    const ts = m.timeseries?.timestamps || [];
    const vs = m.timeseries?.doubleValues || m.timeseries?.int64Values || [];
    const points = ts.map((t, i) => [Number(t), Number(vs[i])]).filter((p) => Number.isFinite(p[1]));
    return { labels: m.labels || {}, points };
  });
}

const last = (series) => {
  let best = null;
  for (const s of series) for (const p of s.points) if (!best || p[0] > best[0]) best = p;
  return best; // [ts, value] или null
};

// Сколько запросов прошло за окно, суммарно по всем рядам. Агент отдаёт
// счётчики Prometheus уже как скорость (запросов в секунду за интервал опроса,
// DGAUGE), поэтому запросы — это скорость × длину интервала между точками.
const requestsInWindow = (series) => {
  let sum = 0;
  for (const s of series) {
    const pts = [...s.points].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i][0] - pts[i - 1][0]) / 1000;
      if (dt > 0 && dt <= 300) sum += pts[i][1] * dt;
    }
  }
  return sum;
};

// ─── Проверки ───────────────────────────────────────────────────────────────
// Каждая возвращает {code, ok, title, detail, action}. Текст — для человека
// без администратора: что случилось, с какого момента, что сделать первым.

// Каталог в селектор не входит — он уходит параметром folderId запроса, а с
// ним же внутри селектора data/read молча отдаёт пустой ответ (проверено).
const sel = (name, extra = '') =>
  `"${name}"{service="custom", host="${env.VM_HOST}"${extra}}`;

async function checkHealth(state) {
  let ok = false, why = '';
  try {
    const res = await http(env.HEALTH_URL, { headers: { 'User-Agent': 'uchetkin-watchdog' } }, 10_000);
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      ok = body.status === 'ok' && (body.db === undefined || body.db === 'ok');
      why = ok ? '' : `ответ ${JSON.stringify(body)}`;
    } else why = `код ${res.status}`;
  } catch (e) {
    why = e.name === 'TimeoutError' ? 'нет ответа 10 секунд' : `${e.cause?.code || e.message}`;
  }
  state.streak = ok ? 0 : state.streak + 1;
  if (!ok && !state.downSince) state.downSince = Date.now();
  if (ok) delete state.downSince;
  const down = state.streak >= T.downMinutes;
  return {
    code: 'app_down',
    ok: !down,
    title: 'Система недоступна',
    detail: down
      ? `Проверка ${env.HEALTH_URL} не проходит уже ${minutesWord(state.streak)} (с ${fmtTime(state.downSince)}): ${why}.`
      : '',
    action: `Откройте ${env.APP_URL}. Не открывается — в консоли облака проверьте, что машина ${env.VM_HOST} запущена, затем docs/ops.md, «Система недоступна».`,
  };
}

async function checkDisk(token) {
  const s = await readMetrics(token, sel('uchetkin.disk_used_percent'), 3 * T.statusIntervalMin);
  const p = last(s);
  if (!p) return { code: 'disk', ok: true, nodata: true };
  const v = Math.round(p[1]);
  return {
    code: 'disk',
    ok: v < T.diskPercent,
    title: 'Диск машины почти заполнен',
    detail: `Корневой диск ${env.VM_HOST} занят на ${v} % (порог ${T.diskPercent} %).`,
    action: 'Место съедают журналы Docker и старые образы. Первый шаг — docs/ops.md, «Диск заполнен»: docker system prune и проверка /var/lib/docker.',
  };
}

async function checkBackup(token) {
  const s = await readMetrics(token, sel('uchetkin.backup_age_hours'), 3 * T.statusIntervalMin);
  const p = last(s);
  if (!p) return { code: 'backup', ok: true, nodata: true };
  const hours = Math.round(p[1]);
  return {
    code: 'backup',
    ok: hours <= T.backupMaxAgeHours,
    title: 'Резервная копия базы устарела',
    detail: hours >= 9000
      ? 'Ни одной удачной копии ещё не было.'
      : `Последняя удачная копия сделана ${hours} ч назад (допустимо ${T.backupMaxAgeHours}).`,
    action: `На машине: sudo systemctl start uchetkin-backup и journalctl -u uchetkin-backup. Подробнее — docs/ops.md, «Копия устарела».`,
  };
}

async function checkSilence(token) {
  const s = await readMetrics(token, sel('uchetkin.status_ok'), 4 * T.statusIntervalMin);
  const p = last(s);
  return {
    code: 'vm_silent',
    ok: Boolean(p),
    title: 'Машина не присылает служебные метрики',
    detail: `От ${env.VM_HOST} нет метрик uchetkin.* больше ${4 * T.statusIntervalMin} минут: либо машина выключена, либо остановлен агент мониторинга или таймер uchetkin-status.`,
    action: 'Если система при этом работает — на машине: sudo systemctl status uchetkin-status.timer и docker ps | grep unified-agent. Иначе — docs/ops.md, «Система недоступна».',
  };
}

async function check5xx(token) {
  // Код ответа есть только у гистограммы времени ответа; caddy_http_requests_total
  // его не несёт. Один запрос проходит два обработчика (request_body и subroute),
  // поэтому считается только subroute — иначе всё удваивается.
  const all = await readMetrics(token, sel('caddy_http_request_duration_seconds_count', ', handler="subroute"'), 5);
  const bad = all.filter((s) => /^5/.test(String(s.labels.code || '')));
  const total = requestsInWindow(all), errors = requestsInWindow(bad);
  if (total < T.min5xxSample) return { code: 'http_5xx', ok: true, sample: total };
  const pct = (100 * errors) / total;
  return {
    code: 'http_5xx',
    ok: pct <= T.http5xxPercent,
    title: 'Много ошибок сервера (5xx)',
    detail: `За последние 5 минут ${Math.round(errors)} из ${Math.round(total)} запросов завершились ошибкой 5xx — ${pct.toFixed(1)} % (порог ${T.http5xxPercent} %).`,
    action: 'Скорее всего, упало или не поднялось приложение после выкладки. Первый шаг — docs/ops.md, «Ошибки 5xx»: docker compose ps и журнал api в Cloud Logging.',
  };
}

function certDaysLeft(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) return resolve(null);
      resolve(Math.floor((new Date(cert.valid_to) - Date.now()) / 86_400_000));
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function checkCert() {
  if (!env.HEALTH_URL.startsWith('https://')) return { code: 'cert', ok: true, skipped: 'TLS выключен' };
  const days = await certDaysLeft(env.APP_DOMAIN);
  if (days === null) return { code: 'cert', ok: true, nodata: true };
  return {
    code: 'cert',
    ok: days > T.certDays,
    title: 'Сертификат скоро истечёт',
    detail: `Сертификат ${env.APP_DOMAIN} действует ещё ${days} дн. (порог ${T.certDays}). Caddy продлевает его сам за 30 дней до конца — раз не продлил, что-то мешает.`,
    action: 'На машине: docker logs uchetkin-caddy | grep -i acme. Обычно причина — закрытый порт 80/443 или сломанная A-запись. Подробнее — docs/ops.md, «Сертификат».',
  };
}

// ─── Доставка ───────────────────────────────────────────────────────────────

async function sendTelegram(ch, text) {
  if (!ch?.telegram_bot_token || !ch?.telegram_chat_id) return 'telegram: канал не настроен (секрет alerts пуст)';
  const res = await http(`https://api.telegram.org/bot${ch.telegram_bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ch.telegram_chat_id, text, disable_web_page_preview: true }),
  });
  return res.ok ? 'telegram: отправлено' : `telegram: ошибка ${res.status} ${await res.text()}`;
}

// Минимальный SMTP-клиент: 465 — TLS сразу, иначе STARTTLS. Только AUTH PLAIN.
function smtpSend(cfg, to, subject, text) {
  return new Promise((resolve, reject) => {
    const port = Number(cfg.port || 465);
    let sock = port === 465
      ? tls.connect({ host: cfg.host, port, servername: cfg.host })
      : net.connect({ host: cfg.host, port });
    let buf = '';
    let waiter = null;
    const fail = (e) => { try { sock.destroy(); } catch {} reject(e); };
    const onData = (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (/^\d{3} /.test(line) && waiter) { const w = waiter; waiter = null; w(line); }
      }
    };
    const attach = () => { sock.on('data', onData); sock.on('error', fail); sock.setTimeout(15_000, () => fail(new Error('smtp: timeout'))); };
    attach();
    const expect = (want) => new Promise((res) => { waiter = (line) => line.startsWith(String(want)) ? res(line) : fail(new Error(`smtp: ${line}`)); });
    const send = (cmd, want) => { sock.write(cmd + '\r\n'); return expect(want); };
    (async () => {
      await expect(220);
      await send(`EHLO uchetkin-watchdog`, 250);
      if (port !== 465) {
        await send('STARTTLS', 220);
        sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: cfg.host });
        attach();
        await send(`EHLO uchetkin-watchdog`, 250);
      }
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.password}`).toString('base64');
      await send(`AUTH PLAIN ${plain}`, 235);
      await send(`MAIL FROM:<${cfg.from || cfg.user}>`, 250);
      await send(`RCPT TO:<${to}>`, 250);
      await send('DATA', 354);
      const subj = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
      const msg = [
        `From: Учёткин сторож <${cfg.from || cfg.user}>`.replace('Учёткин сторож', `=?UTF-8?B?${Buffer.from('Учёткин сторож').toString('base64')}?=`),
        `To: <${to}>`,
        `Subject: ${subj}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        text.replace(/\r?\n\./g, '\n..'),
        '.',
      ].join('\r\n');
      await send(msg, 250);
      sock.write('QUIT\r\n');
      sock.end();
      resolve('email: отправлено');
    })().catch(fail);
  });
}

async function sendEmail(cfg, subject, text) {
  if (!env.ALERT_EMAIL) return 'email: адрес не задан (alert_email пуст)';
  if (!cfg?.host || !cfg?.user || !cfg?.password) return 'email: канал не настроен (секрет smtp пуст)';
  try { return await smtpSend(cfg, env.ALERT_EMAIL, subject, text); } catch (e) { return `email: ошибка ${e.message}`; }
}

// Строка журнала — JSON с полями level и message: так Cloud Logging принимает
// её как структурированную запись с уровнем. Без level строка считается
// «уровень не задан», и группа с min_level = INFO её отбрасывает (проверено:
// от функции доходили только системные START/END/REPORT).
const log = (level, message, fields) => console.log(JSON.stringify({ level, message, ...fields }));

// Заглушка каналов (решение владельца 18.09.2026: Telegram подключается
// позднее). Пока секреты пусты, оповещение всё равно доставляется — в
// Cloud Logging и в журнал последних оповещений в бакете ops
// (watchdog/alerts.json, последние 50). Когда секреты заполнят, к этому
// добавятся Telegram и почта — код тот же, менять ничего не нужно.
const ALERTS_KEY = 'watchdog/alerts.json';

async function appendAlertJournal(token, entry) {
  let list = [];
  try {
    const res = await http(`${STORAGE}/${env.OPS_BUCKET}/${ALERTS_KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) list = await res.json();
  } catch {}
  list.push(entry);
  list = list.slice(-50);
  const res = await http(`${STORAGE}/${env.OPS_BUCKET}/${ALERTS_KEY}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(list, null, 1),
  });
  return res.ok ? `журнал: записано в s3://${env.OPS_BUCKET}/${ALERTS_KEY}` : `журнал: ошибка ${res.status}`;
}

async function deliver(token, subject, text) {
  const [tg, smtp] = await Promise.all([lockbox(token, env.ALERTS_SECRET_ID), lockbox(token, env.SMTP_SECRET_ID)]);
  const results = await Promise.all([sendTelegram(tg, text), sendEmail(smtp, subject, text)]);
  results.push(await appendAlertJournal(token, { at: new Date().toISOString(), subject, text, delivery: results.slice() }));
  log('WARN', `оповещение: ${subject}`, { event: 'alert', subject, text, delivery: results });
  return results;
}

const header = () => `Учёткин (${env.ENV})`;

const problemText = (c) =>
  `🔴 ${header()}: ${c.title}\n\n${c.detail}\n\nЧто делать: ${c.action}\n\n${fmtTime(Date.now())}, сторож напомнит через ${T.remindHours} ч, если не пройдёт.`;

const resolvedText = (c, since) =>
  `🟢 ${header()}: ${c.title} — прошло\n\nДлилось с ${fmtTime(since)} по ${fmtTime(Date.now())}. Можно выдохнуть.`;

// ─── Точка входа ────────────────────────────────────────────────────────────

module.exports.handler = async function handler(event, context) {
  const token = context?.token?.access_token;
  if (!token) throw new Error('нет токена сервисного аккаунта: у функции не задан service_account_id');

  // Проверка каналов по требованию: yc serverless function invoke ... -d '{"test": true}'
  let payload = event || {};
  if (typeof payload.body === 'string') { try { payload = JSON.parse(payload.body); } catch { payload = {}; } }
  if (payload.test) {
    const results = await deliver(token, `${header()}: проверка оповещений`,
      `✅ ${header()}: проверка оповещений\n\nЕсли вы это читаете — канал работает. ${fmtTime(Date.now())}.`);
    return { statusCode: 200, body: { delivery: results } };
  }

  const state = await readState(token);
  const now = Date.now();

  const results = await Promise.allSettled([
    checkHealth(state),
    checkDisk(token),
    checkBackup(token),
    checkSilence(token),
    check5xx(token),
    checkCert(),
  ]);

  const checks = [];
  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value);
    else log('ERROR', 'проверка упала', { event: 'check_failed', error: String(r.reason?.stack || r.reason) });
  }

  const sent = [];
  for (const c of checks) {
    const active = state.active[c.code];
    if (!c.ok && !active) {
      state.active[c.code] = { since: now, lastSent: now, title: c.title };
      sent.push(...(await deliver(token, `${header()}: ${c.title}`, problemText(c))));
    } else if (!c.ok && active && now - active.lastSent >= T.remindHours * 3_600_000) {
      active.lastSent = now;
      sent.push(...(await deliver(token, `${header()}: ${c.title} (напоминание)`, problemText(c))));
    } else if (c.ok && active) {
      delete state.active[c.code];
      sent.push(...(await deliver(token, `${header()}: ${c.title} — прошло`, resolvedText(c, active.since))));
    }
  }

  state.lastRun = now;
  await writeState(token, state);

  const summary = {
    event: 'run',
    at: new Date(now).toISOString(),
    checks: checks.map((c) => ({ code: c.code, ok: c.ok, ...(c.nodata ? { nodata: true } : {}), ...(c.skipped ? { skipped: c.skipped } : {}), ...(c.sample !== undefined ? { sample: c.sample } : {}) })),
    streak: state.streak,
    active: Object.keys(state.active),
    sent,
  };
  log('INFO', `проверка: ${checks.filter((c) => !c.ok).length ? 'есть проблемы' : 'всё в порядке'}`, summary);
  return { statusCode: 200, body: summary };
};

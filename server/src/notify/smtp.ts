/* Отправка письма по SMTP — без библиотеки.
 *
 * Клиенту нужны ровно четыре команды (EHLO, AUTH, MAIL/RCPT, DATA) и один
 * формат письма — простой текст в UTF-8. Это полторы сотни строк, которые
 * целиком видно, против зависимости с полусотней своих. Заодно проверка
 * `scripts/check-notify.mts` разговаривает с этим клиентом настоящим SMTP:
 * поднимает приёмник на свободном порту и читает то, что он выдал в сеть.
 *
 * Чего здесь нет нарочно: вложений, HTML и пула соединений. Письма уходят
 * поштучно из очереди (src/notify/outbox.ts), и каждое — это отдельная сессия:
 * десяток писем в день не стоит ни одной строки кода на переиспользование.
 */
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { NotifyConfig } from './config.ts';
import type { Message, Notifier, Sent } from './notifier.ts';

/** Диалог с сервером: пишем строку — ждём ответ с нужным кодом. */
class Session {
  private buf = '';
  private waiting: ((line: string) => void) | null = null;
  private failed: ((err: Error) => void) | null = null;

  constructor(private socket: Socket, private timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      // Ответ может занимать несколько строк: продолжение помечено дефисом
      // после кода (250-PIPELINING), последняя строка — пробелом.
      const end = this.buf.match(/^\d{3} [^\n]*\n/m);
      if (!end) return;
      const at = this.buf.indexOf(end[0]) + end[0].length;
      const reply = this.buf.slice(0, at);
      this.buf = this.buf.slice(at);
      this.waiting?.(reply);
      this.waiting = null;
      this.failed = null;
    });
    const die = (err: Error) => { this.failed?.(err); this.failed = null; this.waiting = null; };
    socket.on('error', die);
    socket.on('close', () => die(new Error('сервер закрыл соединение')));
  }

  /** Ждёт ответ и сверяет код. Чужой код — это ошибка с текстом сервера:
   *  «535 Authentication failed» человеку говорит больше, чем «не отправилось». */
  async expect(code: number): Promise<string> {
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`сервер молчит дольше ${this.timeoutMs} мс`)), this.timeoutMs);
      this.waiting = (line) => { clearTimeout(timer); resolve(line); };
      this.failed = (err) => { clearTimeout(timer); reject(err); };
    });
    if (!reply.startsWith(String(code))) throw new Error(`SMTP ответил «${reply.trim()}», ожидалось ${code}`);
    return reply;
  }

  send(line: string): void {
    this.socket.write(line + '\r\n');
  }

  async say(line: string, code: number): Promise<string> {
    this.send(line);
    return this.expect(code);
  }

  /** Переключение на TLS посреди сессии (порт 587). Сокет остаётся тем же,
   *  дальше разговор идёт поверх шифрования и EHLO повторяется. */
  upgrade(host: string): Session {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    const secure = tlsConnect({ socket: this.socket, servername: host });
    return new Session(secure as unknown as Socket, this.timeoutMs);
  }

  end(): void {
    try { this.socket.end(); } catch { /* сокет уже закрыт — писать некуда */ }
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Заголовок с русскими буквами: MIME-слово по RFC 2047. Без него тема письма
 *  приезжает набором вопросительных знаков. */
const header = (text: string): string => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`);

/** Тело письма: текст в UTF-8 идёт base64 — так не приходится думать ни о
 *  длине строк, ни о точке в начале строки, ни о переводах строки. */
function letter(cfg: NotifyConfig, msg: Message, messageId: string): string {
  const head = [
    `From: ${header(cfg.fromName)} <${cfg.from}>`,
    `To: <${msg.address}>`,
    `Subject: ${header(msg.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (cfg.replyTo) head.splice(1, 0, `Reply-To: <${cfg.replyTo}>`);
  const body = b64(msg.body).replace(/(.{76})/g, '$1\r\n');
  return head.join('\r\n') + '\r\n\r\n' + body;
}

/** Отправитель писем. `null`, если ящик не настроен: см. `canSendEmail`. */
export function emailNotifier(cfg: NotifyConfig, timeoutMs = 20_000): Notifier {
  return {
    channel: 'email',
    async send(msg: Message): Promise<Sent> {
      const { host, port, secure, user, password } = cfg.smtp;
      const socket = secure
        ? tlsConnect({ host, port, servername: host }) as unknown as Socket
        : createConnection({ host, port });
      let s = new Session(socket, timeoutMs);
      const messageId = `${randomUUID()}@${(cfg.from ?? 'uchetkin').split('@')[1]}`;
      try {
        await s.expect(220);
        const hello = await s.say('EHLO uchetkin', 250);
        if (!secure && /STARTTLS/i.test(hello)) {
          await s.say('STARTTLS', 220);
          s = s.upgrade(host);
          await s.say('EHLO uchetkin', 250);
        }
        if (user && password) {
          await s.say('AUTH LOGIN', 334);
          await s.say(b64(user), 334);
          await s.say(b64(password), 235);
        }
        await s.say(`MAIL FROM:<${cfg.from}>`, 250);
        await s.say(`RCPT TO:<${msg.address}>`, 250);
        await s.say('DATA', 354);
        s.send(letter(cfg, msg, messageId));
        const accepted = await s.say('.', 250);
        try { await s.say('QUIT', 221); } catch { /* попрощаться не вышло — письмо уже принято */ }
        return { id: messageId, response: accepted.trim() };
      } finally {
        s.end();
      }
    },
  };
}

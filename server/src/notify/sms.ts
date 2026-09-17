/* СМС через шлюз SMSC.ru.
 *
 * Выбор провайдера и сравнение с SMS.RU и МТС Exolve — в docs/notify.md.
 * Коротко, почему он: есть простой HTTP-интерфейс без ключей и подписей, есть
 * виртуальная отправка (`virtsms=1`) — шлюз отвечает как при настоящей, но
 * ничего не шлёт и не списывает, — и цена за сообщение видна в тарифах до
 * заключения договора.
 *
 * Ответ разбираем в формате 3 (JSON): при удаче приходит `{id, cnt, cost,
 * balance}`, при отказе — `{error, error_code}`. Отказ здесь — это ошибка
 * отправки, а не «отправлено с оговоркой»: очередь должна повторить.
 */
import type { NotifyConfig } from './config.ts';
import type { Message, Notifier, Sent } from './notifier.ts';

interface SmscOk { id?: number; cnt?: number; cost?: string; balance?: string }
interface SmscErr { error?: string; error_code?: number }

/** Номер в том виде, в каком его ждёт шлюз: только цифры с кодом страны. */
const digits = (phone: string): string => phone.replace(/\D/g, '');

export function smsNotifier(cfg: NotifyConfig, timeoutMs = 20_000): Notifier {
  return {
    channel: 'sms',
    async send(msg: Message): Promise<Sent> {
      const params = new URLSearchParams({
        login: cfg.sms.login ?? '',
        psw: cfg.sms.password ?? '',
        phones: digits(msg.address),
        mes: msg.body,
        fmt: '3',
        charset: 'utf-8',
      });
      if (cfg.sms.sender) params.set('sender', cfg.sms.sender);
      // Тестовый контур провайдера: сообщение проходит весь путь до оператора,
      // но не уходит абоненту и не стоит денег. Пометка о нём попадает и в
      // журнал доставки — иначе «отправлено» в отчёте значит разное.
      if (cfg.sms.testMode) params.set('virtsms', '1');

      let res: Response;
      try {
        res = await fetch(cfg.sms.apiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`СМС-шлюз недоступен: ${(err as Error).message}`);
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`СМС-шлюз ответил ${res.status}: ${text.slice(0, 200)}`);

      let body: SmscOk & SmscErr;
      try {
        body = JSON.parse(text) as SmscOk & SmscErr;
      } catch {
        throw new Error(`СМС-шлюз ответил не JSON: ${text.slice(0, 200)}`);
      }
      if (body.error) throw new Error(`СМС-шлюз отказал: ${body.error} (код ${body.error_code ?? '—'})`);
      if (body.id === undefined) throw new Error(`СМС-шлюз не вернул идентификатор: ${text.slice(0, 200)}`);

      const mark = cfg.sms.testMode ? 'виртуальная отправка, ' : '';
      return {
        id: String(body.id),
        response: `${mark}частей ${body.cnt ?? 1}, стоимость ${body.cost ?? '0'}, остаток ${body.balance ?? '—'}`,
      };
    },
  };
}

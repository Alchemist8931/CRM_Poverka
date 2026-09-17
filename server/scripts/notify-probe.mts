/* Пробное сообщение с настоящего ящика и настоящего шлюза (пункт int-notify).
 *
 *   npm run notify:probe -- --to проверка@пример.рф      # письмо
 *   npm run notify:probe -- --sms +79001234567           # СМС
 *
 * Это единственная проверка, которую нельзя сделать без чужих служб: попадает
 * ли письмо во «Входящие» или в «Спам», решает принимающая почта по подписи
 * домена отправителя, и увидеть это можно только глазами в ящике. Поэтому
 * команда ничего не утверждает — она отправляет и печатает, что ответил шлюз.
 *
 * Настройки берутся из окружения ровно те же, с которыми работает система
 * (src/notify/config.ts): если письмо ушло отсюда, оно уйдёт и из очереди.
 * При переезде на свой домен (пункт cloud-domain) прогоняется первой.
 */
import { canSendEmail, canSendSms, notifyConfig } from '../src/notify/config.ts';
import { emailNotifier } from '../src/notify/smtp.ts';
import { smsNotifier } from '../src/notify/sms.ts';

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] ?? null : null;
};

const to = arg('--to');
const sms = arg('--sms');
if (!to && !sms) {
  console.error('Укажите, куда слать: --to адрес@пример.рф или --sms +79001234567');
  process.exit(2);
}

const cfg = notifyConfig();
const when = new Date().toLocaleString('ru-RU', { timeZone: cfg.timezone });

if (to) {
  if (!canSendEmail(cfg)) {
    console.error('Почта не настроена: нужны NOTIFY_FROM, SMTP_HOST, SMTP_USER, SMTP_PASSWORD.');
    process.exit(1);
  }
  console.log(`Письмо с ${cfg.from} на ${to} через ${cfg.smtp.host}:${cfg.smtp.port}…`);
  const sent = await emailNotifier(cfg).send({
    address: to,
    subject: `Проверка почты CRM «Учёткин» ${when}`,
    body: `Это пробное письмо системы записи на поверку.\n\n`
      + `Отправлено ${when} с ящика ${cfg.from}.\n`
      + `Если письмо оказалось в папке «Спам» — скажите об этом, это настраивается на стороне домена.\n\n`
      + cfg.signature,
  });
  console.log(`Ушло. Идентификатор: ${sent.id}. Ответ сервера: ${sent.response}`);
  console.log('Теперь посмотрите в ящике: письмо должно лежать во «Входящих», а не в «Спаме».');
}

if (sms) {
  if (!canSendSms(cfg)) {
    console.error('СМС-шлюз не настроен: нужны SMS_LOGIN и SMS_PASSWORD.');
    process.exit(1);
  }
  console.log(`СМС на ${sms} через ${cfg.sms.apiUrl}${cfg.sms.testMode ? ' (виртуальная отправка)' : ''}…`);
  const sent = await smsNotifier(cfg).send({
    address: sms,
    subject: '',
    body: `Проверка СМС CRM Учёткин, ${when}. ${cfg.office}`,
  });
  console.log(`Ушло. Идентификатор: ${sent.id}. Ответ шлюза: ${sent.response}`);
  if (cfg.sms.testMode) console.log('SMS_TEST=1: сообщение абоненту не доставлено и не оплачено — так и задумано.');
}

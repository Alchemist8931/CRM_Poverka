/* Отправитель сообщения: одна абстракция на все каналы.
 *
 * Всё, что знает очередь об отправке, — здесь: «возьми адрес, тему и текст и
 * отдай их наружу; вернулся идентификатор — ушло, бросил ошибку — не ушло».
 * Больше очереди знать нечего, и поэтому почту, СМС и будущий мессенджер она
 * гоняет одним и тем же кодом, а проверки подставляют вместо них запись в
 * список (`test/notify.test.ts`).
 */
import { canSendEmail, canSendSms, type NotifyConfig } from './config.ts';
import type { Channel } from './templates.ts';

/** Готовое сообщение из очереди: адрес и текст уже подставлены. */
export interface Message {
  address: string;
  subject: string;
  body: string;
}

/** Чем кончилась отправка у шлюза. Идентификатор нужен для разбора жалоб
 *  «письмо не пришло»: с ним поддержка почты или шлюза ищет сообщение у себя. */
export interface Sent {
  id: string;
  response: string;
}

export interface Notifier {
  channel: Channel;
  send(msg: Message): Promise<Sent>;
}

/** Отправители по каналам. `null` означает «канал не настроен»: сообщения по
 *  нему остаются в очереди и уходят, как только появятся ключи, — терять их
 *  из-за ненастроенного шлюза нельзя.
 *
 *  Мессенджер MAX — точка расширения, а не забытая строка. Заказчик на вопрос
 *  о канале ответил «МАКС??», то есть выбора пока нет. Когда он появится,
 *  добавляется файл `max.ts` с таким же `Notifier`, имя канала — в тип
 *  `Channel`, в CHECK миграции и сюда в перечень. Ни очередь, ни шаблоны, ни
 *  экран руководителя при этом не меняются: они работают с каналом вообще. */
export async function notifiers(cfg: NotifyConfig): Promise<Record<Channel, Notifier | null>> {
  // Ленивая загрузка: без ключей шлюзов их код не нужен вовсе, а проверкам
  // шаблонов и очереди — тем более (они ходят с подставными отправителями).
  const email = canSendEmail(cfg) ? (await import('./smtp.ts')).emailNotifier(cfg) : null;
  const sms = canSendSms(cfg) ? (await import('./sms.ts')).smsNotifier(cfg) : null;
  return { email, sms };
}

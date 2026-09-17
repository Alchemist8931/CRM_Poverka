/* Канал передачи: обращение к реестру по API.
 *
 * Второй канал — файл — кода не требует: система отдаёт XML, руководитель
 * загружает его в личном кабинете и вносит ответ кабинета обратно
 * (`POST /api/arshin/batches/:id/result`). Здесь только путь по API, который
 * включается, когда у заказчика появится договор и ключ.
 *
 * Тело ответа разбирается по одному правилу: что принято — с номером записи в
 * реестре, что не принято — с текстом ошибки, и то и другое привязано к нашему
 * `source-id` из выгрузки. Договор на обмен у заказчика не заключён, поэтому
 * разбор намеренно сведён к этим двум спискам: подгонять его под настоящий
 * ответ придётся в одном месте — здесь.
 */
import type { ArshinConfig } from './config.ts';

export interface SendOutcome {
  accepted: { source_id: string; number: string }[];
  failed: { source_id: string; error: string }[];
}

export class ChannelOff extends Error {
  constructor() {
    super('Обмен по API не подключён: нет ARSHIN_API_URL и ARSHIN_API_TOKEN. ' +
      'Выгрузите файл и загрузите его в личном кабинете.');
  }
}

/** Отправка выгрузки в реестр. Бросает `ChannelOff`, если ключей нет: тихо
 *  сделать вид, что сведения ушли, — худшее, что здесь можно сделать. */
export async function sendBatch(cfg: ArshinConfig, xml: string, batchId: string): Promise<SendOutcome> {
  if (!cfg.apiUrl || !cfg.apiToken) throw new ChannelOff();
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      authorization: `Bearer ${cfg.apiToken}`,
      'x-batch-id': batchId,
    },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Реестр ответил ${res.status}: ${text.slice(0, 500)}`);
  let body: Partial<SendOutcome>;
  try {
    body = JSON.parse(text) as Partial<SendOutcome>;
  } catch {
    throw new Error(`Ответ реестра не разобран: ${text.slice(0, 500)}`);
  }
  return { accepted: body.accepted ?? [], failed: body.failed ?? [] };
}

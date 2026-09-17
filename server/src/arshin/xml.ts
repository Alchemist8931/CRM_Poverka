/* Выгрузка сведений о поверке файлом.
 *
 * Состав полей — пункт 26 приказа Минпромторга России от 28.08.2020 № 2906
 * (подпункты названы в комментариях к каждому элементу). Разметка файла — наша:
 * официальная XSD-схема пакетной загрузки лежит в личном кабинете ФГИС
 * Росаккредитации и открыто не публикуется, а раздел «Справочная информация»
 * fgis.gost.ru на день выкладки отвечает страницей «Технологические работы».
 * Поэтому здесь описан ровно состав из приказа, а разметка отмечена своим
 * пространством имён и своей схемой (`vri.xsd`) — чтобы её нельзя было принять
 * за официальную и чтобы замена свелась к правке одного файла. Что именно
 * придётся поменять, когда заказчик даст доступ в кабинет, — в docs/arshin.md.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NS = 'urn:uchetkin:arshin:vri:1';

/** Путь к схеме: ею проверяется выгрузка в `scripts/check-arshin.mts`. */
export const xsdPath = fileURLToPath(new URL('vri.xsd', import.meta.url));
export const xsdText = (): string => readFileSync(xsdPath, 'utf8');

export interface ExportRecord {
  id: number | string;
  mi_name: string;
  mi_modification: string;
  grsi: string;
  serial: string;
  etalons: string;
  method_doc: string;
  verified_on: string;
  valid_to: string | null;
  applicable: boolean;
  fail_reason: string;
  verifier_name: string;
  owner_name: string;
}

const esc = (v: unknown): string => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Дата в файле — только `ГГГГ-ММ-ДД`: тип xs:date и никаких «дд.мм.гггг». */
const asDate = (v: string | Date): string =>
  (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

export interface ExportMeta {
  orgName: string;
  orgCode: string;
  batchId: string;
  created?: Date;
}

/** Один файл — одна выгрузка. Пачку ограничивает вызывающая сторона: личный
 *  кабинет принимает до 999 записей за раз, и очередь режется на части там,
 *  где она собирается, а не здесь. */
export function buildXml(records: ExportRecord[], meta: ExportMeta): string {
  const created = (meta.created ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<vri-export xmlns="${NS}" batch="${esc(meta.batchId)}" created="${created}"` +
      ` org-name="${esc(meta.orgName)}" org-code="${esc(meta.orgCode)}" count="${records.length}">`,
  ];
  for (const r of records) {
    lines.push(`  <record source-id="${esc(r.id)}">`);
    // «а», «б», «в», «г» — тип, модификация, номер в Госреестре, заводской номер.
    lines.push(`    <mi name="${esc(r.mi_name)}"${r.mi_modification ? ` modification="${esc(r.mi_modification)}"` : ''}` +
      ` grsi="${esc(r.grsi)}" serial="${esc(r.serial)}"/>`);
    lines.push(`    <method>${esc(r.method_doc)}</method>`);                  // «з»
    if (r.etalons) lines.push(`    <etalons>${esc(r.etalons)}</etalons>`);    // «ж»
    lines.push(`    <verified-on>${asDate(r.verified_on)}</verified-on>`);    // «к»
    if (r.valid_to) lines.push(`    <valid-to>${asDate(r.valid_to)}</valid-to>`); // «л»
    lines.push(`    <applicable>${r.applicable ? 'true' : 'false'}</applicable>`); // «м»
    if (!r.applicable) lines.push(`    <fail-reason>${esc(r.fail_reason)}</fail-reason>`); // «у»
    lines.push(`    <verifier>${esc(r.verifier_name)}</verifier>`);           // «р»
    if (r.owner_name) lines.push(`    <owner>${esc(r.owner_name)}</owner>`);  // «т»
    lines.push('  </record>');
  }
  lines.push('</vri-export>', '');
  return lines.join('\n');
}

/** Имя файла выгрузки: по нему руководитель находит её в загрузках, а мы —
 *  в списке выгрузок. */
export const fileNameOf = (batchId: string): string => `arshin-${batchId}.xml`;

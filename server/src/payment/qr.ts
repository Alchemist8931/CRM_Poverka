/* QR-код для экрана поверителя.
 *
 * Провайдер отдаёт строку (у СБП — адрес вида https://qr.nspk.ru/...), а картинку
 * рисуем сами и отдаём SVG: он резкий на любом телефоне и не весит ничего.
 * Библиотека `qrcode` — чистый JavaScript, без нативных зависимостей.
 */
import QRCode from 'qrcode';

/** SVG с QR-кодом. Уровень коррекции M — как рекомендует НСПК для платёжных
 *  ссылок: сканируется с экрана телефона при бликах, но не раздувает код. */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 320 });
}

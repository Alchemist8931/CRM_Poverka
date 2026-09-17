/* Приведение того, что написано в таблице заказчика, к тому, что принимает база.
 *
 * Ни одна функция отсюда не ходит в базу и не бросает исключений: на вход —
 * ячейка как есть, на выход — значение или `null`, если разобрать не вышло.
 * Решение «строку отвергнуть» принимается выше, в refs.mts и clients.mts,
 * и всегда с причиной, которая уедет заказчику в отчёте.
 */

/** Значение ячейки таким, каким его отдаёт exceljs: строка, число, дата, формула. */
export type Cell = unknown;

/** Ячейка в строку: даты, числа и результаты формул — к тексту, пусто — к ''. */
export function text(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(obj.richText)) return obj.richText.map((p) => p.text).join('');
    if (obj.text !== undefined) return text(obj.text);
    if (obj.result !== undefined) return text(obj.result);
    return '';
  }
  return String(value).replace(/ /g, ' ').trim();
}

/** Только цифры — из телефона, номера дома, ИНН. */
export const digits = (value: Cell): string => text(value).replace(/\D/g, '');

/** Пусто ли значение по мнению человека: пустая ячейка, пробелы, прочерк. */
export const blank = (value: Cell): boolean => /^[-—–\s]*$/.test(text(value));

/* ───────────────────────────── телефон ───────────────────────────── */

/** Телефон в десять цифр: без кода страны, без скобок, без восьмёрки.
 *
 *  Десять цифр — это и есть российский номер; всё остальное вокруг них
 *  (8, +7, 7, скобки, дефисы, добавочный через «доб.») — оформление, которое
 *  в старых таблицах у каждого своё. Добавочный отбрасывается: звонить по нему
 *  клиенту всё равно никто не будет, а ключ клиента он бы испортил. */
export function phone10(raw: Cell): string | null {
  let d = digits(String(text(raw)).split(/доб|вн\./i)[0] ?? '');
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('007')) d = d.slice(2);
  if (d.length !== 10) return null;
  // Российский номер начинается с 3, 4, 8 или 9 (коды регионов и мобильных).
  if (!/^[3489]/.test(d)) return null;
  return d;
}

/** Тот же телефон в виде, в котором его хранит база: `+7XXXXXXXXXX`.
 *  Совпадает с `normPhone` из `src/db.ts` на всём, что та разбирает верно. */
export function phoneNorm(raw: Cell): string | null {
  const d = phone10(raw);
  return d ? '+7' + d : null;
}

/* ───────────────────────────── числа и даты ───────────────────────────── */

/** Целое число из ячейки: «1 200 ₽», «1200,00», 1200 — всё это 1200. */
export function integer(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const s = text(value).replace(/[\s₽руб.]/gi, '').replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

/** Дата в виде `ГГГГ-ММ-ДД`.
 *
 *  Разбираются четыре записи, которые встречаются в выгрузках: настоящая дата
 *  Excel, его же число дней от 1900 года, «15.09.2026» и «2026-09-15».
 *  Двузначный год считается двухтысячным: поверки раньше 2000-го в базе нет. */
export function date(value: Cell): string | null {
  if (value instanceof Date) return ymd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Ноль Excel — 30 декабря 1899 года; его же «ошибка 1900 года» уже учтена сдвигом.
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000;
    const d = new Date(ms);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = text(value);
  let m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/.exec(s);
  if (m) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return ymd(year, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function ymd(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** Дата плюс годы межповерочного интервала — когда клиенту пора звонить. */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  // 29 февраля плюс год — 1 марта: Date сдвинет сам, и это ровно то поведение,
  // которое нужно, — срок поверки не может исчезнуть из календаря.
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** «да» / «нет» и их обычные заменители. Непонятное — `null`. */
export function yesNo(value: Cell): boolean | null {
  const s = text(value).toLowerCase();
  if (/^(да|yes|1|\+|есть|true|v|х|x)$/.test(s)) return true;
  if (/^(нет|no|0|-|—|нету|false)$/.test(s)) return false;
  return null;
}

/* ───────────────────────────── справочные мелочи ───────────────────────────── */

const WEEKDAYS: [RegExp, number][] = [
  [/^(вс|воскр)/, 0], [/^(пн|пон)/, 1], [/^(вт|втор)/, 2], [/^(ср|сре)/, 3],
  [/^(чт|чет)/, 4], [/^(пт|пят)/, 5], [/^(сб|суб)/, 6],
];

/** «пн, ср, пт» → `[1,3,5]`. Нумерация та же, что в базе: 0 — воскресенье. */
export function weekdays(value: Cell): number[] {
  const out = new Set<number>();
  for (const part of text(value).toLowerCase().split(/[,;/\s]+/)) {
    if (!part) continue;
    const hit = WEEKDAYS.find(([re]) => re.test(part));
    if (hit) out.add(hit[1]);
  }
  return [...out].sort((a, b) => a - b);
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Латиницей и через дефис: из названия услуги получается её идентификатор. */
export function slug(value: Cell, limit = 24): string {
  const s = text(value).toLowerCase().split('').map((ch) => TRANSLIT[ch] ?? ch).join('');
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, limit).replace(/-$/, '');
}

/** Сокращение города для плиток: «Нижний Тагил» → «НТ», «Асбест» → «АСБ».
 *
 *  Заказчик его не заполняет — в книге такого столбца нет, а на ленте ёмкости
 *  название целиком не помещается. У городов из нескольких слов берутся первые
 *  буквы слов, у остальных — первые три буквы. Уже заведённым городам импорт
 *  сокращение не меняет: руководитель мог поправить его руками. */
export function cityShort(name: string): string {
  const words = text(name).split(/[\s-]+/).filter((w) => /[а-яёa-z]/i.test(w));
  if (words.length > 1) return words.map((w) => w[0]!).join('').toUpperCase().slice(0, 4);
  return (words[0] ?? '').slice(0, 3).toUpperCase();
}

/** Короткое имя услуги для узких мест интерфейса: первое слово и последнее. */
export function shortName(name: string): string {
  const words = text(name).split(/\s+/).filter(Boolean);
  if (words.length < 2) return text(name).slice(0, 24);
  return `${words[0]} ${words[words.length - 1]}`.slice(0, 24);
}

/** ФИО без лишних пробелов и с большой буквы у каждого слова. */
export function personName(value: Cell): string {
  // Большая буква после пробела и после точки: «иванов и.и.» → «Иванов И.И.».
  return text(value).replace(/\s+/g, ' ').trim()
    .replace(/(^|[\s.])([а-яёa-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/** Ключ сравнения названий: без регистра, без «ё» и без лишних пробелов. */
export const key = (value: Cell): string =>
  text(value).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/* ───────────────────────────── адрес ───────────────────────────── */

export interface Address {
  city: string | null;
  street: string;
  house: string;
  flat: string;
  /** Что осталось неразобранным: подъезд, этаж, «за гаражами» и прочее. */
  rest: string;
}

const STREET_KIND = /^(ул|улица|пр|просп|проспект|пер|переулок|б-р|бульвар|ш|шоссе|наб|набережная|пл|площадь|мкр|микрорайон|тракт|проезд)\.?$/i;
const HOUSE_MARK = /^(д|дом|зд|здание)\.?$/i;
const FLAT_MARK = /^(кв|квартира|оф|офис|пом|помещение)\.?$/i;

/** Разбор адреса «по мере возможности».
 *
 *  Старая таблица хранит адрес одной строкой и в каком угодно порядке:
 *  «г. Асбест, ул. Ленина, д. 12, кв. 5», «Ленина 12-5», «Асбест Победы 3а кв1».
 *  Разбираем то, что узнаём, остальное оставляем в `rest` — и всегда сохраняем
 *  исходную строку рядом, чтобы оператору было куда посмотреть.
 *
 *  Города приходят снаружи списком из справочника: угадывать город по словарю
 *  нельзя, он обязан быть тем же, что в таблице `cities`. */
export function parseAddress(raw: Cell, cities: string[] = []): Address {
  let s = text(raw).replace(/\s+/g, ' ').trim();
  const out: Address = { city: null, street: '', house: '', flat: '', rest: '' };
  if (!s) return out;

  // Город. Ищем самое длинное совпадение: «Верхняя Пышма» не должна проиграть «Пышме».
  const byLength = [...cities].sort((a, b) => b.length - a.length);
  for (const city of byLength) {
    const re = new RegExp(`(^|[\\s,.])(г\\.?\\s*)?${escapeRe(key(city)).replace(/ /g, '\\s+')}(?=$|[\\s,.])`, 'i');
    const m = re.exec(key(s));
    if (!m) continue;
    out.city = city;
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    break;
  }
  s = s.replace(/(^|[\s,])(г|город|пгт|п|с|дер|д)\.\s*(?=[А-ЯЁ])/g, '$1').trim();

  // Квартира: «кв. 5», «кв5», «-5» в хвосте после номера дома.
  let m = /(^|[\s,])(кв|квартира|оф|офис|пом)\.?\s*№?\s*([\w-]+)/i.exec(s);
  if (m) {
    out.flat = m[3]!;
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  }

  // Хвост про подъезд, этаж и домофон отрезаем сразу: иначе «подъезд 2» посоперничает
  // с номером дома, и адрес уедет не туда.
  const tail = /(^|[\s,])(под(ъезд)?|эт(аж)?|домофон|звонить|тел)(?=$|[\s.,:№])/i.exec(s);
  if (tail) {
    out.rest = s.slice(tail.index).replace(/^[\s,]+/, '');
    s = s.slice(0, tail.index).trim();
  }

  // Дом: «д. 12», «12а», «12 к 3», «12/5» (косая — часть номера дома),
  // «12-5» (дефис отделяет квартиру — так пишут в половине старых таблиц).
  const HOUSE = String.raw`\d+\s*[а-яa-z]?(?:\s*\/\s*\d+[а-яa-z]?)?(?:\s*(?:к|корп|корпус|стр|литера|лит)\.?\s*\w+)?`;
  const FLAT_TAIL = String.raw`(?:\s*[-–—]\s*(\d+[а-яa-z]?))?`;
  m = new RegExp(`(^|[\\s,])(?:д|дом|зд)\\.?\\s*№?\\s*(${HOUSE})${FLAT_TAIL}(?=$|[\\s,])`, 'i').exec(s);
  if (!m) {
    // Без «д.» берём последнее число в строке, а не первое: в «8 Марта 12-5»
    // первое — это название улицы, и дом там двенадцатый.
    const all = [...s.matchAll(new RegExp(`(^|[\\s,])(${HOUSE})${FLAT_TAIL}(?=$|[\\s,])`, 'gi'))];
    m = all[all.length - 1] ?? null;
  }
  if (m) {
    out.house = m[2]!.replace(/\s+/g, '');
    if (m[3] && !out.flat) out.flat = m[3];
    s = (s.slice(0, m.index! + m[1]!.length) + ' ' + s.slice(m.index! + m[0].length)).replace(/\s+/g, ' ').trim();
  }

  // Улица: то, что осталось, без слова «улица» и без запятых.
  out.street = s.split(/[\s,]+/).filter(Boolean)
    .filter((w) => !STREET_KIND.test(w) && !HOUSE_MARK.test(w) && !FLAT_MARK.test(w))
    .join(' ').replace(/^[-,\s]+|[-,\s]+$/g, '');
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ключ адреса для склейки: важно только то, куда ехать. */
export const addressKey = (a: Address): string =>
  [a.city ?? '', key(a.street), key(a.house), key(a.flat)].join('|');

/* ───────────────────────────── приборы в ячейке ───────────────────────────── */

export interface DeviceRef { type: string; serial: string }

/** Перечень приборов из одной ячейки.
 *
 *  Пишут по-разному: «Бетар СХВ-15 №12345678, Бетар СГВ-15 №12345679»,
 *  «2 шт СХВ-15», «ХВС, ГВС». Разделители — точка с запятой, запятая, перевод
 *  строки; заводской номер — после решётки, «зав.№» или просто длинное число. */
export function devices(value: Cell): DeviceRef[] {
  const cell = text(value);
  if (!cell) return [];
  return cell.split(/[;\n]|(?<=\D),(?=\s*\D)/).map((part) => {
    let s = part.trim();
    let serial = '';
    const m = /(?:№|N|зав\.?\s*№?|s\/n)\s*([\w-]+)/i.exec(s);
    if (m) {
      serial = m[1]!;
      s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim();
    } else {
      const bare = /(^|\s)(\d{6,})(?=$|\s)/.exec(s);
      if (bare) {
        serial = bare[2]!;
        s = (s.slice(0, bare.index) + ' ' + s.slice(bare.index + bare[0].length)).trim();
      }
    }
    return { type: s.replace(/^[-,\s]+|[-,\s]+$/g, '').replace(/\s+/g, ' '), serial };
  }).filter((d) => d.type || d.serial);
}

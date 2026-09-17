/* Карта столбцов клиентской базы.
 *
 * Книгу справочников заказчик заполняет по нашему шаблону, и там столбцы
 * известны. Клиентская база приходит как есть: выгрузка из 1С, таблица
 * менеджера, чей-то экспорт из старой программы. Поэтому соответствие
 * «поле системы → как столбец назван у заказчика» вынесено в конфиг: увидели
 * файл — дописали синонимы, а не полезли править код импорта.
 *
 * Значения по умолчанию покрывают обычные названия. Конфиг их дополняет:
 * названия из конфига идут первыми, встроенные остаются запасным вариантом.
 */
import { readFileSync } from 'node:fs';

export interface ColumnMap {
  /** Поле → названия столбцов, под которыми оно встречается. */
  columns: Record<string, string[]>;
  /** Лист книги. Не задан — берётся первый, где нашёлся столбец с телефоном. */
  sheet?: string;
  /** Город, который подставляется, когда в строке его нет. */
  city?: string;
}

/** Поля, которые импорт умеет разложить по базе. */
export const FIELDS = [
  'name', 'phone', 'phone2', 'city', 'address', 'street', 'house', 'flat',
  'verified_on', 'devices', 'serial', 'email', 'inn', 'note',
] as const;

export const DEFAULT_MAP: ColumnMap = {
  columns: {
    name: ['ФИО', 'ФИО клиента', 'Клиент', 'Наименование', 'Контрагент', 'Фамилия Имя Отчество', 'Заказчик'],
    phone: ['Телефон', 'Телефон клиента', 'Мобильный телефон', 'Контактный телефон', 'Номер телефона', 'Тел'],
    phone2: ['Второй телефон', 'Доп. телефон', 'Дополнительный телефон', 'Телефон 2'],
    city: ['Город', 'Населённый пункт', 'Нас. пункт'],
    address: ['Адрес', 'Адрес объекта', 'Адрес клиента', 'Полный адрес'],
    street: ['Улица'],
    house: ['Дом', 'Номер дома'],
    flat: ['Квартира', 'Кв', 'Кв.'],
    verified_on: ['Дата последней поверки', 'Дата поверки', 'Последняя поверка', 'Поверен', 'Дата'],
    devices: ['Приборы', 'Прибор', 'Счётчики', 'Счётчик', 'Тип прибора', 'Оборудование'],
    serial: ['Заводской номер', 'Заводской №', 'Номер прибора', 'Серийный номер'],
    email: ['Email', 'Почта', 'Электронная почта', 'E-mail'],
    inn: ['ИНН'],
    note: ['Примечание', 'Комментарий', 'Пометка'],
  },
};

/** Конфиг с диска поверх встроенной карты. */
export function loadMap(file: string | null): ColumnMap {
  if (!file) return DEFAULT_MAP;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ColumnMap>;
  const columns: Record<string, string[]> = {};
  for (const field of FIELDS) {
    const own = raw.columns?.[field];
    const mine = own === undefined ? [] : Array.isArray(own) ? own : [String(own)];
    columns[field] = [...mine, ...(DEFAULT_MAP.columns[field] ?? [])];
  }
  const unknown = Object.keys(raw.columns ?? {}).filter((f) => !FIELDS.includes(f as never));
  if (unknown.length) {
    throw new Error(`в карте столбцов названы поля, которых у импорта нет: ${unknown.join(', ')}. ` +
      `Известные поля: ${FIELDS.join(', ')}.`);
  }
  return { columns, sheet: raw.sheet, city: raw.city };
}

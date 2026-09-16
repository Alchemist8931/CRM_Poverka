/* Бизнес-правила «Учёткина».
 *
 * Всё, что здесь лежит, до этого пункта жило в `index.html` и считалось прямо в
 * браузере поверх состояния в памяти. Теперь правило одно и то же для прототипа,
 * API и будущего фронта на API, а его смысл не изменился ни в одном знаке:
 * пороги, округления и тексты отказов перенесены дословно.
 *
 * Функции здесь чистые: на вход — готовые данные, на выход — решение. Ни запросов
 * к базе, ни обращений к текущему времени внутри. Из-за этого правила проверяются
 * тестами без базы и без поднятого сервера (`npm test`, `test/rules.test.ts`),
 * а обработчики API занимаются только тем, что достают данные и применяют решение.
 */

/** Не больше пяти городов на день: столько строк помещается в ячейку ленты ёмкости. */
export const MAX_CITIES = 5;
/** Столько операторов помещается в столбец на миниатюре дня. */
export const MAX_OPS = 4;

/** Роли: те же четыре, что в `staff.role`. */
export type Role = 'operator' | 'senior' | 'supervisor' | 'verifier';

/* ────────────────────────── планирование дня ────────────────────────── */

/** Запись дня: города приёма, план по каждому, смена поверителей и операторов. */
export interface DayPlan {
  date: string;
  cities: string[];
  /** План по городам: `{"Екатеринбург": 25}`. В прототипе это `caps`. */
  plan: Record<string, number>;
  crew: string[];
  ops: string[];
}

/** Загрузка дня или города: план, записано, доля и состояние плитки. */
export interface DayLoad {
  p: number;
  b: number;
  pct: number;
  s: 'off' | 'over' | 'full' | 'fill' | 'free';
}

/** Пороги плитки взяты из прототипа без изменений: приём закрывается на +10 %. */
function load(p: number, b: number): DayLoad {
  const pct = p ? b / p : 0;
  return { p, b, pct, s: p === 0 ? 'off' : pct > 1.1 ? 'over' : pct >= 1 ? 'full' : pct >= 0.5 ? 'fill' : 'free' };
}

/** Города приёма на дату. Дня нет — бригада не выезжает. */
export const dayCities = (day: DayPlan | null | undefined): string[] => day?.cities ?? [];

/** План по городу. Город не назначен на дату — плана по нему нет. */
export const capOf = (day: DayPlan | null | undefined, city: string): number => Number(day?.plan?.[city] ?? 0);

/** План дня — сумма планов по городам приёма. */
export const planFor = (day: DayPlan | null | undefined): number =>
  dayCities(day).reduce((a, c) => a + capOf(day, c), 0);

/** Загрузка дня целиком: план по всем городам против записанных заявок. */
export const dayTotal = (day: DayPlan | null | undefined, bookedOnDate: number): DayLoad =>
  load(planFor(day), bookedOnDate);

/** Разрез дня по городу: у каждого города приёма свой план, заданный руководителем.
 *  Город на дату не назначен — вопрос бессмысленный, и ответом идёт день целиком. */
export function dayState(
  day: DayPlan | null | undefined,
  city: string | null | undefined,
  bookedInCity: number,
  bookedOnDate: number,
): DayLoad {
  if (!city || !dayCities(day).includes(city)) return dayTotal(day, bookedOnDate);
  return load(capOf(day, city), bookedInCity);
}

/** Что известно про дату в момент проверки замка. */
export interface LockFacts {
  /** У руководителя открыт конструктор маршрутов на эту дату. */
  building?: boolean;
  /** На дату уже собран хотя бы один маршрут. */
  hasRoutes?: boolean;
}

/** Дата уходит под маршруты: как только руководитель сел её собирать или собрал
 *  хотя бы один маршрут, оператор на неё больше не записывает — состав дня зафиксирован.
 *  Возвращает причину замка человеческими словами или `null`, если дата открыта. */
export function dayLock(facts: LockFacts): string | null {
  if (facts.building) return 'идёт сборка маршрутов';
  if (facts.hasRoutes) return 'маршруты на дату уже собраны';
  return null;
}

/** Руководитель — исключение: он ставит заявку в готовый маршрут даже во время выезда. */
export const lockedFor = (facts: LockFacts, role: Role): string | null =>
  role === 'supervisor' ? null : dayLock(facts);

/** Полон ли город для подсказки дат: плана нет или он выбран целиком.
 *  Такую дату оператору не предлагают, хотя записать на неё ещё можно. */
export function cityFull(state: DayLoad): boolean {
  return state.p === 0 || state.pct >= 1;
}

/** Потолок по городу на приёме. Плитка дня краснеет на +10 % от плана — там же
 *  проходит и граница приёма: до +10 % оператор дописывает адрес сам (клиенты
 *  отваливаются, бригада успевает), дальше запись по городу закрыта.
 *  Руководитель ставит заявку руками в любом случае — он и отвечает за перебор.
 *
 *  `state` — каким день станет с новой заявкой, а не каким он был до неё:
 *  отказывать нужно до записи, иначе перебор случается и только потом
 *  замечается. */
export function cityCapProblem(
  day: DayPlan | null | undefined,
  city: string,
  state: DayLoad,
  role: Role,
): string | null {
  if (role === 'supervisor') return null;
  if (!dayCities(day).includes(city)) return `В этот день бригада в город ${city} не выезжает — выберите другую дату или город.`;
  if (state.p === 0) return `План приёма по городу ${city} на эту дату не задан — записывать некуда.`;
  if (state.s === 'over')
    return `План по городу ${city} на эту дату перебран: записано ${state.b} из ${state.p}. Приём по городу закрыт — возьмите соседнюю дату.`;
  return null;
}

/* ─────────────────────────── подсказка дат ─────────────────────────── */

/** Дата-кандидат для подсказки: запись дня, замок, сколько записано и кто в смене. */
export interface SlotDay {
  date: string;
  day: DayPlan | null;
  lock: LockFacts;
  bookedOnDate: number;
  bookedInCity: number;
  /** Смена поверителей на дату за вычетом согласованных отсутствий, с компетенциями. */
  crew: { id: string; svcs: string[] }[];
}

export interface Slot {
  ds: string;
  plan: number;
  free: number;
  crew: number;
}

/** Умеет ли поверитель закрыть все выбранные услуги разом. */
export const canDoAll = (svcs: string[], ids: string[]): boolean => ids.every((id) => svcs.includes(id));

/** Ближайшие даты под выбранные услуги и город: бригада едет в этот город,
 *  план по нему ещё не закрыт, дата не ушла под маршруты и в смене есть
 *  поверитель, закрывающий все выбранные услуги.
 *
 *  Замок считается по мерке оператора и тогда, когда подсказку смотрит руководитель:
 *  подсказка нужна для приёма, а не для того, чтобы показать обход правила. */
export function slotsFor(days: SlotDay[], ids: string[], city?: string | null, limit = 14): Slot[] {
  const out: Slot[] = [];
  for (const d of days) {
    if (out.length >= limit) break;
    const cs = dayCities(d.day);
    if (!cs.length || lockedFor(d.lock, 'operator')) continue;
    if (city && !cs.includes(city)) continue;
    const t = city ? dayState(d.day, city, d.bookedInCity, d.bookedOnDate) : dayTotal(d.day, d.bookedOnDate);
    if (cityFull(t)) continue;
    const crew = d.crew.filter((p) => canDoAll(p.svcs, ids));
    if (!crew.length) continue;
    out.push({ ds: d.date, plan: t.p, free: Math.max(0, t.p - t.b), crew: crew.length });
  }
  return out;
}

/** Что можно выполнить в этот день — объединение компетенций назначенной смены. */
export function worksOn(crew: { svcs: string[] }[]): string[] {
  const have = new Set<string>();
  crew.forEach((p) => p.svcs.forEach((id) => have.add(id)));
  return [...have];
}

/* ──────────────────────────── деньги ──────────────────────────── */

/** Услуга из справочника — ровно те столбцы, от которых зависят деньги. */
export interface Service {
  id: string;
  price_person: number;
  price_pensioner: number;
  price_org: number;
  rate_verifier: number;
  rate_operator: number;
}

/** Строка прибора в акте. Скидка стоит на приборе, а не на заявке: на одном
 *  адресе пенсионер поверяет свой счётчик, а второй стоит на соседа. */
export interface ActDevice {
  service_id: string;
  pensioner?: boolean;
}

export type ClientType = 'Физлицо' | 'Юрлицо';

/** Цена одной строки прибора. Юрлицу — тариф юрлица, пенсионная скидка к нему
 *  не применяется: счёт выставляется организации, а не человеку. */
export function priceOfDevice(svc: Service | undefined, clientType: ClientType, pensioner = false): number {
  if (!svc) return 0;
  return clientType === 'Юрлицо' ? svc.price_org : pensioner ? svc.price_pensioner : svc.price_person;
}

const svcOf = (services: Map<string, Service>, d: ActDevice) => services.get(d.service_id);

/** Цена акта: сумма по строкам приборов. */
export const priceOf = (services: Map<string, Service>, clientType: ClientType, devices: ActDevice[]): number =>
  devices.reduce((a, d) => a + priceOfDevice(svcOf(services, d), clientType, !!d.pensioner), 0);

/** Скидка пенсионеру — за счёт компании: сдельные ставки от неё не зависят. */
export const discountOf = (services: Map<string, Service>, clientType: ClientType, devices: ActDevice[]): number =>
  clientType === 'Юрлицо'
    ? 0
    : devices.reduce((a, d) => {
        const s = svcOf(services, d);
        return a + (s && d.pensioner ? s.price_person - s.price_pensioner : 0);
      }, 0);

/** Сдельная поверителю: по услуге в каждой строке прибора, без оглядки на скидку и тип клиента. */
export const rateV = (services: Map<string, Service>, devices: ActDevice[]): number =>
  devices.reduce((a, d) => a + (svcOf(services, d)?.rate_verifier ?? 0), 0);

/** Сдельная оператору — по тем же строкам. */
export const rateO = (services: Map<string, Service>, devices: ActDevice[]): number =>
  devices.reduce((a, d) => a + (svcOf(services, d)?.rate_operator ?? 0), 0);

/** Счёт выставляется только юрлицу — физлицу этот способ не показываем. */
export const PAY_METHODS = ['наличные', 'перевод на карту', 'по счёту', 'не оплачено'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const payMethods = (clientType: ClientType): PayMethod[] =>
  PAY_METHODS.filter((m) => m !== 'по счёту' || clientType === 'Юрлицо');
/** В подотчёт попадает лишь то, что поверитель забрал лично: деньги по счёту
 *  идут сразу на расчётный счёт и через его руки не проходят. */
export const PAY_HAND: PayMethod[] = ['наличные', 'перевод на карту'];

/* ──────────────────────── приём и правка заявки ──────────────────────── */

export interface RequestForm {
  client_type: ClientType;
  name: string;
  inn?: string;
  phone: string;
  phone2?: string;
  email?: string;
  city?: string;
  house: string;
  time_slot?: number;
}

export const digitsOf = (v: unknown): string => String(v ?? '').replace(/\D/g, '').slice(-10);
export const mailOk = (v: unknown): boolean => !String(v ?? '').trim() || /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(v).trim());

/** Что не так с заявкой. Тексты — те же, что видит оператор в прототипе:
 *  человек на линии читает их клиенту вслух, менять формулировки нельзя. */
export function reqProblem(K: RequestForm, cities: string[]): string | null {
  if (!String(K.name ?? '').trim()) return K.client_type === 'Юрлицо' ? 'Укажите название организации.' : 'Укажите ФИО клиента.';
  if (K.client_type === 'Юрлицо') {
    const inn = String(K.inn ?? '').replace(/\D/g, '');
    if (!inn) return 'Для юрлица ИНН обязателен — без него не выставить счёт и закрывающие.';
    if (inn.length !== 10 && inn.length !== 12) return 'ИНН — 10 цифр у организации или 12 у ИП. Сейчас ' + inn.length + '.';
  }
  if (!String(K.phone ?? '').trim()) return 'Укажите телефон — по нему пойдёт прозвонка маршрута.';
  if (digitsOf(K.phone).length !== 10) return 'Телефон неполный: нужно 10 цифр после +7.';
  if (K.phone2 && digitsOf(K.phone2).length !== 10) return 'Дополнительный телефон неполный: нужно 10 цифр после +7.';
  if (!mailOk(K.email)) return 'Почта клиента введена с ошибкой — поправьте или очистите поле.';
  if (!(K.city || cities[0])) return 'В этот день бригада не выезжает — выберите другую дату.';
  if (!String(K.house ?? '').trim()) return 'Укажите номер дома.';
  if (K.time_slot != null && (K.time_slot < 10 || K.time_slot > 20)) return 'Окно приезда — с 10 до 20 часов.';
  return null;
}

/** Окно приезда сдвигается по часам и не выходит за рабочий день бригады. */
export const SLOT_MIN = 10;
export const SLOT_MAX = 20;
export const canShift = (slot: number, d: number): boolean => slot + d >= SLOT_MIN && slot + d <= SLOT_MAX;

/* ──────────────────────────── акт ──────────────────────────── */

export const FAIL_REASONS = ['Погрешность выше допуска', 'Механическое повреждение', 'Нечитаемый номер', 'Другое'] as const;
export const WAIT_REASONS = ['Нет дома', 'Отказ на месте', 'Нет доступа к прибору', 'Перенос по просьбе клиента', 'Другое'] as const;

/** Строка прибора глазами правил закрытия позиции. */
export interface CloseDevice {
  service_id?: string | null;
  serial?: string | null;
  bad?: boolean;
  bad_reason?: string | null;
  bad_note?: string | null;
  blank?: boolean;
  blank_no?: string | null;
}

/** Заводской номер не спрашиваем там, где его как раз и не смогли прочитать. */
export const needSerial = (d: CloseDevice): boolean => !(d.bad && d.bad_reason === 'Нечитаемый номер');

/** Можно ли закрыть позицию. Порядок проверок и тексты — из прототипа: поверитель
 *  читает их с телефона на адресе и по ним понимает, что дописать в акт. */
export function closeProblem(devices: CloseDevice[], unserved: boolean): string | null {
  if (unserved) return 'Точка отмечена не обслуженной — сначала верните её в работу.';
  if (!devices.length) return 'В акте нет приборов — закрывать нечего.';
  if (devices.some((d) => !d.service_id)) return 'В каждой строке прибора выберите услугу.';
  if (devices.some((d) => needSerial(d) && !String(d.serial ?? '').trim()))
    return 'Заполните заводские номера приборов — они уходят в реестр УК. Пустым номер остаётся только у прибора с причиной «нечитаемый номер».';
  if (devices.some((d) => d.bad && d.bad_reason === 'Другое' && !String(d.bad_note ?? '').trim()))
    return 'Причина непригодности «другое» — опишите словами: это уйдёт в свидетельство и в «Аршин».';
  if (devices.some((d) => d.bad && d.blank && !String(d.blank_no ?? '').trim()))
    return 'Укажите номер выданного бланка о непригодности — по нему руководитель сверяет бумажную нумерацию.';
  return null;
}

/** Причина «другое» без пояснения бесполезна оператору: звонить клиенту не с чем. */
export function unservedProblem(reason: string, note: string): string | null {
  if (!(WAIT_REASONS as readonly string[]).includes(reason)) return 'Выберите причину из списка.';
  if (reason === 'Другое' && !String(note ?? '').trim())
    return 'Причина «другое» — опишите словами, оператор будет звонить клиенту.';
  return null;
}

/** Чем меняют непригодный прибор: воду — заменой счётчика, тепло — монтажом
 *  теплосчётчика. Берётся из справочника услуг (`services.replacement_service`). */
export const replacementOf = (svc: { replacement_service?: string | null } | undefined): string | null =>
  svc?.replacement_service ?? null;

/* ──────────────────────── состав смены и день ──────────────────────── */

/** Что не так с записью дня: потолки по городам и операторам, состав смены.
 *  Тексты — те же, что в прототипе показывались всплывающей подсказкой. */
export function dayProblem(
  d: { cities: string[]; plan: Record<string, number>; crew: string[]; ops: string[] },
  known: { cities: Set<string>; verifiers: Set<string>; operators: Set<string> },
): string | null {
  if (d.cities.length > MAX_CITIES)
    return `На день можно назначить не больше ${MAX_CITIES} городов — иначе они не поместятся в ленту ёмкости. Снимите лишний.`;
  if (d.ops.length > MAX_OPS) return `На смену можно поставить не больше ${MAX_OPS} операторов. Снимите кого-то из назначенных.`;
  const badCity = d.cities.find((c) => !known.cities.has(c));
  if (badCity) return `Города «${badCity}» нет в справочнике.`;
  const badPlan = Object.keys(d.plan).find((c) => !d.cities.includes(c));
  if (badPlan) return `План задан по городу «${badPlan}», а он не в городах приёма на эту дату.`;
  const negative = Object.entries(d.plan).find(([, n]) => !Number.isInteger(n) || n < 0);
  if (negative) return `План по городу «${negative[0]}» должен быть целым неотрицательным числом.`;
  const badCrew = d.crew.find((id) => !known.verifiers.has(id));
  if (badCrew) return `В смену поверителей поставлен «${badCrew}» — такого поверителя нет или он заблокирован.`;
  const badOp = d.ops.find((id) => !known.operators.has(id));
  if (badOp) return `В смену операторов поставлен «${badOp}» — такого оператора нет или он заблокирован.`;
  if (new Set(d.crew).size !== d.crew.length) return 'Один и тот же поверитель поставлен в смену дважды.';
  if (new Set(d.ops).size !== d.ops.length) return 'Один и тот же оператор поставлен в смену дважды.';
  return null;
}

/* ─────────────────────── доступ по ролям ─────────────────────── */

/** Прайс и ставки меняет только руководитель: это деньги компании и сдельная
 *  оплата бригады, а не настройка экрана. */
export const canEditPrices = (role: Role): boolean => role === 'supervisor';

/** Свой заработок видит каждый, чужой — только руководитель. */
export const canSeeEarningsOf = (role: Role, me: string, staffId: string): boolean =>
  role === 'supervisor' || me === staffId;

/** Поверитель видит только свои маршруты. Остальные роли ведут выезды по связи
 *  и видят все: оператор звонит по чужому маршруту, когда дежурит на линии. */
export const canSeeRoute = (role: Role, me: string, verifierId: string | null): boolean =>
  role !== 'verifier' || verifierId === me;

/** Планирование дня, сборка маршрутов, справочники — руки руководителя. */
export const canPlan = (role: Role): boolean => role === 'supervisor';

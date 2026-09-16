/* Правила, перенесённые из прототипа. Проверяются без базы и без сервера:
 * на вход готовые данные, на выход решение — ровно то, ради чего правила и
 * вынесены в отдельный файл.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_CITIES, MAX_OPS, canShift, cityCapProblem, closeProblem, dayLock, dayProblem, dayState,
  dayTotal, discountOf, lockedFor, needSerial, priceOf, rateO, rateV, reqProblem, slotsFor,
  unservedProblem, type DayPlan, type Service, type SlotDay,
} from '../src/rules.ts';

/* Прайс прототипа: те же числа, что на экране «Услуги и ставки». */
const SERVICES = new Map<string, Service>([
  ['wv', { id: 'wv', price_person: 900, price_pensioner: 760, price_org: 1200, rate_verifier: 280, rate_operator: 45 }],
  ['wr', { id: 'wr', price_person: 2600, price_pensioner: 2200, price_org: 3200, rate_verifier: 750, rate_operator: 70 }],
  ['hv', { id: 'hv', price_person: 3400, price_pensioner: 2900, price_org: 4100, rate_verifier: 950, rate_operator: 90 }],
]);

const DAY: DayPlan = {
  date: '2026-09-20',
  cities: ['Екатеринбург', 'Нижний Тагил'],
  plan: { 'Екатеринбург': 25, 'Нижний Тагил': 10 },
  crew: ['v0', 'v1'],
  ops: ['o0'],
};

describe('замок даты: оператор не записывает на дату, ушедшую под маршруты', () => {
  it('открытый конструктор маршрутов закрывает дату для оператора', () => {
    assert.equal(dayLock({ building: true }), 'идёт сборка маршрутов');
    assert.equal(lockedFor({ building: true }, 'operator'), 'идёт сборка маршрутов');
    assert.equal(lockedFor({ building: true }, 'senior'), 'идёт сборка маршрутов');
  });

  it('собранный маршрут закрывает дату для оператора', () => {
    assert.equal(dayLock({ hasRoutes: true }), 'маршруты на дату уже собраны');
    assert.equal(lockedFor({ hasRoutes: true }, 'operator'), 'маршруты на дату уже собраны');
  });

  it('руководитель — исключение: замок его не касается', () => {
    assert.equal(lockedFor({ building: true, hasRoutes: true }, 'supervisor'), null);
  });

  it('без конструктора и маршрутов дата открыта', () => {
    assert.equal(dayLock({}), null);
    assert.equal(lockedFor({}, 'operator'), null);
  });
});

describe('план по городу и потолок приёма', () => {
  it('день считается по сумме планов городов', () => {
    const t = dayTotal(DAY, 7);
    assert.equal(t.p, 35);
    assert.equal(t.b, 7);
    assert.equal(t.s, 'free');
  });

  it('разрез по городу берёт план этого города', () => {
    const s = dayState(DAY, 'Нижний Тагил', 5, 7);
    assert.equal(s.p, 10);
    assert.equal(s.b, 5);
    assert.equal(s.s, 'fill');
  });

  it('город не в дне приёма — отвечает день целиком', () => {
    assert.deepEqual(dayState(DAY, 'Асбест', 0, 7), dayTotal(DAY, 7));
  });

  it('состояние плитки: свободно, наполняется, полно, перебор на +10 %', () => {
    assert.equal(dayState(DAY, 'Нижний Тагил', 4, 4).s, 'free');
    assert.equal(dayState(DAY, 'Нижний Тагил', 5, 5).s, 'fill');
    assert.equal(dayState(DAY, 'Нижний Тагил', 10, 10).s, 'full');
    assert.equal(dayState(DAY, 'Нижний Тагил', 11, 11).s, 'full', 'ровно +10 % — ещё не перебор');
    assert.equal(dayState(DAY, 'Нижний Тагил', 12, 12).s, 'over');
  });

  it('потолок по городу: оператору отказ на переборе, руководителю — нет', () => {
    const over = dayState(DAY, 'Нижний Тагил', 12, 12);
    const bad = cityCapProblem(DAY, 'Нижний Тагил', over, 'operator');
    assert.match(String(bad), /Приём по городу закрыт/);
    assert.equal(cityCapProblem(DAY, 'Нижний Тагил', over, 'supervisor'), null);
  });

  it('до потолка оператор записывает сам', () => {
    assert.equal(cityCapProblem(DAY, 'Нижний Тагил', dayState(DAY, 'Нижний Тагил', 11, 11), 'operator'), null);
  });

  it('города нет в дне приёма или план не задан — записывать некуда', () => {
    assert.match(String(cityCapProblem(DAY, 'Асбест', dayState(DAY, 'Асбест', 0, 0), 'operator')),
      /не выезжает/);
    const noPlan: DayPlan = { ...DAY, cities: ['Асбест'], plan: {} };
    assert.match(String(cityCapProblem(noPlan, 'Асбест', dayState(noPlan, 'Асбест', 0, 0), 'operator')),
      /План приёма по городу/);
  });
});

describe('подсказка дат под услуги и город с учётом компетенций смены', () => {
  const mk = (over: Partial<SlotDay>): SlotDay => ({
    date: '2026-09-20', day: DAY, lock: {}, bookedOnDate: 0, bookedInCity: 0,
    crew: [{ id: 'v0', svcs: ['wv', 'wr'] }, { id: 'v1', svcs: ['wv'] }], ...over,
  });

  it('дата предлагается, когда в смене есть поверитель на все выбранные услуги', () => {
    const slots = slotsFor([mk({})], ['wv', 'wr'], 'Екатеринбург');
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.crew, 1, 'обе услуги закрывает только v0');
    assert.equal(slots[0]!.plan, 25);
    assert.equal(slots[0]!.free, 25);
  });

  it('услугу не умеет никто в смене — даты нет', () => {
    assert.deepEqual(slotsFor([mk({})], ['hv'], 'Екатеринбург'), []);
  });

  it('закрытая замком дата в подсказку не идёт даже руководителю', () => {
    assert.deepEqual(slotsFor([mk({ lock: { hasRoutes: true } })], ['wv'], 'Екатеринбург'), []);
  });

  it('город без выезда и выбранный план целиком пропускаются', () => {
    assert.deepEqual(slotsFor([mk({})], ['wv'], 'Асбест'), []);
    assert.deepEqual(slotsFor([mk({ bookedInCity: 25 })], ['wv'], 'Екатеринбург'), []);
  });

  it('выходной день (города не назначены) не предлагается', () => {
    assert.deepEqual(slotsFor([mk({ day: null })], ['wv'], null), []);
  });

  it('подсказка отдаёт не больше запрошенного числа дат', () => {
    const days = [mk({ date: '2026-09-20' }), mk({ date: '2026-09-21' }), mk({ date: '2026-09-22' })];
    assert.equal(slotsFor(days, ['wv'], 'Екатеринбург', 2).length, 2);
  });
});

describe('цена акта: пенсионер и юрлицо', () => {
  const two = [{ service_id: 'wv', pensioner: false }, { service_id: 'wv', pensioner: true }];

  it('физлицо платит по прайсу, пенсионеру скидка на его приборе', () => {
    assert.equal(priceOf(SERVICES, 'Физлицо', two), 900 + 760);
    assert.equal(discountOf(SERVICES, 'Физлицо', two), 140);
  });

  it('скидка стоит на приборе, а не на заявке', () => {
    const one = [{ service_id: 'wv', pensioner: true }];
    assert.equal(priceOf(SERVICES, 'Физлицо', one), 760);
    assert.equal(priceOf(SERVICES, 'Физлицо', [{ service_id: 'wv', pensioner: false }]), 900);
  });

  it('юрлицо платит по своему тарифу, пенсионная скидка к нему не применяется', () => {
    assert.equal(priceOf(SERVICES, 'Юрлицо', two), 1200 * 2);
    assert.equal(discountOf(SERVICES, 'Юрлицо', two), 0);
  });

  it('разные услуги на одном адресе считаются построчно', () => {
    const mix = [{ service_id: 'wv', pensioner: false }, { service_id: 'wr', pensioner: false }];
    assert.equal(priceOf(SERVICES, 'Физлицо', mix), 900 + 2600);
  });
});

describe('сдельные ставки не зависят от скидки и типа клиента', () => {
  const mix = [{ service_id: 'wv', pensioner: false }, { service_id: 'wr', pensioner: true }];

  it('ставка поверителя одна и та же при скидке и без неё', () => {
    assert.equal(rateV(SERVICES, mix), 280 + 750);
    assert.equal(rateV(SERVICES, mix.map((d) => ({ ...d, pensioner: false }))), 280 + 750);
  });

  it('ставка оператора не зависит от того, кто платит', () => {
    assert.equal(rateO(SERVICES, mix), 45 + 70);
  });

  it('скидка пенсионеру идёт за счёт компании: цена падает, начисление — нет', () => {
    const pens = [{ service_id: 'wv', pensioner: true }];
    const plain = [{ service_id: 'wv', pensioner: false }];
    assert.ok(priceOf(SERVICES, 'Физлицо', pens) < priceOf(SERVICES, 'Физлицо', plain));
    assert.equal(rateV(SERVICES, pens), rateV(SERVICES, plain));
    assert.equal(rateO(SERVICES, pens), rateO(SERVICES, plain));
  });
});

describe('потолки планирования дня: пять городов и четыре оператора', () => {
  const known = {
    cities: new Set(['Екатеринбург', 'Нижний Тагил', 'Каменск-Уральский', 'Асбест', 'Ревда', 'Серов']),
    verifiers: new Set(['v0', 'v1', 'v2']),
    operators: new Set(['o0', 'o1', 'o2', 'o3', 'o4']),
  };
  const base = { cities: ['Екатеринбург'], plan: { 'Екатеринбург': 10 }, crew: ['v0'], ops: ['o0'] };

  it('пять городов проходят, шестой — нет', () => {
    assert.equal(MAX_CITIES, 5);
    const five = [...known.cities].slice(0, 5);
    assert.equal(dayProblem({ ...base, cities: five, plan: Object.fromEntries(five.map((c) => [c, 5])) }, known), null);
    const six = [...known.cities].slice(0, 6);
    assert.match(String(dayProblem({ ...base, cities: six, plan: Object.fromEntries(six.map((c) => [c, 5])) }, known)),
      /не больше 5 городов/);
  });

  it('четыре оператора на смену проходят, пятый — нет', () => {
    assert.equal(MAX_OPS, 4);
    assert.equal(dayProblem({ ...base, ops: ['o0', 'o1', 'o2', 'o3'] }, known), null);
    assert.match(String(dayProblem({ ...base, ops: ['o0', 'o1', 'o2', 'o3', 'o4'] }, known)),
      /не больше 4 операторов/);
  });

  it('в смену не поставить чужого, неизвестного или одного и того же дважды', () => {
    assert.match(String(dayProblem({ ...base, crew: ['o0'] }, known)), /такого поверителя нет/);
    assert.match(String(dayProblem({ ...base, ops: ['v0'] }, known)), /такого оператора нет/);
    assert.match(String(dayProblem({ ...base, crew: ['v0', 'v0'] }, known)), /дважды/);
  });

  it('план задаётся только по городам приёма этой даты', () => {
    assert.match(String(dayProblem({ ...base, plan: { 'Ревда': 5 } }, known)), /не в городах приёма/);
  });
});

describe('закрытие позиции: услуга и заводской номер обязательны', () => {
  const ok = [{ service_id: 'wv', serial: '12345678' }];

  it('заполненный акт закрывается', () => {
    assert.equal(closeProblem(ok, false), null);
  });

  it('пустой акт закрывать нечем', () => {
    assert.match(String(closeProblem([], false)), /нет приборов/);
  });

  it('строка без услуги не проходит', () => {
    assert.match(String(closeProblem([{ serial: '1' }], false)), /выберите услугу/i);
  });

  it('пустой заводской номер не проходит', () => {
    assert.match(String(closeProblem([{ service_id: 'wv', serial: '  ' }], false)), /заводские номера/i);
  });

  it('номер не спрашивается только у прибора с причиной «нечитаемый номер»', () => {
    const unreadable = { service_id: 'wv', serial: '', bad: true, bad_reason: 'Нечитаемый номер' };
    assert.equal(needSerial(unreadable), false);
    assert.equal(closeProblem([unreadable], false), null);
    const other = { service_id: 'wv', serial: '', bad: true, bad_reason: 'Механическое повреждение' };
    assert.equal(needSerial(other), true);
    assert.match(String(closeProblem([other], false)), /заводские номера/i);
  });

  it('причина непригодности «другое» требует пояснения, бланк — номера', () => {
    assert.match(String(closeProblem([{ ...ok[0]!, bad: true, bad_reason: 'Другое', bad_note: '' }], false)),
      /опишите словами/);
    assert.match(String(closeProblem([{ ...ok[0]!, bad: true, bad_reason: 'Другое', bad_note: 'течёт', blank: true, blank_no: '' }], false)),
      /номер выданного бланка/);
  });

  it('не обслуженную точку сначала возвращают в работу', () => {
    assert.match(String(closeProblem(ok, true)), /не обслуженной/);
  });
});

describe('прочие правила приёма и выезда', () => {
  it('причина «другое» у не обслуженного адреса требует текста', () => {
    assert.match(String(unservedProblem('Другое', ' ')), /опишите словами/);
    assert.equal(unservedProblem('Другое', 'не открыли подъезд'), null);
    assert.equal(unservedProblem('Нет дома', ''), null);
    assert.match(String(unservedProblem('Забыл', '')), /из списка/);
  });

  it('окно приезда сдвигается только внутри рабочего дня', () => {
    assert.equal(canShift(12, 1), true);
    assert.equal(canShift(10, -1), false);
    assert.equal(canShift(20, 1), false);
  });

  it('заявка проверяется теми же словами, что в прототипе', () => {
    const base = { client_type: 'Физлицо' as const, name: 'Иванов', phone: '9123456789', house: '10' };
    assert.equal(reqProblem(base, ['Екатеринбург']), null);
    assert.match(String(reqProblem({ ...base, name: ' ' }, ['Екатеринбург'])), /ФИО/);
    assert.match(String(reqProblem({ ...base, phone: '912345' }, ['Екатеринбург'])), /10 цифр/);
    assert.match(String(reqProblem({ ...base, house: '' }, ['Екатеринбург'])), /номер дома/);
    assert.match(String(reqProblem({ ...base, client_type: 'Юрлицо' }, ['Екатеринбург'])), /ИНН обязателен/);
    assert.match(String(reqProblem({ ...base, client_type: 'Юрлицо', inn: '123' }, ['Екатеринбург'])), /10 цифр у организации/);
    assert.match(String(reqProblem(base, [])), /бригада не выезжает/);
    assert.match(String(reqProblem({ ...base, email: 'не почта' }, ['Екатеринбург'])), /Почта/);
  });
});

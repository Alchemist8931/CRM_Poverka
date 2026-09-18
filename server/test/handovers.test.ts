/* Подотчёт бригады: руководитель без параметра «сотрудник» получает сдачи всех
 * поверителей за месяц — так экран «Сдельная оплата» узнаёт, кто что сдал.
 * Нашлось на приёмочных испытаниях (docs/uat.md, замечание 4б): раньше без
 * параметра отдавались сдачи самого спрашивающего, и у всей бригады стояло
 * «сдано 0 ₽».
 *
 *   npx tsx --test test/handovers.test.ts
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AFTER, as, draft, login, makeStand } from './helpers.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

describe('подотчёт бригады', () => {
  it('руководитель без сотрудника видит сдачи всех, поверитель — только свои', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const month = AFTER.slice(0, 7);

    // Два поверителя, по закрытому адресу у каждого и по сдаче.
    // Заявки ставит руководитель: у него нет потолка по городу, а здесь важен подотчёт, а не приём.
    for (const [ver, phone, phone2] of [['v1', '9120020001', '9120020011'], ['v2', '9120020002', '9120020012']] as const) {
      const ra = await sv.post('/api/requests', draft({ date: AFTER, phone }));
      assert.equal(ra.statusCode, 200, ra.body);
      const a = body(ra).request;
      const rb = await sv.post('/api/requests', draft({ date: AFTER, phone: phone2 }));
      assert.equal(rb.statusCode, 200, rb.body);
      const b = body(rb).request;
      await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: ver });
      const vf = as(st.app, await login(st.app, ver));
      await vf.post(`/api/requests/${a.id}/devices`, { service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: `s-${ver}` });
      assert.equal((await vf.post(`/api/requests/${a.id}/close`, { method: 'наличные' })).statusCode, 200);
      const taken = await sv.post('/api/handovers', { staff_id: ver, period: month, amount: 300 });
      assert.equal(taken.statusCode, 200, taken.body);
    }

    const all = body(await sv.get(`/api/handovers?month=${month}`));
    const who = all.handovers.map((h: { staff_id: string }) => h.staff_id).sort();
    assert.deepEqual(who, ['v1', 'v2'], 'руководителю без сотрудника — сдачи всей бригады');
    assert.equal(all.given, 600);

    const one = body(await sv.get(`/api/handovers?month=${month}&staff_id=v1`));
    assert.deepEqual(one.handovers.map((h: { staff_id: string }) => h.staff_id), ['v1']);
    assert.equal(one.given, 300);

    const vf = as(st.app, await login(st.app, 'v1'));
    const mine = body(await vf.get(`/api/handovers?month=${month}`));
    assert.deepEqual(mine.handovers.map((h: { staff_id: string }) => h.staff_id), ['v1'], 'поверителю без параметра — своё');
    const foreign = await vf.get(`/api/handovers?month=${month}&staff_id=v2`);
    assert.equal(foreign.statusCode, 422, 'чужой подотчёт поверителю не показывается');
    await st.close();
  });
});

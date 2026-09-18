/* Справочники: города, услуги, типы приборов, сотрудники.
 *
 * Читать их может любой вошедший — без прайса не собрать акт, без городов не
 * принять заявку. Менять цены и сдельные ставки может только руководитель:
 * это деньги компании и заработок бригады.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole, requireUser } from '../auth.ts';
import { ruleError, notFound } from '../errors.ts';
import { loadServices, loadStaff, type StaffState } from '../store.ts';
import { canEditPrices, canManageUsers, type Role } from '../../rules.ts';
import { canGeocode, mapsConfig } from '../../maps/config.ts';

const plugin: FastifyPluginAsync = async (app) => {
  /* Ключ JavaScript API — такой же справочник для экрана, как города и услуги:
     фронт берёт его при входе вместе с остальными. В сборку он не попадает
     намеренно — из репозитория ключ потом не вычистить, а сменить его в Lockbox
     можно за минуту. Прятать его при этом не от кого: он и так виден в адресе
     загрузки библиотеки, и защищает его ограничение по домену в кабинете
     разработчика, а не секретность. Подробности — docs/maps.md. */
  app.get('/maps/config', {
    schema: {
      tags: ['справочники'],
      summary: 'Ключ JavaScript API Яндекс Карт и признак «карта доступна»',
      security: [{ session: [] }],
    },
  }, async (req) => {
    requireUser(req);
    const cfg = mapsConfig();
    return {
      // Пустой ключ — рабочее состояние: конструктор рисует прежнюю схему области.
      js_api_key: cfg.jsApiKey,
      maps: !!cfg.jsApiKey,
      geocoder: canGeocode(cfg),
      cache_days: cfg.cacheDays,
    };
  });

  app.get('/cities', {
    schema: {
      tags: ['справочники'], summary: 'Города приёма', security: [{ session: [] }],
      querystring: { type: 'object', properties: { all: { type: 'boolean', default: false } } },
    },
  }, async (req) => {
    const { all } = req.query as { all?: boolean };
    const { rows } = await app.db.query(
      `SELECT name, short, is_big, weekdays, norm_per_verifier, sort, active FROM cities
        WHERE ($1::boolean OR active) ORDER BY sort, name`, [!!all]);
    return { cities: rows };
  });

  app.get('/services', {
    schema: { tags: ['справочники'], summary: 'Услуги, цены и сдельные ставки', security: [{ session: [] }] },
  }, async () => ({ services: (await loadServices(app.db)).list }));

  app.patch('/services/:id', {
    schema: {
      tags: ['справочники'],
      summary: 'Правка цен и ставок — только руководитель',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          price_person: { type: 'integer', minimum: 0 },
          price_pensioner: { type: 'integer', minimum: 0 },
          price_org: { type: 'integer', minimum: 0 },
          rate_verifier: { type: 'integer', minimum: 0 },
          rate_operator: { type: 'integer', minimum: 0 },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    // Правило то же, что на экране «Услуги и ставки» в прототипе.
    if (!canEditPrices(user.role as Role)) {
      throw ruleError('Прайс и сдельные ставки меняет только руководитель.', 'role');
    }
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, number | boolean>;
    const fields = Object.keys(body);
    if (!fields.length) throw ruleError('Нечего менять: в запросе нет ни одного поля.');
    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const { rows } = await app.db.query(
      `UPDATE services SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...fields.map((f) => body[f])]);
    if (!rows[0]) throw notFound(`Нет услуги «${id}».`);
    // Цена в закрытых актах не меняется: там лежит снимок на момент выполнения
    // (devices.price_charged, rate_verifier, rate_operator) — это и есть причина,
    // по которой прайс можно править задним числом, ничего не сломав.
    return { service: rows[0] };
  });

  app.get('/device-types', {
    schema: { tags: ['справочники'], summary: 'Типы приборов: ГРСИ и межповерочный интервал', security: [{ session: [] }] },
  }, async () => {
    const { rows } = await app.db.query(
      'SELECT id, name, grsi, interval_years, carrier_kind, active FROM device_types WHERE active ORDER BY sort, name');
    return { device_types: rows };
  });

  app.get('/staff', {
    schema: {
      tags: ['справочники'],
      summary: 'Сотрудники и компетенции поверителей. Руководителю — ещё и учётные данные',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          state: {
            type: 'string', enum: ['all', 'active', 'blocked'], default: 'all',
            description: 'all — все, включая уволенных: их имена нужны истории; '
              + 'active — кого можно ставить в смену и маршрут',
          },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { role, state } = req.query as { role?: Role; state?: StaffState };
    /* Логин, почта и признак временного пароля — часть учётной записи, а не
       справочника: их видит только тот, кто учётками и распоряжается. Оператору
       список сотрудников нужен, чтобы подписать смену именем, — и не более. */
    const account = canManageUsers(user.role as Role);
    return { staff: await loadStaff(app.db, { ...(role ? { role } : {}), state, account }) };
  });

  app.put('/staff/:id/skills', {
    schema: {
      tags: ['справочники'],
      summary: 'Компетенции поверителя — только руководитель',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['svcs'],
        properties: { svcs: { type: 'array', items: { type: 'string' } } },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const { svcs } = req.body as { svcs: string[] };
    const { map } = await loadServices(app.db);
    const unknown = svcs.find((s) => !map.has(s));
    if (unknown) throw ruleError(`Нет услуги «${unknown}» в справочнике.`);
    return app.db.tx(async (db) => {
      const { rows } = await db.query(`SELECT id FROM staff WHERE id = $1 AND role = 'verifier'`, [id]);
      if (!rows[0]) throw notFound(`Нет поверителя «${id}».`);
      await db.query('DELETE FROM staff_skills WHERE staff_id = $1', [id]);
      for (const s of [...new Set(svcs)]) {
        await db.query('INSERT INTO staff_skills (staff_id, service_id) VALUES ($1, $2)', [id, s]);
      }
      return { staff_id: id, svcs };
    });
  });
};

export default plugin;

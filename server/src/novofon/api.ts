/* Обращения системы к АТС.
 *
 * Все четыре сценария опираются на события: АТС сама рассказывает, что
 * происходит со звонком. Сюда вынесено обратное направление — то немногое, что
 * система просит у АТС:
 *
 *   позвонить клиенту от имени оператора   start.employee_call  /v1/request/callback/
 *   узнать сотрудников АТС                 get.employees        —
 *   отметить «на линии» и «на паузе»       update.group_employees_numbers  —
 *   сверить журнал и добрать записи        get.calls_report     —
 *   получить ссылку на запись              (приходит в событии)  /v1/pbx/record/request/
 *
 * По кругу АТС не опрашивается: у обеих линий есть ограничения по числу
 * обращений в минуту и в сутки, и на их исчерпании перестают работать звонки,
 * а не только опрос. Сверка ходит раз в сутки (`recordings.ts`).
 *
 * Отдельного метода «поставить сотрудника на перерыв» в документации Data API
 * нет — ближайшее по смыслу меняет доступность номера сотрудника в группе, и
 * ему нужно передавать все номера группы сразу, иначе метод отвечает
 * invalid_parameter_value. Поэтому состав группы читается перед каждой
 * отметкой, а не хранится у нас: он меняется в кабинете без нашего ведома.
 */
import { v1AuthHeader, v1QueryString } from './signature.ts';
import type { NovofonConfig } from './config.ts';

export class NovofonError extends Error {
  constructor(message: string, readonly code?: string | number) {
    super(message);
    this.name = 'NovofonError';
  }
}

export interface Employee {
  id: number;
  full_name?: string;
  extension?: string | null;
  phone_numbers?: { id: number; phone_number?: string }[];
}

export interface GroupNumber {
  employee_phone_number_id: number;
  available: boolean;
}

export interface CallRecordRow {
  /** Идентификатор сессии звонка. */
  id: string;
  /** Идентификатор обращения: из него собирается адрес файла записи. */
  communication_id: string | number | null;
  call_records: string[];
  start_time?: string;
  duration?: number;
}

export interface NovofonApi {
  startEmployeeCall(a: { contact: string; employeeId: number; employeePhone?: string | null; externalId?: string }):
    Promise<{ sessionId: string | null }>;
  employees(): Promise<Employee[]>;
  groupNumbers(groupId: number): Promise<GroupNumber[]>;
  setAvailable(groupId: number, numberId: number, available: boolean): Promise<void>;
  callsReport(from: string, till: string): Promise<CallRecordRow[]>;
  /** Ссылка на файл записи по идентификатору записи. */
  recordUrl(a: { sessionId: string; recordRef: string | null }): Promise<string | null>;
}

/** Запрос к JSON-RPC (платформа 2.0). Ошибка приходит полем `error`, а не
 *  кодом HTTP: 200 с телом ошибки — обычное дело, поэтому смотрим на тело. */
async function rpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
  } catch (err) {
    throw new NovofonError(`АТС недоступна: ${(err as Error).message}`);
  }
  if (!res.ok) throw new NovofonError(`АТС ответила ${res.status} на ${method}`, res.status);
  const body = await res.json().catch(() => null) as
    { result?: unknown; error?: { message?: string; code?: number; mnemonic?: string } } | null;
  if (!body) throw new NovofonError(`АТС ответила на ${method} не разбираемым телом`);
  if (body.error) {
    throw new NovofonError(
      `${method}: ${body.error.mnemonic ?? body.error.message ?? 'отказ АТС'}`, body.error.code);
  }
  return body.result;
}

/** Запрос к API 1.0: параметры и подпись считаются по одной и той же строке. */
async function v1(cfg: NovofonConfig, path: string, params: Record<string, string | number | undefined>):
Promise<Record<string, unknown>> {
  const query = v1QueryString(params);
  const auth = v1AuthHeader(path, query, cfg.apiKey!, cfg.secret!);
  let res: Response;
  try {
    res = await fetch(`${cfg.apiUrl}${path}?${query}`, { headers: { Authorization: auth } });
  } catch (err) {
    throw new NovofonError(`АТС недоступна: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || !body || body.status === 'error') {
    throw new NovofonError(`${path}: ${String(body?.message ?? res.status)}`, res.status);
  }
  return body;
}

/** Массив из ответа: методы Data API отдают то `{ items: [...] }`, то список. */
const list = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const data = (result as { data?: unknown; items?: unknown })?.data
    ?? (result as { items?: unknown })?.items;
  return Array.isArray(data) ? data as T[] : [];
};

export function novofonApi(cfg: NovofonConfig): NovofonApi {
  const token = () => {
    if (!cfg.accessToken) throw new NovofonError('Не задан NOVOFON_ACCESS_TOKEN: обращаться к АТС нечем.');
    return cfg.accessToken;
  };
  /** Идентификатор клиента нужен только агентским ключам; обычному кабинету
   *  его передавать не надо, и пустое поле метод не примет. */
  const withUser = (p: Record<string, unknown>) => (cfg.userId ? { ...p, user_id: cfg.userId } : p);

  return {
    async startEmployeeCall({ contact, employeeId, employeePhone, externalId }) {
      if (cfg.platform === 'v1') {
        // В 1.0 callback устроен так же: сначала звонит `from` (оператор),
        // потом `to` (клиент). Внутренний номер идёт отдельным параметром.
        const out = await v1(cfg, '/v1/request/callback/', {
          from: employeePhone ?? String(employeeId),
          to: contact,
          sip: employeePhone ?? undefined,
        });
        return { sessionId: out.call_id ? String(out.call_id) : null };
      }
      const result = await rpc(cfg.callApiUrl, 'start.employee_call', withUser({
        access_token: token(),
        // Первым звонит оператор: клиент слышит вызов, только когда оператор
        // уже снял трубку. Иначе клиент отвечает в тишину.
        first_call: 'employee',
        virtual_phone_number: cfg.virtualNumber,
        contact,
        employee: employeePhone ? { id: employeeId, phone_number: employeePhone } : { id: employeeId },
        ...(externalId ? { external_id: externalId } : {}),
      })) as { call_session_id?: string | number } | null;
      const id = result?.call_session_id;
      return { sessionId: id === undefined || id === null ? null : String(id) };
    },

    async employees() {
      const result = await rpc(cfg.dataApiUrl, 'get.employees', withUser({ access_token: token() }));
      return list<Employee>(result);
    },

    async groupNumbers(groupId) {
      const result = await rpc(cfg.dataApiUrl, 'get.group_employees', withUser({
        access_token: token(), id: groupId,
      }));
      // В составе группы приходит сотрудник со своими номерами: нам нужны
      // идентификаторы номеров и их текущая доступность.
      const rows = list<{ phone_numbers?: { id?: number; employee_phone_number_id?: number; available?: boolean }[] }>(result);
      const out: GroupNumber[] = [];
      for (const row of rows) {
        for (const n of row.phone_numbers ?? []) {
          const id = n.employee_phone_number_id ?? n.id;
          if (id !== undefined) out.push({ employee_phone_number_id: id, available: n.available !== false });
        }
      }
      return out;
    },

    async setAvailable(groupId, numberId, available) {
      // Передаём всю группу: метод обновляет только то, что пришло, и молча
      // отказывает, если список неполон. Состав читается сейчас же, потому что
      // операторов в группе заводит кабинет, а не CRM.
      const numbers = await this.groupNumbers(groupId);
      const known = numbers.some((n) => n.employee_phone_number_id === numberId);
      const phone_numbers = (known ? numbers : [...numbers, { employee_phone_number_id: numberId, available }])
        .map((n) => (n.employee_phone_number_id === numberId
          ? { employee_phone_number_id: n.employee_phone_number_id, available }
          : { employee_phone_number_id: n.employee_phone_number_id, available: n.available }));
      await rpc(cfg.dataApiUrl, 'update.group_employees_numbers', withUser({
        access_token: token(), id: groupId, phone_numbers,
      }));
    },

    async callsReport(from, till) {
      const result = await rpc(cfg.dataApiUrl, 'get.calls_report', withUser({
        access_token: token(), date_from: from, date_till: till,
        fields: ['id', 'communication_id', 'call_records', 'start_time', 'duration'],
      }));
      return list<CallRecordRow>(result);
    },

    async recordUrl({ sessionId, recordRef }) {
      if (cfg.platform === 'v1') {
        // 1.0 отдаёт ссылку с ограниченным сроком жизни: просим минимальный,
        // файл скачивается тут же.
        const out = await v1(cfg, '/v1/pbx/record/request/', {
          pbx_call_id: sessionId, lifetime: 180,
        });
        const link = out.link ?? (Array.isArray(out.links) ? out.links[0] : null);
        return link ? String(link) : null;
      }
      // На 2.0 ссылка приходит прямо в событии; сюда попадаем при суточной
      // сверке, где адрес собирается из обращения и идентификатора записи:
      // https://app.novofon.ru/system/media/talk/{communication_id}/{запись}/.
      // Сверка кладёт в record_ref обе части через косую черту — сессия звонка
      // и обращение у Новофона разные числа, и второе без первого бесполезно.
      if (!recordRef) return null;
      const tail = recordRef.includes('/') ? recordRef : `${sessionId}/${recordRef}`;
      return `https://app.novofon.ru/system/media/talk/${tail}/`;
    },
  };
}

import { Client } from 'pg';

/** Часовой пояс заказчика. В прототипе время записано строками без зоны
 *  («2026-09-15 14:30»), и при переносе в timestamptz зону надо назвать явно —
 *  иначе акты и платежи разъедутся на пять часов. */
export const TZ_OFFSET = '+05';

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Не задана переменная DATABASE_URL. Скопируйте server/env.example в server/.env ' +
        'или поднимите базу командой `docker compose up -d` в каталоге server.',
    );
  }
  return url;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  return client;
}

/** Телефон — ключ клиента, поэтому вид у него должен быть один.
 *  На приёме его диктуют как придётся: через восьмёрку, со скобками, с пробелами. */
export function normPhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '+7' + digits.slice(1);
  if (digits.length === 10) return '+7' + digits;
  return '+7' + digits.slice(-10);
}

/** «2026-09-15 14:30» → значение timestamptz в поясе заказчика. */
export function stampAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const [date, time] = String(value).split(' ');
  if (!date) return null;
  return `${date} ${time || '00:00'}:00${TZ_OFFSET}`;
}

/** Дата и «ЧЧ:ММ» из прототипа в один момент времени. */
export function stampOn(date: string, time: string | null | undefined): string {
  return `${date} ${time || '00:00'}:00${TZ_OFFSET}`;
}

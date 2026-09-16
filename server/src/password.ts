/* Пароль сотрудника: хеш и проверка.
 *
 * scrypt из самого Node — заводить ради этого стороннюю библиотеку незачем.
 * Формат хранения разбирается при проверке (`scrypt$соль$хеш`, всё в hex), так
 * что смена параметров не потребует пересоздавать чужие пароли.
 *
 * Отдельным файлом, а не внутри API, потому что хеш нужен и загрузчику
 * демо-данных: без учётных данных в базе API нечем даже открыть.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [kind, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

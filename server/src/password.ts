/* Пароль сотрудника: хеш и проверка.
 *
 * scrypt из самого Node — заводить ради этого стороннюю библиотеку незачем.
 * Формат хранения разбирается при проверке (`scrypt$соль$хеш`, всё в hex), так
 * что смена параметров не потребует пересоздавать чужие пароли.
 *
 * Отдельным файлом, а не внутри API, потому что хеш нужен и загрузчику
 * демо-данных: без учётных данных в базе API нечем даже открыть.
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 32;

/** Короче этого пароль не принимается — ни у руководителя, ни у поверителя. */
export const MIN_PASSWORD = 10;

/** Что не так с паролем, человеческой фразой, или `null`, если всё в порядке.
 *
 *  Требование одно — длина. Обязательные цифры и заглавные буквы дают пароли
 *  вида «Parol123!», которые пишут на мониторе: длина защищает лучше, а помнить
 *  её проще. Подряд идущие попытки входа ограничены отдельно (пять на 15 минут),
 *  и перебор упирается в это, а не в состав знаков. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Пароль короче ${MIN_PASSWORD} знаков — придумайте длиннее.`;
  if (!password.trim()) return 'Пароль из одних пробелов не подойдёт.';
  return null;
}

/* Временный пароль сотрудник читает с экрана руководителя и вводит руками, а
   иногда и диктует по телефону: ноль и «O», единица и «l» в таком пароле — это
   гарантированный второй звонок. Их в наборе нет. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEMP_LEN = 12;

/** Временный пароль: показывается один раз и меняется при первом входе. */
export function temporaryPassword(len = TEMP_LEN): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

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

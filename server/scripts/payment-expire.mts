/* Просроченные QR и ссылки: отметить отменёнными.
 *
 *   npm run payment:expire
 *
 * Провайдер неоплаченный платёж отменяет сам, а у нас он висел бы «ожидает»
 * в сверке руководителя. Срок — PAYMENT_TTL_MINUTES (по умолчанию час).
 * На машине — тем же таймером, что и `notify:tick` (docs/payment.md).
 */
import 'dotenv/config';
import { pgDb } from '../src/api/db.ts';
import { loadSecrets } from '../src/secrets.ts';
import { paymentConfig } from '../src/payment/config.ts';
import { expireStale } from '../src/payment/service.ts';

await loadSecrets();
const db = pgDb();
try {
  const n = await expireStale(db, paymentConfig());
  console.log(`Просроченных платежей отменено: ${n}.`);
} finally {
  await db.close();
}

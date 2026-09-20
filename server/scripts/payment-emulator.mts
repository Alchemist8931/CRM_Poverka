/* Эмулятор платёжного провайдера для машины разработчика.
 *
 *   npm run payment:emulator                 # порт 9800
 *   PAYMENT_EMULATOR_PORT=9900 npm run payment:emulator
 *
 * Поднимает HTTP-интерфейс ЮKassa (src/payment/emulator.ts) и печатает
 * переменные, с которыми запускать сервер. Уведомления шлёт на
 * PAYMENT_EMULATOR_WEBHOOK (по умолчанию — приёмник локального сервера с
 * секретом «dev»). Оплатить платёж — открыть ссылку /pay/<id> в браузере и
 * нажать кнопку; для QR — та же страница по идентификатору платежа.
 */
import { startEmulator } from '../src/payment/emulator.ts';

const port = Number(process.env.PAYMENT_EMULATOR_PORT) || 9800;
const secret = process.env.PAYMENT_WEBHOOK_SECRET || 'dev';
const webhook = process.env.PAYMENT_EMULATOR_WEBHOOK || `http://127.0.0.1:3000/api/webhooks/payment/${encodeURIComponent(secret)}`;

const em = await startEmulator({ shopId: 'emu', secretKey: 'emu', webhookUrl: webhook, port });
console.log(`Эмулятор провайдера: ${em.url}`);
console.log(`Уведомления шлёт на ${webhook}`);
console.log('');
console.log('Переменные для сервера (server/.env):');
console.log('  PAYMENT_PROVIDER=yookassa');
console.log('  PAYMENT_SHOP_ID=emu');
console.log('  PAYMENT_SECRET_KEY=emu');
console.log(`  PAYMENT_API_URL=${em.url}/v3`);
console.log(`  PAYMENT_WEBHOOK_SECRET=${secret}`);
console.log('  PAYMENT_ALLOWED_IPS=127.0.0.1');
console.log('');
console.log('Оплатить: открыть /pay/<id платежа> и нажать «Оплатить». Ctrl+C — остановить.');

process.on('SIGINT', () => { void em.stop().then(() => process.exit(0)); });

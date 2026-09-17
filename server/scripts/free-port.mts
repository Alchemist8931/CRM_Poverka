/* Свободный порт для временной базы проверок.
 *
 * Порт здесь не выбирается числом наугад. Проверка, оборванная на полпути
 * (прерванный прогон, снятый по таймауту процесс), оставляет поднятую базу
 * жить своей группой процессов — и следующий запуск на том же числе падает с
 * EADDRINUSE, хотя к самой проверке это отношения не имеет. Порт спрашивается
 * у системы: занятый огрызок прошлого прогона просто не мешает.
 *
 * CHECK_PORT остаётся: когда база нужна на заранее известном порту (отладка,
 * ручное подключение клиентом), число задаётся снаружи.
 */
import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  const fromEnv = Number(process.env.CHECK_PORT);
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

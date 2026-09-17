/* Доставка события оператору: от вебхука до полосы входящего на экране.
 *
 * Вебхук отвечает АТС сразу и ничего не ждёт — иначе она повторит доставку, а
 * клиент услышит лишний гудок. Значит между приёмом события и экраном оператора
 * нужен толкатель. Выбран SSE (EventSource), а не WebSocket: поток здесь
 * односторонний — сервер рассказывает, браузер только слушает; действия
 * оператора и так идут обычными запросами. SSE переживает прокси, сам
 * переподключается и не требует ни библиотеки на фронте, ни второго протокола
 * на балансировщике.
 *
 * Подписчики живут в памяти процесса. Пока приложение — один контейнер на одной
 * ВМ (arch, раздел 3), этого достаточно. Если контейнеров станет больше,
 * менять придётся только это место: события расходятся через `publish`, и все
 * маршруты зовут её, а не пишут в поток напрямую.
 */

export interface LineEvent {
  /** Что показать пульту: входящий, ответ, завершение, пропущенный, запись. */
  kind: string;
  /** Кому: идентификатор сотрудника. `null` — всем, кто слушает. */
  to?: string | null;
  [key: string]: unknown;
}

type Sink = (event: LineEvent) => void;

export interface CallBus {
  subscribe(staffId: string, sink: Sink): () => void;
  publish(event: LineEvent): void;
  /** Сколько сейчас слушателей у сотрудника: пульт открыт хотя бы в одной вкладке. */
  listeners(staffId: string): number;
}

export function callBus(): CallBus {
  const sinks = new Map<string, Set<Sink>>();

  return {
    subscribe(staffId, sink) {
      let set = sinks.get(staffId);
      if (!set) sinks.set(staffId, (set = new Set()));
      set.add(sink);
      return () => {
        const cur = sinks.get(staffId);
        if (!cur) return;
        cur.delete(sink);
        if (!cur.size) sinks.delete(staffId);
      };
    },

    publish(event) {
      const targets = event.to ? [sinks.get(event.to)] : [...sinks.values()];
      for (const set of targets) {
        if (!set) continue;
        // Одна упавшая вкладка не должна мешать остальным получить событие:
        // поток мог закрыться ровно между проверкой и записью.
        for (const sink of set) {
          try { sink(event); } catch { /* вкладка уже закрыта */ }
        }
      }
    },

    listeners: (staffId) => sinks.get(staffId)?.size ?? 0,
  };
}

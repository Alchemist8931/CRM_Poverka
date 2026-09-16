/* Отказ у API один на всех: код состояния и текст, который можно показать человеку.
 *
 * Правила прототипа отказывали всплывающей подсказкой с человеческой фразой
 * («приём закрыт — маршруты на дату уже собраны»). Эти фразы и есть ответ API:
 * фронт их показывает как есть, а не придумывает свои по коду ошибки.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Что именно упёрлось: фронт по нему решает, куда вести человека. */
  readonly reason: string | undefined;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

/** Правило не пропустило — 422: запрос понят, но так делать нельзя. */
export const ruleError = (message: string, reason?: string) => new ApiError(422, message, reason);
export const notFound = (what: string) => new ApiError(404, what);

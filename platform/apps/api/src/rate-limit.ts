/**
 * Límite de tasa por credencial (§28).
 *
 * **En memoria y por proceso.** Con dos instancias detrás de un balanceador, el
 * límite efectivo se duplica. Está escrito aquí en vez de en un ticket porque
 * es la clase de detalle que se descubre el día que se escala, y para entonces
 * ya hay un cliente consumiendo el doble de lo que contrató.
 *
 * Cuando haya más de una instancia esto se sustituye por un contador en Redis.
 * Hasta entonces esto es correcto y no tiene dependencias.
 */

interface Window {
  /** Inicio de la ventana en milisegundos. */
  startedAt: number;
  count: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  readonly #windows = new Map<string, Window>();

  /** `retryAfterSeconds` si se pasó del límite; `undefined` si puede seguir. */
  check(keyId: string, limitPerMinute: number, now = Date.now()): number | undefined {
    // Un límite de cero o negativo sería una clave que no puede llamar a nada.
    // Se interpreta como "sin límite" porque el caso real que produce ese valor
    // es una fila mal migrada, y dejar sin servicio a un cliente por un valor
    // por defecto ausente es peor que no limitarlo.
    if (limitPerMinute <= 0) return undefined;

    const window = this.#windows.get(keyId);

    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      this.#windows.set(keyId, { startedAt: now, count: 1 });
      return undefined;
    }

    if (window.count >= limitPerMinute) {
      return Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000));
    }

    window.count++;
    return undefined;
  }

  /**
   * Descarta ventanas vencidas.
   *
   * Sin esto el mapa crece con cada credencial que llame una vez y no vuelva,
   * que en una API pública son todas las que prueban una clave robada.
   */
  sweep(now = Date.now()): void {
    for (const [id, window] of this.#windows) {
      if (now - window.startedAt >= WINDOW_MS) this.#windows.delete(id);
    }
  }

  get size(): number {
    return this.#windows.size;
  }
}

import type { CapturedExchange, CaptureSnapshot } from './types';

export class CaptureLog {
  private exchanges: CapturedExchange[] = [];
  private preserveLog = false;

  constructor(private readonly limit = 250) {}

  getSnapshot(): CaptureSnapshot {
    return { exchanges: [...this.exchanges], preserveLog: this.preserveLog };
  }

  add(exchange: CapturedExchange): boolean {
    if (this.exchanges.some((existing) => existing.id === exchange.id)) return false;
    this.exchanges = [...this.exchanges, exchange].slice(-this.limit);
    return true;
  }

  update(id: string, update: Partial<CapturedExchange>): boolean {
    const index = this.exchanges.findIndex((exchange) => exchange.id === id);
    if (index === -1) return false;
    const exchanges = [...this.exchanges];
    exchanges[index] = { ...exchanges[index], ...update };
    this.exchanges = exchanges;
    return true;
  }

  clear(): void {
    this.exchanges = [];
  }

  setPreserveLog(value: boolean): void {
    this.preserveLog = value;
  }

  handleNavigation(): boolean {
    if (this.preserveLog) return false;
    this.clear();
    return true;
  }
}
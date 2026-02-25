const BEIJING_TZ = 'Asia/Shanghai';

/** Returns today's date string (YYYY-MM-DD) in Beijing time (UTC+8). */
export function getTodayBeijing(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: BEIJING_TZ });
}

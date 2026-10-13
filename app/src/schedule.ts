// Wall-clock daily scheduling ("send at 09:00") - a different shape than the
// fixed-interval `setInterval` helper other services use for their periodic
// batches (a runPeriodically loop), since those don't
// care what time of day they land.
export function msUntilNextHour(hour: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function scheduleDailyAt(hour: number, task: () => void | Promise<void>): void {
  function run(): void {
    Promise.resolve(task()).catch((err) => console.error("scheduled task failed:", err));
    setTimeout(run, 24 * 3_600_000);
  }
  setTimeout(run, msUntilNextHour(hour));
}

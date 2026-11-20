import { onMounted, onUnmounted } from "vue";

// I4c: "realtime" here means plain polling, not sockets - PLAN.md's own
// call ("polling at minimum, sockets if it turns out to be worth the
// complexity") and there's no evidence yet that a handful of tailnet
// clients polling every few seconds needs anything heavier.
const DEFAULT_INTERVAL_MS = 5_000;

// A hidden tab (phone locked, app in the background) skips its ticks, and
// catches up with one run as soon as it is visible again.
export function usePolling(callback: () => void | Promise<void>, intervalMs = DEFAULT_INTERVAL_MS): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const onVisibilityChange = (): void => {
    if (!document.hidden) void callback();
  };

  onMounted(() => {
    timer = setInterval(() => {
      if (!document.hidden) void callback();
    }, intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
}

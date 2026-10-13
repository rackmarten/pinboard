import { onMounted, onUnmounted } from "vue";

// I4c: "realtime" here means plain polling, not sockets - PLAN.md's own
// call ("polling at minimum, sockets if it turns out to be worth the
// complexity") and there's no evidence yet that a handful of tailnet
// clients polling every few seconds needs anything heavier.
const DEFAULT_INTERVAL_MS = 5_000;

export function usePolling(callback: () => void | Promise<void>, intervalMs = DEFAULT_INTERVAL_MS): void {
  let timer: ReturnType<typeof setInterval> | undefined;

  onMounted(() => {
    timer = setInterval(() => {
      void callback();
    }, intervalMs);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });
}

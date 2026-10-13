import { ref, watch, type Ref } from "vue";
import { getTasks, type Task, type TaskFilter } from "../api.js";
import { usePolling } from "./usePolling.js";

export function useTasks(filter: Ref<TaskFilter>) {
  const tasks = ref<Task[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      tasks.value = await getTasks(filter.value);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  watch(filter, load, { immediate: true, deep: true });
  // I4c: keep the list current without a manual reload. Silent (no
  // `loading` flag) so it doesn't flicker the progress bar every 5s.
  usePolling(() =>
    getTasks(filter.value)
      .then((t) => {
        tasks.value = t;
      })
      .catch(() => {}),
  );

  return { tasks, loading, error, load };
}

import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { getTaskSummaries, type TaskFilter, type TaskSummary } from "../api.js";

export const SEARCH_DEBOUNCE_MS = 300;

// Server-side task search (GET /tasks?q=, which matches the id and the
// title + description keywords), debounced while the term is being typed.
// `results` is null while there is no term, or the server has not answered
// for the current one yet, so a caller never shows a previous term's hits.
export function useTaskSearch(term: Ref<string | null>, filter: () => TaskFilter = () => ({})) {
  // a clearable field sets null
  const current = () => (term.value ?? "").trim();
  const found = ref<{ term: string; tasks: TaskSummary[] } | null>(null);
  const searching = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;

  watch(
    [current, filter],
    ([q]) => {
      clearTimeout(timer);
      const request = ++latest;
      if (!q) {
        found.value = null;
        searching.value = false;
        return;
      }
      searching.value = true;
      timer = setTimeout(async () => {
        try {
          const tasks = await getTaskSummaries({ ...filter(), q });
          if (request === latest) found.value = { term: q, tasks };
        } catch {
          // a failed search keeps the last answer, like a failed poll
        } finally {
          if (request === latest) searching.value = false;
        }
      }, SEARCH_DEBOUNCE_MS);
    },
    { immediate: true, deep: true },
  );
  onScopeDispose(() => clearTimeout(timer));

  const results = computed(() => (found.value && found.value.term === current() ? found.value.tasks : null));
  return { results, searching };
}

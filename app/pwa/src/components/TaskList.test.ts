import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter } from "vue-router";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import TaskList, { type TaskListItem } from "./TaskList.vue";

async function render(tasks: TaskListItem[], withActions = false): Promise<string> {
  const app = createSSRApp({
    render: () =>
      h(TaskList, { tasks }, withActions ? { actions: ({ index }: { index: number }) => h("button", `del-${index}`) } : {}),
  });
  app.use(createVuetify({ components }));
  app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] }));
  return renderToString(app);
}

const task: TaskListItem = {
  id: 42,
  title: "Fix the thing",
  status: "queued",
  taskType: "implementation",
  executorMode: "agent",
  priority: 2,
};

describe("TaskList", () => {
  it("renders a linked row with id, title, subtitle and chips", async () => {
    const html = await render([task, { ...task, id: 43, title: "Other", priority: 0, status: "done" }]);
    expect(html).toContain("#42");
    expect(html).toContain("Fix the thing");
    expect(html).toContain("implementation · agent");
    expect(html).toContain('href="/tasks/42"');
    expect(html).toContain("queued");
    expect(html).toContain("#43");
    expect(html).toContain("done");
  });

  it("renders the actions slot once per row", async () => {
    const html = await render([task, { ...task, id: 43 }], true);
    expect(html).toContain("del-0");
    expect(html).toContain("del-1");
  });
});

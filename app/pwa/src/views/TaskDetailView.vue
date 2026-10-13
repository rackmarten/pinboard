<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useBackClose } from "@rackmarten/ui-kit";
import { useRouter } from "vue-router";
import {
  addComment,
  addTaskRelation,
  deleteTaskRelation,
  getComments,
  getEvents,
  getProjects,
  getPullRequests,
  getTask,
  getTaskChatThread,
  getTaskRelations,
  getTasks,
  grantRootAccess,
  revokeRootAccess,
  ROOT_LABEL,
  RELATION_TYPES,
  TASK_STATUSES,
  updateTask,
  type ChatThread,
  type Comment,
  type Project,
  type PullRequest,
  type RelationType,
  type Task,
  type TaskDetail,
  type TaskEvent,
  type TaskRelation,
  getHandoffs,
  type Handoff,
  createChatThread,
  sendChatMessage,
} from "../api.js";
import { startAskChat } from "../ask-chat.js";
import TaskFormDialog from "../components/TaskFormDialog.vue";
import TaskList from "../components/TaskList.vue";
import TaskPriorityChip from "../components/TaskPriorityChip.vue";
import TaskStatusChip from "../components/TaskStatusChip.vue";
import { usePolling } from "../composables/usePolling.js";
import { renderDescriptionHtml } from "../description-html.js";
import { executorModeIcon, prStateColor, taskTypeColor, taskTypeIcon } from "../display.js";
import { groupRelations } from "../relations.js";
import { isResolved, openBlockers, orderChildren } from "../story.js";
import JournalTimeline from "../components/JournalTimeline.vue";

const props = defineProps<{ id: string }>();
const router = useRouter();

const task = ref<TaskDetail | null>(null);
const comments = ref<Comment[]>([]);
// newest first; the latest one's summary sits on top of the page
// and the full handoff in a collapsed panel.
const handoffs = ref<Handoff[]>([]);
const latestHandoff = computed(() => handoffs.value[0]);
const HANDOFF_FIELDS = [
  ["completed", "Completed"],
  ["changed", "Changed"],
  ["verified", "Verified"],
  ["problems", "Problems"],
  ["discovered", "Discovered"],
  ["next", "Next"],
] as const;
const pullRequests = ref<PullRequest[]>([]);
const projects = ref<Project[]>([]);
const sessionThread = ref<ChatThread | null>(null);
const relations = ref<TaskRelation[]>([]);
const events = ref<TaskEvent[]>([]);
const allTasks = ref<Task[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showEdit = ref(false);
const newComment = ref("");
const postingComment = ref(false);
const showAddRelation = ref(false);
useBackClose(showAddRelation);
const newRelationType = ref<RelationType>("related");
const newRelationTargetId = ref<number | null>(null);
const addingRelation = ref(false);
const showActivity = ref(false);
const updatingStatus = ref(false);

// a `root-access` task is queued only through the grant modal,
// which is also the operator's approval for root on its CTIDs.
const showRootGrant = ref(false);
useBackClose(showRootGrant);
const statusMenu = ref(false);
useBackClose(statusMenu);
const rootTtlHours = ref(4);
const grantingRoot = ref(false);
const rootGrantError = ref<string | null>(null);
const isRootTask = computed(() => task.value?.labels.some((l) => l.name === ROOT_LABEL) ?? false);
const rootGrantActive = computed(() => {
  const t = task.value;
  if (!t?.rootGrantExpiresAt || !t.rootGrantCtids?.length || t.status === "done" || t.status === "rejected") return false;
  return new Date(t.rootGrantExpiresAt) > new Date();
});

// Mirrors root-grants.ts's checkGrantable: nothing that is being worked or
// is closed can be granted, so the button is not offered there.
const rootGrantable = computed(() => {
  const status = task.value?.status ?? "";
  return !["executing", "handoff", "awaiting_ci", "awaiting_merge", "awaiting_review", "deploying", "verifying", "done", "rejected"].includes(status);
});

function openRootGrant(): void {
  rootTtlHours.value = 4;
  rootGrantError.value = null;
  showRootGrant.value = true;
}

async function grantRoot(): Promise<void> {
  grantingRoot.value = true;
  rootGrantError.value = null;
  try {
    const updated = await grantRootAccess(taskId.value, rootTtlHours.value);
    task.value = { ...task.value!, ...updated };
    showRootGrant.value = false;
  } catch (err) {
    rootGrantError.value = err instanceof Error ? err.message : String(err);
  } finally {
    grantingRoot.value = false;
  }
}

async function revokeRoot(): Promise<void> {
  try {
    const grant = await revokeRootAccess(taskId.value);
    task.value = { ...task.value!, rootGrantExpiresAt: grant.expiresAt };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const taskId = computed(() => Number(props.id));

// breadcrumb reflects the full hierarchy above the current task -
// ancestor projects (root -> leaf, via parentProjectId), then ancestor tasks
// (root -> immediate parent) - so a click-through can go straight to any
// level instead of only "back to tasks".
const projectChain = computed(() => {
  const chain: Project[] = [];
  let current = task.value ? (projects.value.find((p) => p.id === task.value!.projectId) ?? null) : null;
  const seen = new Set<number>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentProjectId !== null ? (projects.value.find((p) => p.id === current!.parentProjectId) ?? null) : null;
  }
  return chain;
});

// tasks.parentTaskId was dropped in favor of taskRelations (the
// same relationType "parent"/"child" rows foreman's runner.ts already reads
// for subtask context), so the ancestor chain is walked one relations fetch
// per level instead of following a column on allTasks. Only recomputed on a
// full load() (taskId change), not on the 5s poll - the hierarchy itself
// rarely changes and re-walking it every poll would mean N extra requests
// per tick for an N-deep chain.
function findParentId(rels: TaskRelation[]): number | null {
  const rel = rels.find(
    (r) =>
      (r.relationType === "child" && r.direction === "to") || (r.relationType === "parent" && r.direction === "from"),
  );
  return rel?.otherTask?.id ?? null;
}

const taskAncestors = ref<Task[]>([]);

async function loadTaskAncestors(): Promise<void> {
  const chain: Task[] = [];
  const seen = new Set<number>();
  let currentId = task.value ? findParentId(relations.value) : null;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const found = allTasks.value.find((t) => t.id === currentId);
    if (!found) break;
    chain.unshift(found);
    currentId = findParentId(await getTaskRelations(currentId));
  }
  taskAncestors.value = chain;
}

function goToProject(project: Project): void {
  router.push(`/projects/${project.id}`);
}
// I9: an open, unanswered question means the running session is blocked on
// the operator - the failure mode worth surfacing prominently rather than
// leaving buried behind a click.
const hasOpenQuestion = computed(
  () => sessionThread.value?.status === "open" && sessionThread.value?.awaitingAgent === false,
);

// the task's open questions (structured asks), each resolvable in
// a new chat thread seeded with the question, so it needn't be copy-pasted.
const openQuestions = computed(() => (task.value?.asks ?? []).filter((a) => a.kind === "question" && a.status === "open"));
const startingAskChat = ref<number | null>(null);

async function resolveAskInChat(askId: number): Promise<void> {
  const t = task.value;
  const a = openQuestions.value.find((q) => q.id === askId);
  if (!t || !a) return;
  startingAskChat.value = askId;
  error.value = null;
  try {
    const thread = await startAskChat(
      { getHandoffs, createChatThread: (title, projectId) => createChatThread(title, projectId), sendChatMessage },
      [{ ...a, taskTitle: t.title, projectId: t.projectId }],
    );
    await router.push(`/chat/${thread.id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    startingAskChat.value = null;
  }
}

// I19: live turn-by-turn activity from foreman's runner, tailed from a
// headless session's stream-json output - see routes.ts's POST
// /tasks/:id/events. Capped client-side (last 50) so a long-running or
// looping attempt can't blow up the DOM - the full history is still in
// pinboard's events table if needed.
const activityEvents = computed(() => events.value.filter((e) => e.eventType === "activity").slice(-50));

interface ActivityDetail {
  kind: string;
  detail: { text?: string; name?: string; input?: string; isError?: boolean; content?: string };
}

function activityDetail(event: TaskEvent): ActivityDetail {
  return event.payload as ActivityDetail;
}

function activityIcon(kind: string, isError?: boolean): string {
  if (kind === "tool_result") return isError ? "mdi-alert-circle-outline" : "mdi-check-circle-outline";
  if (kind === "tool_use") return "mdi-wrench-outline";
  return "mdi-message-text-outline";
}

// I10: a blocker worth its own banner, not just a tag in the relations list -
// any "depends_on" relation pointing at a task that isn't resolved yet
// (done, or rejected - a rejected blocker can't ever become done, so it
// shouldn't leave the blocked task stuck forever - or, an earlier story, review
// with every PR merged; the server works that out). foreman's scheduler also
// enforces this (see runner.ts's findNextRunnableTask), so this banner
// reflects a real gate, not just a human-facing warning.
const activeBlockers = computed(() =>
  relations.value.filter(
    (r) =>
      r.direction === "from" &&
      r.relationType === "depends_on" &&
      r.otherTask &&
      !r.otherTask.dependencySatisfied,
  ),
);

// I17: descriptions are markdown, rendered to sanitized HTML for display -
// this also renders a pre-I17 plain-text or HTML description correctly
// (see description-html.ts for why no separate legacy path is needed).
const descriptionHtml = computed(() => {
  const description = task.value?.description;
  if (!description) return null;
  return renderDescriptionHtml(description);
});

// effective set of projects a runner needs write access to
// for this task - the project's own repo, its standing related projects,
// and this task's own one-off additions, deduped, resolved to each
// project's localPath (or name, if it has none) for display.
const effectiveRepoPaths = computed(() => {
  if (!task.value) return [];
  const project = projects.value.find((p) => p.id === task.value?.projectId);
  const projectIds = [...(project?.relatedProjectIds ?? []), ...(task.value.relatedProjectIds ?? [])];
  const labels = [
    ...(project ? [project.localPath || project.name] : []),
    ...projectIds.map((id) => {
      const p = projects.value.find((p) => p.id === id);
      return p ? p.localPath || p.name : `#${id}`;
    }),
  ];
  return [...new Set(labels)];
});

// a story's children show as its Children relation group in run
// order (see relationGroups), so their raw parent/child rows are left out.
function isChildRelation(r: TaskRelation): boolean {
  return (r.relationType === "child" && r.direction === "from") || (r.relationType === "parent" && r.direction === "to");
}
const isStory = computed(() => task.value?.taskType === "story");
const shownRelations = computed(() =>
  isStory.value ? relations.value.filter((r) => !isChildRelation(r)) : relations.value,
);

interface StoryChild {
  task: Task;
  blockedBy: number[];
}
const storyChildren = ref<StoryChild[]>([]);

async function loadStoryChildren(): Promise<void> {
  if (!isStory.value) {
    storyChildren.value = [];
    return;
  }
  const children = await getTasks({ parentTaskId: taskId.value });
  const rels = await Promise.all(children.map((c) => getTaskRelations(c.id)));
  const dependsOn = new Map<number, number[]>();
  const satisfiedById = new Map<number, boolean>();
  children.forEach((c, i) => {
    const deps = rels[i].filter((r) => r.relationType === "depends_on" && r.direction === "from");
    dependsOn.set(c.id, deps.map((r) => r.toTaskId));
    for (const r of deps) if (r.otherTask) satisfiedById.set(r.otherTask.id, r.otherTask.dependencySatisfied);
  });
  storyChildren.value = orderChildren(children, dependsOn).map((c) => ({
    task: c,
    blockedBy: openBlockers(dependsOn.get(c.id), (id) => satisfiedById.get(id)),
  }));
}

// one TaskList per relation kind; relationIds[i] is the row's
// relation, for the delete button. A story's Children group comes from
// storyChildren instead (run order, done count, blockers).
interface RelationGroupView {
  label: string;
  note?: string;
  tasks: Task[] | NonNullable<TaskRelation["otherTask"]>[];
  relationIds: (number | undefined)[];
  blockedBy?: number[][];
}
const relationGroups = computed<RelationGroupView[]>(() => {
  const groups: RelationGroupView[] = groupRelations(shownRelations.value.filter((r) => r.otherTask)).map((g) => ({
    label: g.label,
    tasks: g.relations.map((r) => r.otherTask!),
    relationIds: g.relations.map((r) => r.id),
  }));
  if (isStory.value && storyChildren.value.length) {
    const children = storyChildren.value;
    const done = children.filter((c) => isResolved(c.task.status)).length;
    const childRelationId = (id: number) =>
      relations.value.find((r) => isChildRelation(r) && r.otherTask?.id === id)?.id;
    groups.splice(groups[0]?.label === "Parent" ? 1 : 0, 0, {
      label: "Children",
      note: `${done}/${children.length} done, in run order`,
      tasks: children.map((c) => c.task),
      relationIds: children.map((c) => childRelationId(c.task.id)),
      blockedBy: children.map((c) => c.blockedBy),
    });
  }
  return groups;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    [task.value, comments.value, pullRequests.value, sessionThread.value, relations.value, events.value, handoffs.value] = await Promise.all([
      getTask(taskId.value),
      getComments(taskId.value),
      getPullRequests(taskId.value),
      getTaskChatThread(taskId.value),
      getTaskRelations(taskId.value),
      getEvents(taskId.value),
      getHandoffs(taskId.value),
    ]);
    await Promise.all([loadTaskAncestors(), loadStoryChildren()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  [projects.value, allTasks.value] = await Promise.all([getProjects({ includeArchived: true }), getTasks()]);
  await load();
});

watch(taskId, load);

// I4c: silent refresh (no `loading` flag, so it doesn't flicker the
// progress bar every 5s) so status/comments update without a manual reload.
usePolling(async () => {
  try {
    [task.value, comments.value, pullRequests.value, sessionThread.value, relations.value, events.value, handoffs.value] = await Promise.all([
      getTask(taskId.value),
      getComments(taskId.value),
      getPullRequests(taskId.value),
      getTaskChatThread(taskId.value),
      getTaskRelations(taskId.value),
      getEvents(taskId.value),
      getHandoffs(taskId.value),
    ]);
  } catch {
    // a transient poll failure isn't worth surfacing as a page error
  }
});

// status changes inline from a click-to-open menu instead of the
// full edit modal - the modal is still there for everything else.
async function setStatus(newStatus: string): Promise<void> {
  if (!task.value || newStatus === task.value.status) return;
  if (newStatus === "queued" && isRootTask.value) {
    openRootGrant();
    return;
  }
  updatingStatus.value = true;
  try {
    const updated = await updateTask(taskId.value, { status: newStatus });
    task.value = { ...task.value, ...updated };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    updatingStatus.value = false;
  }
}

async function addRelation(): Promise<void> {
  if (!newRelationTargetId.value) return;
  addingRelation.value = true;
  try {
    await addTaskRelation(taskId.value, newRelationTargetId.value, newRelationType.value);
    [relations.value] = await Promise.all([getTaskRelations(taskId.value), loadStoryChildren()]);
    showAddRelation.value = false;
    newRelationTargetId.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    addingRelation.value = false;
  }
}

async function removeRelation(relationId: number): Promise<void> {
  try {
    await deleteTaskRelation(taskId.value, relationId);
    [relations.value] = await Promise.all([getTaskRelations(taskId.value), loadStoryChildren()]);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function submitComment(): Promise<void> {
  if (!newComment.value.trim()) return;
  postingComment.value = true;
  try {
    comments.value.push(await addComment(taskId.value, newComment.value.trim()));
    newComment.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    postingComment.value = false;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

</script>

<template>
  <div class="d-flex flex-column ga-4">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" class="align-self-start" @click="router.push('/tasks')">
      Back to tasks
    </v-btn>

    <v-breadcrumbs v-if="task" density="compact" class="pa-0">
      <template v-for="project in projectChain" :key="`p${project.id}`">
        <v-breadcrumbs-item style="cursor: pointer" @click="goToProject(project)">{{ project.name }}</v-breadcrumbs-item>
        <v-breadcrumbs-divider>/</v-breadcrumbs-divider>
      </template>
      <template v-for="ancestor in taskAncestors" :key="`t${ancestor.id}`">
        <v-breadcrumbs-item :to="`/tasks/${ancestor.id}`">#{{ ancestor.id }} {{ ancestor.title }}</v-breadcrumbs-item>
        <v-breadcrumbs-divider>/</v-breadcrumbs-divider>
      </template>
      <v-breadcrumbs-item disabled>#{{ task.id }} {{ task.title }}</v-breadcrumbs-item>
    </v-breadcrumbs>

    <v-progress-linear v-if="loading" indeterminate />
    <v-alert v-if="error" type="error" density="compact" variant="tonal">{{ error }}</v-alert>

    <template v-if="task">
      <div class="d-flex align-center ga-2 flex-wrap">
        <h1 class="text-h5 mr-auto"><span class="text-medium-emphasis">#{{ task.id }}</span> {{ task.title }}</h1>
        <v-btn variant="tonal" prepend-icon="mdi-pencil" @click="showEdit = true">Edit</v-btn>
      </div>

      <div class="d-flex ga-2 flex-wrap align-center">
        <v-menu v-model="statusMenu">
          <template #activator="{ props: menuProps }">
            <TaskStatusChip
              v-bind="menuProps"
              :status="task.status"
              append-icon="mdi-menu-down"
              :disabled="updatingStatus"
              style="cursor: pointer"
            />
          </template>
          <v-list density="compact">
            <v-list-item
              v-for="s in TASK_STATUSES"
              :key="s"
              :active="s === task.status"
              @click="setStatus(s)"
            >
              <v-list-item-title>{{ s }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-menu>
        <v-chip size="small" variant="tonal" :color="taskTypeColor(task.taskType)" :prepend-icon="taskTypeIcon(task.taskType)">{{ task.taskType }}</v-chip>
        <v-chip size="small" variant="tonal" :prepend-icon="executorModeIcon(task.executorMode)">{{ task.executorMode }}</v-chip>
      </div>

      <v-alert v-if="isRootTask" type="warning" density="compact" variant="tonal" icon="mdi-shield-alert">
        <div class="d-flex align-center ga-2 flex-wrap">
          <span class="mr-auto">
            Root access on
            <strong>{{ task.rootScope.length ? task.rootScope.join(", ") : "no containers yet (set the root scope in Edit)" }}</strong>.
            <template v-if="rootGrantActive">
              Granted {{ task.rootGrantCtids!.join(", ") }} until {{ formatDate(task.rootGrantExpiresAt!) }}
              by {{ task.rootGrantedBy }}.
            </template>
            <template v-else-if="task.rootGrantExpiresAt">Last grant ended {{ formatDate(task.rootGrantExpiresAt) }}.</template>
            <template v-else>Not granted.</template>
          </span>
          <v-btn v-if="rootGrantActive" size="small" variant="tonal" @click="revokeRoot">Revoke</v-btn>
          <v-btn v-if="rootGrantable" size="small" color="warning" variant="flat" :disabled="!task.rootScope.length" @click="openRootGrant">
            {{ rootGrantActive ? "Extend grant" : "Queue with root access" }}
          </v-btn>
        </div>
      </v-alert>

      <v-alert v-if="activeBlockers.length" type="warning" density="compact" variant="tonal" icon="mdi-block-helper">
        Blocked by
        <template v-for="(r, i) in activeBlockers" :key="r.id">
          <router-link :to="`/tasks/${r.otherTask!.id}`">#{{ r.otherTask!.id }} {{ r.otherTask!.title }}</router-link
          ><template v-if="i < activeBlockers.length - 1">, </template>
        </template>
      </v-alert>

      <v-alert
        v-if="sessionThread"
        :type="hasOpenQuestion ? 'warning' : 'info'"
        density="compact"
        variant="tonal"
        :icon="hasOpenQuestion ? 'mdi-help-circle' : 'mdi-chat-outline'"
      >
        <div class="d-flex align-center ga-2 flex-wrap">
          <span class="mr-auto">
            {{ hasOpenQuestion ? "The running session asked a question and is waiting for your reply." : "Session chat" }}
          </span>
          <v-btn size="small" variant="tonal" :to="`/chat/${sessionThread.id}`">Open session chat</v-btn>
        </div>
      </v-alert>

      <v-alert v-for="q in openQuestions" :key="q.id" type="warning" density="compact" variant="tonal" icon="mdi-help-circle">
        <div class="d-flex align-center ga-2 flex-wrap">
          <span class="mr-auto">Open question #{{ q.id }}: {{ q.question }}</span>
          <v-btn size="small" variant="tonal" to="/inbox">Answer in inbox</v-btn>
          <v-btn size="small" variant="flat" color="primary" :loading="startingAskChat === q.id" @click="resolveAskInChat(q.id)">
            Resolve in chat
          </v-btn>
        </div>
      </v-alert>

      <!-- below md the two columns dissolve (display: contents) and
           the order-* classes interleave their sections: summary and
           description, key fields and PRs, handoffs, history, relations,
           comments. order-md-0 restores DOM order in the desktop columns. -->
      <v-row class="task-detail-layout">
        <v-col cols="12" md="8" class="d-flex flex-column ga-4">
          <div class="d-flex flex-column ga-4 order-1 order-md-0">
          <v-alert v-if="latestHandoff?.summary" type="info" variant="tonal" density="compact" icon="mdi-text-box-check-outline">
            <div class="text-caption text-medium-emphasis mb-1">Latest handoff, {{ formatDate(latestHandoff.createdAt) }}</div>
            <div class="description-html" v-html="renderDescriptionHtml(latestHandoff.summary)" />
          </v-alert>

          <div v-if="descriptionHtml" class="text-body-1 description-html" v-html="descriptionHtml" />
          </div>

          <div class="d-flex flex-column ga-4 order-3 order-md-0">

          <v-expansion-panels v-if="handoffs.length" variant="accordion">
            <v-expansion-panel v-for="(h, i) in handoffs" :key="h.id" :title="i === 0 ? 'Agent handoff' : `Earlier handoff, ${formatDate(h.createdAt)}`">
              <v-expansion-panel-text>
                <template v-for="[field, label] in HANDOFF_FIELDS" :key="field">
                  <div v-if="h[field]" class="mb-3">
                    <div class="text-subtitle-2">{{ label }}</div>
                    <div class="text-body-2 description-html" v-html="renderDescriptionHtml(h[field]!)" />
                  </div>
                </template>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>

          <template v-if="activityEvents.length">
            <v-btn
              variant="text"
              class="align-self-start"
              :prepend-icon="showActivity ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              @click="showActivity = !showActivity"
            >
              Live activity ({{ activityEvents.length }})
              <v-chip
                v-if="task.status === 'executing'"
                size="small"
                color="primary"
                variant="tonal"
                prepend-icon="mdi-radio-tower"
                class="ml-2"
              >
                running
              </v-chip>
            </v-btn>
            <div v-if="showActivity" class="d-flex flex-column ga-1 activity-log">
              <div v-for="event in activityEvents" :key="event.id" class="d-flex ga-2 activity-row">
                <v-icon
                  :icon="activityIcon(activityDetail(event).kind, activityDetail(event).detail.isError)"
                  :color="activityDetail(event).detail.isError ? 'error' : undefined"
                  size="small"
                  class="mt-1"
                />
                <div class="flex-1-0" style="min-width: 0">
                  <div class="text-caption text-medium-emphasis">{{ formatDate(event.createdAt) }}</div>
                  <div v-if="activityDetail(event).kind === 'text'" style="white-space: pre-wrap">
                    {{ activityDetail(event).detail.text }}
                  </div>
                  <div v-else-if="activityDetail(event).kind === 'tool_use'" class="text-body-2">
                    <strong>{{ activityDetail(event).detail.name }}</strong>
                    <span class="text-medium-emphasis"> {{ activityDetail(event).detail.input }}</span>
                  </div>
                  <div v-else class="text-body-2" style="white-space: pre-wrap">
                    {{ activityDetail(event).detail.content }}
                  </div>
                </div>
              </div>
            </div>
          </template>

          </div>

          <!-- this task's journal (status changes, edits, claims,
               pipeline stages), collapsed so it doesn't push comments down. -->
          <v-expansion-panels variant="accordion" class="order-4 order-md-0">
            <v-expansion-panel title="History">
              <v-expansion-panel-text>
                <JournalTimeline :task-id="task.id" :show-task="false" :page-size="30" />
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>

          <div class="d-flex flex-column ga-4 order-6 order-md-0">
          <v-divider />

          <h2 class="text-h6">Comments</h2>
          <div v-if="comments.length" class="d-flex flex-column ga-3">
            <v-card v-for="comment in comments" :key="comment.id" variant="tonal">
              <v-card-text>
                <div class="d-flex justify-space-between text-caption text-medium-emphasis mb-1">
                  <span>{{ comment.authorName }}<template v-if="comment.authorType !== 'human'"> ({{ comment.authorType }})</template></span>
                  <span>{{ formatDate(comment.createdAt) }}</span>
                </div>
                <div class="description-html" v-html="renderDescriptionHtml(comment.body)" />
              </v-card-text>
            </v-card>
          </div>
          <p v-else class="text-medium-emphasis">No comments yet.</p>

          <div class="d-flex ga-2">
            <v-textarea
              v-model="newComment"
              label="Add a comment"
              rows="2"
              density="comfortable"
              auto-grow
              @keydown.enter.meta="submitComment"
            />
            <v-btn icon="mdi-send" :loading="postingComment" @click="submitComment" />
          </div>
          </div>
        </v-col>

        <v-col cols="12" md="4" class="d-flex flex-column ga-4">
          <div class="d-flex flex-column ga-4 order-2 order-md-0">
          <div class="d-flex ga-2 flex-wrap">
            <TaskPriorityChip :priority="task.priority" labelled />
            <v-chip v-if="task.estimatedEffort" size="small" variant="tonal" prepend-icon="mdi-weight">
              effort {{ task.estimatedEffort }}
            </v-chip>
            <v-chip v-if="task.autonomyLevel !== null" size="small" variant="tonal" prepend-icon="mdi-speedometer">
              autonomy {{ task.autonomyLevel }}
            </v-chip>
            <v-chip v-for="label in task.labels" :key="label.id" size="small" :color="label.color ?? undefined">
              {{ label.name }}
            </v-chip>
          </div>

          <div v-if="effectiveRepoPaths.length" class="d-flex align-center ga-2 flex-wrap">
            <span class="text-caption text-medium-emphasis">Repos:</span>
            <v-chip v-for="path in effectiveRepoPaths" :key="path" size="small" variant="tonal" prepend-icon="mdi-source-repository">
              {{ path }}
            </v-chip>
          </div>

          </div>

          <div class="d-flex flex-column ga-4 order-5 order-md-0">
          <v-divider />

          <div class="d-flex align-center ga-2">
            <h2 class="text-h6 mr-auto">Relations</h2>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="showAddRelation = true">Add</v-btn>
          </div>
          <template v-if="relationGroups.length">
            <div v-for="g in relationGroups" :key="g.label">
              <div class="text-subtitle-2 text-medium-emphasis">
                {{ g.label }}<span v-if="g.note" class="font-weight-regular"> ({{ g.note }})</span>
              </div>
              <TaskList :tasks="g.tasks">
                <template #actions="{ index }">
                  <span v-if="g.blockedBy?.[index]?.length" class="text-caption text-warning">
                    blocked by {{ g.blockedBy[index].map((b) => `#${b}`).join(", ") }}
                  </span>
                  <v-btn
                    v-if="g.relationIds[index] != null"
                    icon="mdi-close"
                    variant="text"
                    size="x-small"
                    title="Remove relation"
                    @click.prevent.stop="removeRelation(g.relationIds[index]!)"
                  />
                </template>
              </TaskList>
            </div>
          </template>
          <p v-else class="text-medium-emphasis">No relations yet.</p>
          </div>

          <div class="d-flex flex-column ga-4 order-2 order-md-0">
          <v-divider />

          <h2 class="text-h6">Linked PRs</h2>
          <div v-if="pullRequests.length" class="d-flex flex-column ga-2">
            <v-card v-for="pr in pullRequests" :key="pr.id" variant="tonal">
              <v-card-text class="d-flex align-center ga-2">
                <v-chip size="small" :color="prStateColor(pr.state)" variant="flat">{{ pr.state }}</v-chip>
                <div class="mr-auto">
                  <a :href="pr.url" target="_blank" rel="noopener noreferrer">{{ pr.repoSlug }}<template v-if="pr.branchName"> ({{ pr.branchName }})</template></a>
                  <div class="text-caption text-medium-emphasis">
                    <template v-if="pr.attemptNumber">attempt {{ pr.attemptNumber }} · </template>{{ formatDate(pr.createdAt) }}
                  </div>
                </div>
              </v-card-text>
            </v-card>
          </div>
          <p v-else class="text-medium-emphasis">No linked PRs yet.</p>
          </div>
        </v-col>
      </v-row>

      <TaskFormDialog
        v-model="showEdit"
        :projects="projects"
        :task="task"
        @saved="load"
      />

      <v-dialog v-model="showRootGrant" max-width="520">
        <v-card title="Queue with root access">
          <v-card-text class="d-flex flex-column ga-3">
            <v-alert type="error" variant="tonal" density="compact" icon="mdi-alert">
              An agent will get root on
              <strong>{{ task.rootScope.join(", ") }}</strong>
              through the Proxmox root-proxy: it can shut down, start and reboot these containers, change their
              config and run any command inside them as root. Every call is journaled on the host.
            </v-alert>
            <p class="text-body-2">
              This queues the task for agents now. The grant ends at the time below, or when the task is done or rejected,
              whichever comes first. Requeues never extend it.
            </p>
            <v-select
              v-model="rootTtlHours"
              label="Grant lasts"
              :items="[1, 2, 4, 8, 12, 24].map((h) => ({ title: `${h} hour${h === 1 ? '' : 's'}`, value: h }))"
              density="comfortable"
            />
            <v-alert v-if="rootGrantError" type="error" density="compact" variant="tonal">{{ rootGrantError }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="showRootGrant = false">Cancel</v-btn>
            <v-btn color="error" variant="flat" :loading="grantingRoot" @click="grantRoot">Grant root and queue</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <v-dialog v-model="showAddRelation" max-width="480">
        <v-card title="Add relation">
          <v-card-text class="d-flex flex-column ga-3">
            <v-select
              v-model="newRelationType"
              label="Relation"
              :items="RELATION_TYPES as readonly string[]"
              density="comfortable"
            />
            <v-autocomplete
              v-model="newRelationTargetId"
              label="Task"
              :items="allTasks.filter((t) => t.id !== taskId)"
              :item-title="(t: Task) => `#${t.id} ${t.title}`"
              item-value="id"
              density="comfortable"
            />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" @click="showAddRelation = false">Cancel</v-btn>
            <v-btn color="primary" :loading="addingRelation" @click="addRelation">Add</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>

<style scoped>
@media (max-width: 959.98px) {
  .task-detail-layout {
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 16px;
    margin: 0;
  }
  .task-detail-layout > .v-col {
    display: contents !important;
  }
}
.activity-log {
  max-height: 420px;
  overflow-y: auto;
  padding: 8px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.03);
}
.activity-row {
  padding: 4px 0;
}
.description-html :deep(p) {
  margin: 0 0 0.5em;
}
.description-html :deep(p:last-child) {
  margin-bottom: 0;
}
.description-html :deep(ul),
.description-html :deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.5em;
}
.description-html :deep(blockquote) {
  margin: 0 0 0.5em;
  padding-left: 0.75em;
  border-left: 3px solid rgba(var(--v-border-color), var(--v-border-opacity));
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.description-html :deep(code) {
  background: rgba(var(--v-theme-on-surface), 0.08);
  border-radius: 4px;
  padding: 0 4px;
}
</style>

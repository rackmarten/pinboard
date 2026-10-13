import { timingSafeEqual } from "node:crypto";
import { isPipelineStatus } from "./pipeline.js";

// A past task: root access for agent runs.
//
// A task labelled `root-access` wants root on some Proxmox containers
// (`rootScope`, CTIDs). Only the operator can release such a task to agents,
// by granting it: POST /tasks/:id/root-grant records a time-limited grant for
// the CTIDs in scope and queues the task in one step. homelab's rootproxy on
// the Proxmox host asks GET /tasks/:id/root-grant before every call, so the
// grant, not the label, is what actually carries the permission.
//
// "Only the operator" is enforced by where the request came from. pinboard has
// no auth (tailnet-trust), and inside its container every tailnet or LAN peer
// shows up as the Docker gateway, so the peer address says nothing. Instead
// reverse-proxy's Caddy block for pinboard.example.com stamps two headers on
// every request it forwards: the real client IP and a secret shared only
// between that Caddy and this app (shared with the proxy). A grant is accepted only
// when the secret matches and the client IP is one of the operators' own
// devices (OPERATOR_DEVICE_IPS). An agent on foreman calling pinboard:8095 has
// no secret, and one going through Caddy arrives from an LXC's IP, not an
// operator device's.
//
// This stops an agent queueing root work by mistake or as a "helpful" next
// step. It does not stop one deliberately working around it: foreman can SSH
// into every LXC, including this one. That is accepted in #216 on the basis
// that grants are short-lived and every rootproxy call is journaled.

export const ROOT_LABEL = "root-access";
export const CLIENT_IP_HEADER = "x-pinboard-client-ip";
export const PROXY_SECRET_HEADER = "x-pinboard-proxy-secret";

export const DEFAULT_TTL_HOURS = 4;
export const MAX_TTL_HOURS = 24;

// Proxmox guest ids. The homelab keeps guests in 100-149 (see homelab's
// "LAN addressing policy"), but Proxmox itself allows up to 999999999; this
// only rejects values that cannot be a guest at all.
const MIN_CTID = 100;
const MAX_CTID = 999_999_999;

// Written only by POST /tasks/:id/root-grant (and cleared by the revoke
// paths). A PATCH naming any of them is refused, otherwise the whole gate is
// one PATCH away.
export const ROOT_GRANT_FIELDS = ["rootGrantCtids", "rootGrantExpiresAt", "rootGrantedAt", "rootGrantedBy"] as const;

export type Check<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fails closed: with no secret or no operator IPs configured, nothing is an
// operator request, so the endpoint refuses everything rather than trusting
// a header anyone could send.
export function checkOperatorRequest(
  headers: Record<string, string | string[] | undefined>,
  settings: { proxySecret: string; operatorIps: string[] },
): Check<{ clientIp: string }> {
  if (!settings.proxySecret || settings.operatorIps.length === 0) {
    return { ok: false, reason: "root grants are disabled: PINBOARD_PROXY_SECRET or OPERATOR_DEVICE_IPS is not set" };
  }
  const secret = headerValue(headers, PROXY_SECRET_HEADER);
  if (!secret || !secretsMatch(secret, settings.proxySecret)) {
    return { ok: false, reason: "root grants can only be made through https://pinboard.example.com from an operator device" };
  }
  const clientIp = headerValue(headers, CLIENT_IP_HEADER);
  if (!settings.operatorIps.includes(clientIp)) {
    return { ok: false, reason: `root grants can only be made from an operator device (this request came from ${clientIp || "an unknown address"})` };
  }
  return { ok: true, clientIp };
}

export function validateRootScope(value: unknown): Check<{ ctids: number[] }> {
  if (!Array.isArray(value)) return { ok: false, reason: "rootScope must be an array of CTIDs" };
  for (const v of value) {
    if (!Number.isInteger(v) || v < MIN_CTID || v > MAX_CTID) {
      return { ok: false, reason: `rootScope entries must be integer CTIDs >= ${MIN_CTID}, got ${JSON.stringify(v)}` };
    }
  }
  return { ok: true, ctids: [...new Set(value as number[])].sort((a, b) => a - b) };
}

export function validateTtlHours(value: unknown): Check<{ hours: number }> {
  if (value === undefined || value === null) return { ok: true, hours: DEFAULT_TTL_HOURS };
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TTL_HOURS) {
    return { ok: false, reason: `ttlHours must be a number above 0 and at most ${MAX_TTL_HOURS}` };
  }
  return { ok: true, hours: value };
}

// A task already being worked (a live run, or a PR moving through the
// pipeline) is not re-granted: the grant queues the task, and queueing one of
// those would pull it out from under whatever holds it. Closed tasks are not
// granted either.
export function checkGrantable(task: { status: string; rootScope: number[] }, hasRootLabel: boolean): Check {
  if (!hasRootLabel) return { ok: false, reason: `only a task labelled '${ROOT_LABEL}' can be granted root access` };
  if (task.rootScope.length === 0) return { ok: false, reason: "set the task's root scope (CTIDs) before granting" };
  if (task.status === "executing" || task.status === "handoff" || isPipelineStatus(task.status)) {
    return { ok: false, reason: `task is '${task.status}'; grant it once it is no longer being worked` };
  }
  if (task.status === "done" || task.status === "rejected") {
    return { ok: false, reason: `task is '${task.status}'` };
  }
  return { ok: true };
}

export interface GrantFields {
  status: string;
  rootGrantCtids: number[] | null;
  rootGrantExpiresAt: Date | null;
  rootGrantedAt: Date | null;
  rootGrantedBy: string | null;
}

export interface GrantState {
  active: boolean;
  ctids: number[];
  expiresAt: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
}

// Closed tasks never hold an active grant, even inside the TTL. The close
// paths also cut the expiry to now (routes.ts's revokeGrantSql), so reopening
// a closed task does not bring its grant back; this is the second line.
export function grantState(task: GrantFields, now: Date): GrantState {
  const ctids = task.rootGrantCtids ?? [];
  const closed = task.status === "done" || task.status === "rejected";
  const active = !closed && ctids.length > 0 && !!task.rootGrantExpiresAt && task.rootGrantExpiresAt > now;
  return {
    active,
    ctids,
    expiresAt: task.rootGrantExpiresAt?.toISOString() ?? null,
    grantedAt: task.rootGrantedAt?.toISOString() ?? null,
    grantedBy: task.rootGrantedBy,
  };
}

// Moving a root-access task INTO `queued` needs a live grant. That covers the
// PWA's status menu, the edit dialog, the review queue's requeue and any
// agent's PATCH. Staying in `queued` (an edit that resends the same status)
// is not a move, and foreman's own requeues (a refunded session-limit
// attempt) happen while the grant is still live, so they pass with it and
// stop passing once it expires - a requeue never extends a grant.
export function checkQueueMove(
  fromStatus: string | undefined,
  toStatus: unknown,
  hasRootLabel: boolean,
  grantActive: boolean,
): Check {
  if (!hasRootLabel || toStatus !== "queued" || fromStatus === "queued") return { ok: true };
  if (grantActive) return { ok: true };
  return {
    ok: false,
    reason: `a '${ROOT_LABEL}' task can only be queued by granting it root access from an operator device (Queue with root access)`,
  };
}

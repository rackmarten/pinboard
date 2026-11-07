import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { PROXY_SECRET_HEADER } from "./root-grants.js";

// Who is behind a request, from its headers alone. The PWA marks itself with
// `x-pinboard-client: pwa` (a person at a browser), a script or agent can name
// itself with `x-pinboard-actor: <type>:<name>`, and anything else is an
// unnamed API caller rather than a guess.
//
// pinboard has no login, so every browser is the same "operator" unless the
// reverse proxy says who it is. With PINBOARD_USER_HEADER set, a PWA request
// carrying that header and the proxy's shared secret is that person instead.
// The secret is what makes the header trustworthy: a caller reaching
// pinboard's port directly has no secret, so it cannot claim to be someone.

export interface Actor {
  actorType: string;
  actorName: string;
}

export interface IdentitySettings {
  proxySecret: string;
  userHeader: string;
}

type Headers = Record<string, string | string[] | undefined>;

function headerValue(headers: Headers, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value ?? "").trim();
}

function secretsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// `pwa` is also accepted from the query string, because navigator.sendBeacon
// (the activity tracker's last flush on pagehide) cannot set headers.
export function actorFromHeaders(headers: Headers, settings: IdentitySettings, query: Record<string, unknown> = {}): Actor {
  const named = headers["x-pinboard-actor"];
  if (typeof named === "string" && named.includes(":")) {
    const [actorType, ...rest] = named.split(":");
    return { actorType, actorName: rest.join(":") };
  }
  if (headers["x-pinboard-client"] === "pwa" || query.client === "pwa") {
    return { actorType: "human", actorName: proxiedUser(headers, settings) ?? "operator" };
  }
  return { actorType: "system", actorName: "api" };
}

function proxiedUser(headers: Headers, settings: IdentitySettings): string | null {
  if (!settings.userHeader || !settings.proxySecret) return null;
  const secret = headerValue(headers, PROXY_SECRET_HEADER);
  if (!secret || !secretsMatch(secret, settings.proxySecret)) return null;
  const user = headerValue(headers, settings.userHeader);
  // a bare id, never something that could pass for a type:name pair
  return /^[\w.@-]{1,64}$/.test(user) ? user : null;
}

export function actorKey(actor: Actor): string {
  return `${actor.actorType}:${actor.actorName}`;
}

export function identitySettings(): IdentitySettings {
  return { proxySecret: config.rootGrants.proxySecret, userHeader: config.identity.userHeader };
}

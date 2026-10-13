// the in-process fan-out behind the two SSE endpoints.
//
// pinboard is a single Fastify process in a single container, so a plain
// EventEmitter is the whole mechanism - no Redis, no Postgres LISTEN/NOTIFY.
// That is a real constraint to remember rather than an oversight: if
// pinboard is ever run as more than one replica, a message posted to one
// replica would not reach a subscriber attached to another, and this file
// is where that would have to change.
//
// Why a bus at all, when the data is already in Postgres: foreman used to
// discover a new human message by polling (a past task tightened that to ~2s),
// and the PWA still polls its thread. Under a live session the operator is
// typing at an agent that is already running, so a poll interval is felt
// directly - it is the difference between an interrupt landing now and
// landing whenever the next tick happens. Subscribers still replay from the
// tables (`?since=`) on connect, so the bus is purely a latency
// optimisation and a dropped notification degrades to the old behaviour
// rather than losing data.

import { EventEmitter } from "node:events";

export interface ChatBusMessage {
  // Which thread it concerns - subscribers to one thread filter on this,
  // and foreman's whole-firehose subscription passes it straight through.
  threadId: number;
  // The SSE event name delivered to subscribers.
  event: string;
  data: unknown;
}

// Each SSE connection attaches one listener; the default cap of 10 would
// warn as soon as a handful of browser tabs and foreman are attached at
// once. There is no leak being masked here - listeners are removed in the
// connection's own close handler.
const MAX_SUBSCRIBERS = 200;

const emitter = new EventEmitter();
emitter.setMaxListeners(MAX_SUBSCRIBERS);

const CHANNEL = "chat";

export function publishChat(message: ChatBusMessage): void {
  emitter.emit(CHANNEL, message);
}

// Returns its own unsubscribe function rather than exposing the emitter, so
// a caller can't accidentally remove someone else's listener or keep the
// emitter alive past its connection.
export function subscribeChat(listener: (message: ChatBusMessage) => void): () => void {
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}

export function subscriberCount(): number {
  return emitter.listenerCount(CHANNEL);
}

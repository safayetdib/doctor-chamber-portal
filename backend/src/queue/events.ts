import type { ChangeStream } from 'mongodb';
import type { Response } from 'express';
import type { RequestContext } from '../identity/context.js';
import { IdentityError } from '../identity/security.js';
import type { PracticeStore } from '../persistence/store.js';
import type { QueueService } from './service.js';

type Subscriber = (shutdown?: boolean) => void;

export class QueueEvents {
  private stream: ChangeStream | undefined;
  private subscribers = new Map<string, Set<Subscriber>>();
  private stopped = false;

  constructor(private store: PracticeStore, private queue: QueueService) {}

  async connect(context: RequestContext, sessionId: string, audience: 'staff' | 'patient', response: Response) {
    await this.queue.authorizeLive(context, sessionId, audience);
    if (this.stopped) throw new IdentityError(503, 'LIVE_UNAVAILABLE', 'Live updates are unavailable.');
    if (response.destroyed) return;
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders();

    let closed = false;
    let updating = false;
    let pending = false;
    const disconnect = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.unsubscribe(sessionId, notify);
      response.end();
    };
    const check = async () => {
      updating = true;
      try {
        while (pending && !closed) {
          pending = false;
          await this.queue.authorizeLive(context, sessionId, audience);
          if (!closed && !response.write('event: refresh\ndata: {}\n\n')) disconnect();
        }
      } catch {
        disconnect();
      } finally {
        updating = false;
      }
    };
    const notify: Subscriber = (shutdown) => {
      if (shutdown) {
        disconnect();
        return;
      }
      pending = true;
      if (!updating && !closed) void check();
    };

    const heartbeat = setInterval(notify, 15_000);
    heartbeat.unref();
    response.once('close', disconnect);
    const listeners = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    listeners.add(notify);
    this.subscribers.set(sessionId, listeners);
    if (!this.stream) this.start();
    notify();
  }

  private start() {
    const stream = this.store.watchQueue();
    this.stream = stream;
    void this.forward(stream);
  }

  private async forward(stream: ChangeStream) {
    try {
      let first = true;
      while (this.stream === stream) {
        const change = await stream.tryNext();
        if (this.stream !== stream) break;
        if (stream.closed) throw new Error('Queue change stream closed.');
        if (first) {
          first = false;
          this.broadcast();
        }
        if (!change || !('ns' in change) || !('documentKey' in change)) continue;
        if (change.ns.coll === this.store.collection('sessions').collectionName) {
          const id = change.documentKey._id.toString();
          for (const notify of this.subscribers.get(id) ?? []) notify();
        } else {
          this.broadcast();
        }
      }
    } catch {
      if (this.stream === stream) this.broadcast(true);
    } finally {
      if (this.stream === stream) this.stream = undefined;
      await stream.close().catch(() => {});
    }
  }

  private broadcast(shutdown = false) {
    for (const listeners of this.subscribers.values()) {
      for (const notify of [...listeners]) notify(shutdown);
    }
  }

  private unsubscribe(sessionId: string, listener: Subscriber) {
    const listeners = this.subscribers.get(sessionId);
    listeners?.delete(listener);
    if (!listeners?.size) this.subscribers.delete(sessionId);
    if (!this.subscribers.size && this.stream) {
      const stream = this.stream;
      this.stream = undefined;
      void stream.close().catch(() => {});
    }
  }

  close() {
    this.stopped = true;
    this.broadcast(true);
  }
}

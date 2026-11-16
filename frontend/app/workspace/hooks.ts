'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, request, type Schema } from './api';

type Resource<T> = { path: string; data?: T; error?: string };

export function useResource<T>(path: string | null, schema: Schema<T>) {
  const [state, setState] = useState<Resource<T> | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void request(path, schema, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ path, data });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState((previous) => {
        const preserve = !(error instanceof ApiError) || error.status >= 500;
        return {
          path, error: errorMessage(error),
          ...(preserve && previous?.path === path && previous.data !== undefined && { data: previous.data })
        };
      });
    });
    return () => controller.abort();
  }, [path, schema, version]);

  const current = path && state?.path === path ? state : null;
  return { data: current?.data, error: current?.error, loading: !!path && !current, refresh };
}

export function useQueueUpdates(path: string | null, refresh: () => void) {
  const [connection, setConnection] = useState<{ path: string; mode: 'live' | 'polling' } | null>(null);
  useEffect(() => {
    if (!path) return;
    const queuePath = path;
    let source: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let polling = 0;
    function poll(milliseconds: number) {
      if (polling === milliseconds) return;
      polling = milliseconds;
      clearInterval(interval);
      interval = setInterval(refresh, milliseconds);
    }
    function connect() {
      const attempt = new EventSource('/api/v1' + queuePath + '/events');
      source = attempt;
      attempt.onopen = () => {
        setConnection({ path: queuePath, mode: 'live' });
        refresh();
        poll(15_000);
      };
      attempt.onerror = () => {
        attempt.close();
        setConnection({ path: queuePath, mode: 'polling' });
        refresh();
        poll(5000);
        reconnect = setTimeout(connect, 5000);
      };
      attempt.addEventListener('refresh', refresh);
    }
    connect();
    poll(5000);
    return () => {
      source?.close();
      clearTimeout(reconnect);
      clearInterval(interval);
    };
  }, [path, refresh]);
  return path && connection?.path === path ? connection.mode : null;
}

export function useAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(work: () => Promise<void>, success = '') {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(success);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function form(event: FormEvent<HTMLFormElement>, work: (data: FormData, element: HTMLFormElement) => Promise<void>, success = '') {
    event.preventDefault();
    const element = event.currentTarget;
    const values = new FormData(element);
    void run(() => work(values, element), success);
  }

  return { busy, error, notice, run, form };
}

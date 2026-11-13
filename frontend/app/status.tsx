'use client';

import { useState } from 'react';
import { healthResponseSchema } from '@practice/contracts';

export function ApiStatus() {
  const [state, setState] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle');

  async function checkConnection() {
    setState('checking');
    try {
      const response = await fetch('/api/v1/health/ready', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const result = healthResponseSchema.parse(await response.json());
      setState(response.ok && result.status === 'ready' ? 'ready' : 'unavailable');
    } catch {
      setState('unavailable');
    }
  }

  return (
    <div className="connection">
      <button type="button" disabled={state === 'checking'} onClick={() => void checkConnection()}>
        {state === 'checking' ? 'Checking connection…' : 'Check service connection'}
      </button>
      <p role="status" aria-live="polite">
        {state === 'idle' && 'Ready to check the API and database.'}
        {state === 'checking' && 'Connecting to the service…'}
        {state === 'ready' && 'Connected. The API and database are ready.'}
        {state === 'unavailable' && 'Service unavailable. Start the database and API, then try again.'}
      </p>
    </div>
  );
}

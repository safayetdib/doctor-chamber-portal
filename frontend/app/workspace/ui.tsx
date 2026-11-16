'use client';

import { useState, type ReactNode } from 'react';
import { setupInvitationSchema } from '@practice/contracts';
import { localDay, localTime, statusLabel, type Output } from './api';

export function Feedback({ error, notice }: { error?: string | undefined; notice?: string | undefined }) {
  return <>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
  </>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Badge({ value }: { value: string }) {
  return <span className={'badge ' + value}>{statusLabel(value)}</span>;
}

export function SetupInvitation({ invitation }: { invitation: Output<typeof setupInvitationSchema> }) {
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '' : window.location.origin + '/#setup=' + invitation.setupToken;
  return <div className="invitation">
    <div className="inline spread"><strong>Account invitation</strong><span>Expires {localDay(invitation.expiresAt)} at {localTime(invitation.expiresAt)} Dhaka time</span></div>
    <p>Login ID <code>{invitation.loginId}</code></p>
    <label>Private setup link<input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label>
    <button type="button" className="secondary" onClick={() => {
      void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false));
    }}>{copied ? 'Copied' : 'Copy setup link'}</button>
  </div>;
}

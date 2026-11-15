import { practiceTimezone } from '@practice/contracts';
import { IdentityError } from '../identity/security.js';

const offsetFormatter = new Intl.DateTimeFormat('en', { timeZone: practiceTimezone, timeZoneName: 'longOffset' });
const dayMs = 86_400_000;

function offsetAt(utcMs: number) {
  const value = offsetFormatter.formatToParts(utcMs).find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(value ?? '');
  if (value === 'GMT') return 0;
  if (!match) throw new Error('The practice timezone offset could not be read.');
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
  return (match[1] === '-' ? -1 : 1) * seconds * 1000;
}

export function localInstant(date: string, time: string) {
  const localAsUtc = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set([offsetAt(localAsUtc - dayMs), offsetAt(localAsUtc), offsetAt(localAsUtc + dayMs)]);
  const candidates = [...offsets].map((offset) => localAsUtc - offset)
    .filter((candidate) => candidate + offsetAt(candidate) === localAsUtc);
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new IdentityError(400, 'INVALID_LOCAL_TIME', 'The time must identify an unambiguous time in Asia/Dhaka.');
  }
  return new Date(candidates[0]);
}

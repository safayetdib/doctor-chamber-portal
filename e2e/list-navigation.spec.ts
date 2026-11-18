import { expect, test } from '@playwright/test';

const doctorId = '111111111111111111111111';
const otherDoctorId = '222222222222222222222222';
const firstSessionId = '333333333333333333333333';
const secondSessionId = '444444444444444444444444';
const firstBookingId = '555555555555555555555555';
const secondBookingId = '666666666666666666666666';
const createdAt = '2099-01-01T00:00:00.000Z';
const times = {
  sessionId: firstSessionId, doctorId, chamberId: '777777777777777777777777',
  serviceDate: '2099-01-01', timezone: 'Asia/Dhaka',
  startsAt: '2099-01-01T03:00:00.000Z', endsAt: '2099-01-01T11:00:00.000Z'
};
const account = {
  accountId: '888888888888888888888888', loginId: 'synthetic-patient', name: 'Synthetic Patient',
  role: 'patient', patientId: '999999999999999999999999', contactPhoneVerified: false, phoneLoginEnabled: false
};
const booking = {
  bookingId: firstBookingId, sessionId: firstSessionId, doctorId, serialNumber: 1, status: 'cancelled', createdAt
};

test('patient can browse later practices and sessions and reset a date filter', async ({ page }) => {
  const queries: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.pathname + url.search);
    let body: unknown;
    switch (url.pathname) {
      case '/api/v1/auth/me':
        body = account;
        break;
      case '/api/v1/bookings':
        body = { bookings: [], nextCursor: null };
        break;
      case '/api/v1/practices':
        body = url.searchParams.has('after')
          ? { practices: [{ doctorId: otherDoctorId, displayName: 'Later Practice' }], nextCursor: null }
          : { practices: [{ doctorId, displayName: 'First Practice' }], nextCursor: doctorId };
        break;
      default: {
        const later = url.searchParams.has('after');
        body = {
          sessions: [{ ...times, doctorId: url.pathname.split('/')[4],
            sessionId: later ? secondSessionId : firstSessionId, status: 'scheduled', remainingCapacity: later ? 7 : 9 }],
          nextCursor: later ? null : firstSessionId
        };
      }
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  const practice = page.getByRole('combobox', { name: /^Practice\b/ });
  await expect(practice).toHaveValue(doctorId);
  await page.getByRole('button', { name: 'More sessions', exact: true }).click();
  await expect(page.getByText('7 available', { exact: false })).toBeVisible();
  await page.getByLabel('Session date in Dhaka').fill('2099-01-02');
  await expect(page.getByText('9 available', { exact: false })).toBeVisible();
  expect(queries).toContain('/api/v1/practices/' + doctorId + '/sessions?date=2099-01-02');
  await page.getByRole('button', { name: 'More practices', exact: true }).click();
  await expect(practice).toHaveValue(otherDoctorId);
  await page.getByRole('button', { name: 'First practices', exact: true }).click();
  await expect(practice).toHaveValue(doctorId);
  await page.getByRole('button', { name: 'All dates', exact: true }).click();
  await expect(page.getByLabel('Session date in Dhaka')).toHaveValue('');
});

test('staff can browse later sessions and booking history and reset a filter', async ({ page }) => {
  const queries: string[] = [];
  const session = { ...times, consultationMinutes: 10, capacity: 20, bookingOpen: false,
    status: 'ended', capacityUsed: 2, queueRevision: 1 };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.pathname + url.search);
    let body: unknown;
    if (url.pathname === '/api/v1/auth/me') {
      body = { ...account, role: 'doctor', doctorId };
    } else if (url.pathname === '/api/v1/practice') {
      body = { doctorId, displayName: 'Synthetic Practice', status: 'active' };
    } else if (url.pathname === '/api/v1/practice/sessions') {
      const later = url.searchParams.has('after');
      body = { sessions: [{ ...session, sessionId: later ? secondSessionId : firstSessionId }],
        nextCursor: later ? null : firstSessionId };
    } else if (url.pathname.endsWith('/queue')) {
      body = {
        session: { ...session, sessionId: url.pathname.split('/')[5] },
        actualStartAt: createdAt, actualEndAt: createdAt, calculatedAt: createdAt,
        current: null, waiting: [], missed: []
      };
    } else if (url.pathname.endsWith('/bookings')) {
      const older = url.searchParams.has('after');
      body = { bookings: [{ ...booking, bookingId: older ? secondBookingId : firstBookingId,
        patientId: account.patientId, patientSnapshot: { name: older ? 'Older Patient' : 'Recent Patient', contactPhone: '+12025550123' },
        queueClass: 'regular', queuePosition: null, source: 'staff' }], nextCursor: older ? null : firstBookingId };
    } else {
      body = { date: '2099-01-01', timezone: 'Asia/Dhaka', intervals: [], consultationMinutes: 10, capacity: 20 };
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  const select = page.getByRole('combobox', { name: /^Session\b/ });
  await expect(select).toHaveValue(firstSessionId);
  await page.getByRole('button', { name: 'More sessions', exact: true }).click();
  await expect(select).toHaveValue(secondSessionId);
  await page.getByRole('button', { name: 'First sessions', exact: true }).click();
  await expect(select).toHaveValue(firstSessionId);
  await page.getByLabel('Filter by date').fill('2099-01-02');
  await expect(page.getByRole('button', { name: 'All dates', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All dates', exact: true }).click();
  await expect(page.getByLabel('Filter by date')).toHaveValue('');
  await page.getByText('Booking history', { exact: true }).click();
  await expect(page.getByText('#1 · Recent Patient', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Older bookings', exact: true }).click();
  await expect(page.getByText('#1 · Older Patient', { exact: true })).toBeVisible();
  expect(queries).toContain('/api/v1/practice/sessions/' + firstSessionId + '/bookings?after=' + firstBookingId);
  await page.getByRole('button', { name: 'Newest bookings', exact: true }).click();
  await expect(page.getByText('#1 · Recent Patient', { exact: true })).toBeVisible();
});

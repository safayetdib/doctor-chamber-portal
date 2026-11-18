import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const phone = '+12025550123';

async function activate(from: Page, recipient: Page, password: string) {
  const link = from.getByLabel('Private setup link');
  await expect(link).toHaveValue(/\/#setup=/);
  await recipient.goto(await link.inputValue());
  await recipient.getByLabel('Password').fill(password);
  await recipient.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(recipient.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(recipient).toHaveURL(/\/$/);
}

test('provision, book, follow live updates and close the session', async ({ page: admin, browser }, testInfo) => {
  const doctorContext = await browser.newContext();
  const patientContext = await browser.newContext();
  const doctor = await doctorContext.newPage();
  const patient = await patientContext.newPage();
  const practice = `Synthetic ${testInfo.project.name} practice`;
  const password = randomBytes(24).toString('hex');
  const tomorrow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Dhaka' })
    .format(new Date(Date.now() + 86_400_000));
  try {
    await test.step('Administrator provisions the doctor through the browser', async () => {
      await admin.goto('/');
      await admin.getByLabel('Login ID').fill('smoke-admin');
      await admin.getByLabel('Password').fill(process.env.SMOKE_ADMIN_PASSWORD!);
      await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
      await admin.getByLabel('Doctor name').fill('Synthetic Doctor');
      await admin.getByLabel('Public practice name').fill(practice);
      await admin.getByLabel('Contact phone').fill(phone);
      await admin.getByRole('button', { name: 'Create and invite doctor' }).click();
      await activate(admin, doctor, password);
      await expect(doctor.getByRole('heading', { name: practice })).toBeVisible();
    });

    await test.step('Doctor saves a chamber, publishes a session and invites a patient', async () => {
      await doctor.getByRole('button', { name: 'Practice settings' }).click();
      const chamber = doctor.locator('section').filter({ has: doctor.getByRole('heading', { name: 'Chamber', exact: true }) });
      await chamber.getByLabel('Chamber name').fill('Synthetic Chamber');
      await chamber.getByLabel('Address').fill('Synthetic address');
      await chamber.getByLabel('Contact phone').fill(phone);
      await chamber.getByRole('button', { name: 'Save chamber' }).click();
      await expect(chamber.getByText('Chamber saved.')).toBeVisible();
      await doctor.getByRole('button', { name: 'Sessions', exact: true }).click();
      await doctor.getByText('Create a session', { exact: true }).click();
      await doctor.getByLabel('Service date').fill(tomorrow);
      await doctor.getByLabel('Start time').fill('09:00');
      await doctor.getByLabel('End time').fill('17:00');
      await doctor.getByRole('button', { name: 'Create draft' }).click();
      await doctor.getByRole('button', { name: 'Publish session' }).click();
      await expect(doctor.getByText('Session published.')).toBeVisible();
      await expect(doctor.getByText('Live updates', { exact: true })).toBeVisible();
      await doctor.getByText('Register a new patient').click();
      await doctor.getByLabel('Patient name').fill('Synthetic Patient');
      await doctor.getByLabel('Contact phone').fill(phone);
      await doctor.getByRole('button', { name: 'Register patient' }).click();
      await activate(doctor, patient, password);
    });

    const patientQueue = patient.locator('section').filter({ has: patient.getByRole('heading', { name: 'Your queue' }) });
    await test.step('Patient books and receives live queue updates', async () => {
      const practiceSelect = patient.getByRole('combobox', { name: /^Practice\b/ });
      await practiceSelect.selectOption({ label: practice });
      await patient.getByRole('button', { name: 'Book session' }).click();
      await expect(patientQueue.getByText('Estimated start', { exact: false })).toBeVisible();
      await expect(patientQueue.getByText('Live updates', { exact: true })).toBeVisible();
      await expect(doctor.getByRole('button', { name: 'Move serial 1 up' })).toBeVisible({ timeout: 8_000 });
    });

    await test.step('Patient sees a staff update during a stream outage and reconnects', async () => {
      const events = '**/api/v1/sessions/*/queue/events';
      await patient.route(events, (route) => route.abort());
      await patient.reload();
      await patient.getByRole('button', { name: 'View queue' }).click();
      await expect(patientQueue.getByText('Polling for updates')).toBeVisible();
      await doctor.getByRole('button', { name: 'Start session' }).click();
      await doctor.getByRole('button', { name: 'Call next' }).click();
      await expect(patientQueue.getByText('Your consultation is in progress.')).toBeVisible();
      await patient.unroute(events);
      await expect(patientQueue.getByText('Live updates', { exact: true })).toBeVisible();
    });

    await test.step('Doctor completes the consultation and closes the session', async () => {
      await doctor.getByRole('button', { name: 'Finish consultation' }).click();
      await expect(patientQueue.getByText('Completed', { exact: true })).toBeVisible({ timeout: 8_000 });
      doctor.once('dialog', (dialog) => dialog.accept());
      await doctor.getByRole('button', { name: 'End session' }).click();
      await expect(doctor.getByText('Ended', { exact: true })).toBeVisible();
      await patient.reload();
      const history = patient.locator('section').filter({ has: patient.getByRole('heading', { name: 'Your bookings' }) });
      await expect(history.getByText('Serial 1', { exact: true })).toBeVisible();
      await expect(history.getByText('Completed', { exact: true })).toBeVisible();
    });
  } finally {
    await patientContext.close();
    await doctorContext.close();
  }
});

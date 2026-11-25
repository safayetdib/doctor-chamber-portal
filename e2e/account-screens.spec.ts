import { expect, test, type Page } from '@playwright/test';

const phone = '+12025550123';
const loginId = 'synthetic-patient';
const password = 'Synthetic account password!';
const patient = {
  accountId: '111111111111111111111111', patientId: '222222222222222222222222',
  loginId, name: 'Synthetic Patient', role: 'patient', contactPhone: phone,
  contactPhoneVerified: true, phoneLoginEnabled: false, patientDetails: {}
};

// SMS remains disconnected in the application. These response fixtures exercise
// the browser steps while the replica-set integration suite tests real OTP rules.
async function smsScreenFixtures(page: Page, initiallySignedIn = false) {
  let signedIn = initiallySignedIn;
  let enabled = false;
  let counter = 0;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    if (body) requests.push({ path, body });
    const account = { ...patient, phoneLoginEnabled: enabled };
    if (path === '/auth/me' && signedIn) return route.fulfill({ json: account });
    if (path === '/auth/me') return route.fulfill({
      status: 401, json: { error: { code: 'AUTH_REQUIRED', message: 'Sign in required.', requestId: 'synthetic' } }
    });
    if (path === '/practices') return route.fulfill({ json: { practices: [], nextCursor: null } });
    if (path === '/bookings') return route.fulfill({ json: { bookings: [], nextCursor: null } });
    if (path === '/auth/logout') {
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/auth/phone-grant' && route.request().method() === 'DELETE') {
      enabled = false;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/start')) {
      counter += 1;
      return route.fulfill({ status: 202, json: { challengeId: counter.toString(16).padStart(24, '0') } });
    }
    if (path.endsWith('/complete')) {
      if (body?.code !== '123456') return route.fulfill({
        status: 400, json: { error: { code: 'INVALID_CHALLENGE', message: 'The code is invalid or expired.', requestId: 'synthetic' } }
      });
      if (path === '/auth/phone-grant/complete') {
        enabled = true;
        return route.fulfill({ status: 204 });
      }
      if (path === '/auth/recovery/complete') {
        signedIn = false;
        return route.fulfill({ status: 204 });
      }
      signedIn = true;
      return route.fulfill({ status: path === '/auth/signup/complete' ? 201 : 200, json: account });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unexpected fixture request.', requestId: 'synthetic' } } });
  });
  return requests;
}

test('patient signup supports invalid-code retry and resend using response fixtures', async ({ page }, testInfo) => {
  const requests = await smsScreenFixtures(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a patient account', exact: true }).click();
  await expect(page.getByText('SMS delivery is not connected', { exact: false })).toBeVisible();
  await page.getByLabel('Full name').fill('Synthetic Patient');
  await page.getByLabel('Contact phone').fill(phone);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Verification code').fill('000000');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Verify and create account' }).click();
  await expect(page.getByText('The code is invalid or expired.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByLabel('Verification code')).toHaveValue('');
  await page.getByLabel('Verification code').fill('123456');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Verify and create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your consultations' })).toBeVisible();
  expect(requests.filter((request) => request.path === '/auth/signup/start')).toHaveLength(2);
  const completed = requests.filter((request) => request.path === '/auth/signup/complete');
  expect(completed[0]!.body.challengeId).not.toBe(completed[1]!.body.challengeId);
  await page.getByRole('button', { name: 'Your account', exact: true }).click();
  await expect(page.locator('.account-identifiers')).toContainText(loginId);
  await page.screenshot({ path: testInfo.outputPath('signup-account.png'), fullPage: true, scale: 'css' });
});

test('phone authorization, code sign-in and recovery use account-specific requests', async ({ page }, testInfo) => {
  const requests = await smsScreenFixtures(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Your account', exact: true }).click();
  const settings = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Phone sign-in', exact: true }) });
  await settings.getByLabel('Authorize a sign-in phone').fill(phone);
  await settings.getByLabel('Current password').fill(password);
  await settings.getByRole('button', { name: 'Send verification code' }).click();
  await settings.getByLabel('Verification code').fill('123456');
  await settings.getByRole('button', { name: 'Verify sign-in phone' }).click();
  await expect(settings.getByText('Phone sign-in enabled.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with a code', exact: true }).click();
  await page.getByLabel('Login ID').fill(loginId);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your consultations' })).toBeVisible();
  await page.getByRole('button', { name: 'Your account', exact: true }).click();
  await settings.getByRole('button', { name: 'Disable phone sign-in' }).click();
  await expect(settings.getByText('Phone sign-in disabled.', { exact: true })).toBeVisible();
  await settings.getByLabel('Authorize a sign-in phone').fill(phone);
  await settings.getByLabel('Current password').fill(password);
  await settings.getByRole('button', { name: 'Send verification code' }).click();
  await settings.getByLabel('Verification code').fill('123456');
  await settings.getByRole('button', { name: 'Verify sign-in phone' }).click();
  await expect(settings.getByText('Phone sign-in enabled.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
  await page.getByLabel('Login ID').fill(loginId);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Verification code').fill('123456');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('Password updated. Sign in with your login ID and new password.')).toBeVisible();
  expect(requests.find((request) => request.path === '/auth/phone-login/start')?.body).toEqual({ loginId });
  expect(requests.find((request) => request.path === '/auth/recovery/start')?.body).toEqual({ loginId });
  await page.screenshot({ path: testInfo.outputPath('recovery-complete.png'), fullPage: true, scale: 'css' });
  const token = '111111111111111111111111.' + 'A'.repeat(43);
  await page.goto('/#recovery=' + token);
  await expect(page.getByLabel('Recovery token')).toHaveValue(token);
  await page.getByRole('button', { name: 'Back to sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

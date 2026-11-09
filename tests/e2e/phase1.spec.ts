import { expect, test } from '@playwright/test';

// End-to-end Phase 1 journey against a LOCAL Supabase stack + `ng serve`.
// Requires: `npx supabase start` (Docker) and the publishable key in
// apps/web/src/environments/environment.ts. Run: `npm run test:e2e`.

const unique = Date.now().toString(36);
const email = `owner-${unique}@example.test`;
const password = 'Salonzoft2026!';

test.describe.configure({ mode: 'serial' });

test('sign up → create business → dashboard', async ({ page }) => {
  await page.goto('/auth/signup');
  await page.getByLabel('Full name').fill('E2E Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Business name').fill(`E2E Salon ${unique}`);
  await expect(page.getByText('Available')).toBeVisible();
  await page.getByRole('button', { name: 'Create my business' }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await expect(page.getByText('Finish setting up')).toBeVisible();
});

test('Arabic switches the layout to RTL', async ({ page }) => {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole('button', { name: 'Language' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('link', { name: 'لوحة التحكم' })).toBeVisible();
});

test('owner can invite a team member and gets a one-time link', async ({ page }) => {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto('/settings/team');
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByLabel('Email address').fill(`staff-${unique}@example.test`);
  await page.getByLabel('Receptionist').check();
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByText('Invitation created')).toBeVisible();
  await expect(page.locator('input[readonly]')).toHaveValue(/\/accept-invite\?token=[0-9a-f]{64}$/);
});

test('signed-out users are redirected to login', async ({ page }) => {
  await page.goto('/settings/team');
  await expect(page).toHaveURL(/\/auth\/login\?next=%2Fsettings%2Fteam/);
});

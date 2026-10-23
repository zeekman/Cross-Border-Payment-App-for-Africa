const { test, expect } = require('@playwright/test');

test.describe('smoke', () => {
  test('login page renders the sign-in form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password').first()).toBeVisible();
  });

  test('unauthenticated users are redirected from /dashboard to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unauthenticated payment-request link is remembered and sent to /login', async ({ page }) => {
    const link = '/send?request=00000000-0000-0000-0000-000000000000';
    await page.goto(link);
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => sessionStorage.getItem('afripay_redirect'))).toBe(link);
  });
});

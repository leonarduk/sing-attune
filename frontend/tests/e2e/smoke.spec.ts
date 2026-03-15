import { expect, test } from '@playwright/test';

test('loads sing-attune shell', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/sing-attune/i);
  await expect(page.getByRole('heading', { level: 1, name: 'sing-attune' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Play \(Space\)/i })).toBeVisible();
});

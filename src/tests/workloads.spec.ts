import { expect, test } from '@playwright/test';

/**
 * The controllers menu once lost Scale and Rollout restart when the deployments tab
 * became the shared inventory table — the menu was rebuilt with only the generic
 * actions. These tests pin what each kind's menu offers, so a rebuild cannot silently
 * drop an action again.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/preview.html?view=workloads');
  await page.waitForSelector('.viz-table');
});

const openMenu = async (page: import('@playwright/test').Page, rowText: string) => {
  await page.getByRole('row').filter({ hasText: rowText }).getByRole('button').click();
  return page.locator('.tmj-menu');
};

test('a deployment offers scale and rollout restart again', async ({ page }) => {
  const menu = await openMenu(page, 'checkout-api');
  await expect(menu).toContainText('Scale…');
  await expect(menu).toContainText('Rollout restart');
  await expect(menu).toContainText('Edit YAML');
});

test('a stateful set offers both as well', async ({ page }) => {
  const menu = await openMenu(page, 'postgres');
  await expect(menu).toContainText('Scale…');
  await expect(menu).toContainText('Rollout restart');
});

test('a daemon set restarts but does not scale', async ({ page }) => {
  // Its replica count is the node list, not a number to set.
  const menu = await openMenu(page, 'fluent-bit');
  await expect(menu).toContainText('Rollout restart');
  await expect(menu).not.toContainText('Scale…');
});

test('a job and a cron job offer neither', async ({ page }) => {
  const job = await openMenu(page, 'schema-migrate');
  await expect(job).toContainText('Edit YAML');
  await expect(job).not.toContainText('Scale…');
  await expect(job).not.toContainText('Rollout restart');
  await page.keyboard.press('Escape');

  const cron = await openMenu(page, 'nightly-reconcile');
  await expect(cron).not.toContainText('Scale…');
  await expect(cron).not.toContainText('Rollout restart');
});

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
  // The detail panel below also renders a .viz-table, so waiting for that selector
  // can pass before the inventory arrives — and the late reflow closes any menu
  // opened meanwhile (menus close on scroll by design). Wait for inventory content.
  await page.getByText('nightly-reconcile').waitFor();
});

const openMenu = async (page: import('@playwright/test').Page, rowText: string) => {
  const trigger = page.getByRole('row').filter({ hasText: rowText }).getByRole('button');
  // The menu closes on scroll by design, and clicking a row below the fold makes
  // Playwright scroll to it — so settle the scroll first, then open.
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await trigger.click();
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
  // Under load the next click can race the close; wait for the menu to be gone.
  await expect(page.locator('.tmj-menu')).toHaveCount(0);

  const cron = await openMenu(page, 'nightly-reconcile');
  await expect(cron).not.toContainText('Scale…');
  await expect(cron).not.toContainText('Rollout restart');
});

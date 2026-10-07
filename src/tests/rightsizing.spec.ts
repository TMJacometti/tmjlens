import { expect, test } from '@playwright/test';

test.describe('rightsizing', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto('/preview.html?view=rightsizing');
    await page.waitForSelector('.rs-page');
  });

  test('the invoice warning is stated, not implied by a dollar figure', async ({ page }) => {
    await expect(page.locator('.rs-page')).toContainText('only lowers the bill if the node autoscaler consolidates');
  });

  test('a cold-start row is labelled limited and does not invent a dollar saving', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'payments' });
    await expect(row).toContainText('limited');
    await expect(row).toContainText('OOM');
    await expect(row).toContainText('low');
  });

  test('HPA apply stays blocked when the install flag is off', async ({ page }) => {
    await expect(page.locator('.rs-hpa')).toContainText('hpaManager.enabled=false');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  });

  test('the recommendation carries the numbers that produced it', async ({ page }) => {
    await expect(page.locator('.rs-reason')).toContainText('p95');
    await expect(page.locator('.rs-reason')).toContainText('peak working set');
    await expect(page.locator('.rs-rec')).toContainText('Recommended CPU');
  });
});

test.describe('rightsizing coverage', () => {
  test('nodes without a running collector are named, with the scheduler reason', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=rightsizing');
    const banner = page.locator('.viz-callout-critical').filter({ hasText: 'The collector runs on' });
    await expect(banner).toContainText('5 of 9 nodes');
    await expect(banner).toContainText('the other 4 are NOT measured');
    await expect(banner).toContainText('ip-10-42-7-11');
    await expect(banner).toContainText('Too many pods');
    // The fix is spelled out next to the problem, not left to a search.
    await expect(banner).toContainText('collector.priorityClassName');
  });
});

test.describe('resource editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=rightsizing');
    await page.waitForSelector('.rs-resources');
  });

  test('the form opens pre-filled with the recommendation, limits kept', async ({ page }) => {
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('110');
    await expect(page.getByLabel('Memory request MiB')).toHaveValue('144');
    // Limits are not part of the recommendation; the current ones stay.
    await expect(page.getByLabel('CPU limit millicores')).toHaveValue('1000');
    await expect(page.getByLabel('Memory limit MiB')).toHaveValue('1024');
  });

  test('current and recommended are both on screen, so the change is legible', async ({ page }) => {
    const panel = page.locator('.rs-resources');
    await expect(panel).toContainText('500m / 1.0 cores');
    await expect(panel).toContainText('512 MiB / 1.0 GiB');
    await expect(panel).toContainText('2 replica(s) restart');
  });

  test('apply stays blocked while the install flag is off', async ({ page }) => {
    await expect(page.locator('.rs-resources')).toContainText('resourceEditor.enabled=false');
    await expect(page.getByRole('button', { name: 'Apply resources' })).toBeDisabled();
  });

  test('reset to current puts the live numbers back in the form', async ({ page }) => {
    await page.getByRole('button', { name: 'Reset to current' }).click();
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('500');
    await page.getByRole('button', { name: 'Use recommendation' }).click();
    await expect(page.getByLabel('CPU request millicores')).toHaveValue('110');
  });
});

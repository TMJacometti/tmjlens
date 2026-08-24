import { expect, test } from '@playwright/test';

/**
 * Live usage: the columns and the detail tab. Severity is always accompanied by the
 * number in words, and a missing limit shows words rather than a bar with no edge.
 */
test.describe('pods table usage columns', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=workloads');
    await page.getByRole('button', { name: /^Pods \d/ }).click();
    await page.waitForSelector('.viz-table');
  });

  test('usage appears beside readiness, in real units', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'checkout-api-7d9f8b6c4d-5kx2m' });
    await expect(row).toContainText('182m');
    await expect(row).toContainText('402Mi');
  });

  test('memory near its limit carries the percentage in words, not colour alone', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'checkout-api-7d9f8b6c4d-9wq8p' });
    await expect(row).toContainText('981Mi');
    await expect(row).toContainText('96% of limit');
  });

  test('cpu pinned at its limit says throttled', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'checkout-api-7d9f8b6c4d-9wq8p' });
    await expect(row).toContainText('throttled');
  });

  test('a pod with no sample shows a dash, never a zero', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'fraud-scoring' });
    await expect(row).toContainText('—');
  });
});

test.describe('pod usage detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto('/preview.html?view=pod-usage');
    await page.waitForSelector('.usage-panel');
  });

  test('the header totals the pod and dates the sample', async ({ page }) => {
    const head = page.locator('.usage-head');
    await expect(head).toContainText('612m CPU');
    await expect(head).toContainText('1.6Gi memory');
    await expect(head).toContainText(/sample \d+s old · 30s window/);
  });

  test('a container in the OOMKill range is named critical with its number', async ({ page }) => {
    const api = page.locator('.usage-container').filter({ hasText: 'api' }).first();
    await expect(api).toContainText('96% of limit');
    await expect(api.locator('.usage-critical')).toHaveCount(1);
  });

  test('cpu over its limit is a warning, not a crisis', async ({ page }) => {
    const api = page.locator('.usage-container').filter({ hasText: 'api' }).first();
    // 520m of a 500m limit: throttled — compressible, so warning.
    await expect(api).toContainText('104% of limit');
    await expect(api.locator('.usage-warning')).toHaveCount(1);
  });

  test('containers sort heaviest memory first', async ({ page }) => {
    const names = await page.locator('.usage-container h4').allTextContents();
    expect(names[0]).toBe('api');
  });

  test('no limit means words, not a bar with an invented edge', async ({ page }) => {
    const shipper = page.locator('.usage-container').filter({ hasText: 'log-shipper' });
    await expect(shipper).toContainText('no limit');
    await expect(shipper.locator('.usage-meter')).toHaveCount(0);
  });
});

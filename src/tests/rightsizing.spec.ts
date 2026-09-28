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
    await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  test('the recommendation carries the numbers that produced it', async ({ page }) => {
    await expect(page.locator('.rs-reason')).toContainText('p95');
    await expect(page.locator('.rs-reason')).toContainText('peak working set');
    await expect(page.locator('.rs-rec')).toContainText('Recommended CPU');
  });
});

import { expect, test } from '@playwright/test';

/**
 * The Kyverno screen exists for one distinction above all: Enforce blocks,
 * Audit only reports. These tests pin that the distinction is stated, that
 * verdicts name the resource, and that the mode switch never happens silently.
 */
test.describe('kyverno', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=kyverno');
    await page.waitForSelector('.kyv-page');
  });

  test('the tiles separate blocking from merely reporting', async ({ page }) => {
    await expect(page.getByText('2 Enforce · 2 Audit')).toBeVisible();
    await expect(page.getByText('Audit blocks nothing')).toBeVisible();
  });

  test('an audit policy with failures is called out as reporting, not blocking', async ({ page }) => {
    const finding = page.locator('.cfg-finding-serious').filter({ hasText: 'Reporting, not blocking' });
    await expect(finding).toContainText('disallow-latest-tag');
    await finding.locator('summary').click();
    await expect(finding.locator('p')).toContainText('the same violations keep being admitted');
  });

  test('a policy kyverno rejected shows its own message', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'add-default-netpol' });
    await expect(row).toContainText('Not ready');
    await expect(row).toContainText('variable substitution failed');
  });

  test('violations name the resource the way an operator would type it', async ({ page }) => {
    await page.getByRole('tab', { name: /Violations/ }).click();
    const row = page.getByRole('row').filter({ hasText: 'checkout-api' });
    await expect(row).toContainText('deployment payments/checkout-api');
    await expect(row).toContainText('uses the latest tag');
  });

  test('switching to enforce warns about bouncing deploys and needs confirmation', async ({ page }) => {
    let warning = '';
    page.on('dialog', (dialog) => {
      warning = dialog.message();
      void dialog.dismiss();
    });
    await page
      .getByRole('row')
      .filter({ hasText: 'disallow-latest-tag' })
      .getByRole('button', { name: 'Make Enforce' })
      .click();
    expect(warning).toContain('REJECTED');
    expect(warning).toContain('9 existing resource(s)');
    // Dismissed: nothing happened, no toast.
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('confirming the switch reports the server sentence', async ({ page }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await page
      .getByRole('row')
      .filter({ hasText: 'verify-image-signatures' })
      .getByRole('button', { name: 'Make Audit' })
      .click();
    await expect(page.getByRole('status')).toContainText('verify-image-signatures is now Audit');
  });

  test('the filter narrows both tabs', async ({ page }) => {
    await page.getByLabel('Filter').fill('ledger');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody')).toContainText('No policy matches');

    await page.getByLabel('Filter').fill('');
    await page.getByRole('tab', { name: /Violations/ }).click();
    await page.getByLabel('Filter').fill('ledger');
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });
});

test.describe('kyverno absent', () => {
  test('says so plainly instead of an empty screen', async ({ page }) => {
    await page.goto('/preview.html?view=kyverno-absent');
    await expect(page.getByText('Kyverno is not installed in this cluster.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  });
});

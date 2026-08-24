import { expect, test } from '@playwright/test';

/**
 * The Helm screen's guarantees: reading needs no helm binary and says so, the stuck
 * lock is explained rather than listed, and the CLI operations refuse honestly when
 * there is no CLI rather than half-working.
 */
test.describe('helm', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=helm');
    await page.waitForSelector('.helm-page');
  });

  test('releases are read from the cluster, and the screen says so', async ({ page }) => {
    await expect(page.locator('.wl-lead')).toContainText('no helm binary');
    await expect(page.locator('.helm-page')).toContainText('payments-api');
    await expect(page.locator('.helm-page')).toContainText('ingress-nginx');
  });

  test('a failed release leads the list with its reason in words', async ({ page }) => {
    const first = page.locator('tbody tr').first();
    await expect(first).toContainText('payments-api');
    await expect(first).toContainText('failed');
    await expect(first).toContainText('may be mixed between versions');
  });

  test('a stuck pending release is explained as Helm’s lock', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'ledger-cache' });
    await expect(row).toContainText('pending-upgrade');
    await expect(row).toContainText("Helm's lock");
    await expect(row).toContainText('rolling back');
  });

  test('the detail panel shows history with the failed hook named', async ({ page }) => {
    await page.getByRole('button', { name: 'payments-api', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('payments-api-5.3.0');

    await dialog.getByRole('tab', { name: 'History' }).click();
    await expect(dialog).toContainText('post-upgrade hooks failed');
    // The current revision offers no rollback to itself.
    const current = dialog.getByRole('row').filter({ hasText: 'current' });
    await expect(current.getByRole('button', { name: /Roll back/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Roll back to this/ })).toHaveCount(2);
  });

  test('values show only what the operator set', async ({ page }) => {
    await page.getByRole('button', { name: 'payments-api', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Values' }).click();
    await expect(dialog).toContainText('Chart defaults are not repeated');
    await expect(dialog).toContainText('replicaCount: 4');
  });

  test('the manifest tab shows what the release rendered', async ({ page }) => {
    await page.getByRole('button', { name: 'payments-api', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Manifest' }).click();
    await expect(dialog).toContainText('kind: Deployment');
  });

  test('with the CLI present, uninstall is offered', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Uninstall/ }).first()).toBeEnabled();
    await expect(page.locator('.helm-kpis')).toContainText('v3.15.2');
  });
});

test.describe('helm without the CLI', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=helm-nocli');
    await page.waitForSelector('.helm-page');
  });

  test('reading still works, and the missing CLI is stated as a fact', async ({ page }) => {
    await expect(page.locator('.helm-page')).toContainText('payments-api');
    await expect(page.locator('.helm-kpis')).toContainText('not found');
    await expect(page.locator('.helm-kpis')).toContainText('Read-only until helm is on PATH');
  });

  test('uninstall is refused with the reason, not hidden and not faked', async ({ page }) => {
    // Deleting the manifest objects ourselves would skip the chart's delete hooks.
    const button = page.getByRole('button', { name: /Uninstall/ }).first();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /delete hooks/);
  });

  test('rollback in the history is disabled for the same reason', async ({ page }) => {
    await page.getByRole('button', { name: 'payments-api', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'History' }).click();
    await expect(dialog.getByRole('button', { name: /Roll back to this/ }).first()).toBeDisabled();
  });
});

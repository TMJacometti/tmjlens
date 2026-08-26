import { expect, test } from '@playwright/test';

/**
 * The Argo Workflows screen: reads come from the cluster's own CRDs, a failed run
 * names the step that failed, and the image editor — the maintenance the screen
 * exists for — edits one slot at a time and never pretends a steps-only template
 * has an image to change.
 */
test.describe('argo workflows', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=argo');
    await page.waitForSelector('.argo-page');
  });

  test('a failed run leads the list with Argo\'s own message', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'nightly-etl-8kx2m' });
    await expect(row).toContainText('Failed');
    await expect(row).toContainText('OOMKilled (exit code 137)');
    await expect(row).toContainText('1/3');
  });

  test('a running workflow shows progress and offers Stop', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'ledger-backfill-p9qrt' });
    await expect(row).toContainText('Running');
    await expect(row).toContainText('2/5');
    await expect(row.getByRole('button', { name: 'Stop' })).toBeVisible();
    // A finished run has nothing to stop.
    const done = page.getByRole('row').filter({ hasText: 'nightly-etl-7ttw4' });
    await expect(done.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  });

  test('a suspended cron says it will not run, and offers Resume', async ({ page }) => {
    await page.getByRole('tab', { name: /Cron workflows/ }).click();
    const row = page.getByRole('row').filter({ hasText: 'weekly-reconcile' });
    await expect(row).toContainText('Suspended');
    await expect(row).toContainText('will not run on its schedule');
    await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  test('templates summarise their images and open the editor', async ({ page }) => {
    await page.getByRole('tab', { name: /Templates/ }).click();
    const row = page.getByRole('row').filter({ hasText: 'ledger-backfill' });
    await expect(row).toContainText('backfill:1.9.2 and 2 more');

    await page.getByRole('button', { name: 'ledger-backfill', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('3 images');
    // A containerSet member is addressed by template · container.
    await expect(dialog).toContainText('publish · sign');
    await expect(dialog).toContainText('Editing changes what the next run uses');
  });

  test('editing an image saves in place', async ({ page }) => {
    await page.getByRole('tab', { name: /Templates/ }).click();
    await page.getByRole('button', { name: 'ledger-backfill', exact: true }).click();
    const dialog = page.getByRole('dialog');

    const slot = dialog.locator('.argo-slot').filter({ hasText: 'backfill' }).first();
    await slot.getByRole('button', { name: 'Edit' }).click();
    await slot.getByRole('textbox').fill('registry.example.com/acme/backfill:2.0.0');
    await slot.getByRole('button', { name: 'Save' }).click();

    await expect(slot).toContainText('backfill:2.0.0');
    await expect(slot.getByRole('textbox')).toHaveCount(0);
  });

  test('an empty image is refused before anything is sent', async ({ page }) => {
    await page.getByRole('tab', { name: /Templates/ }).click();
    await page.getByRole('button', { name: 'nightly-etl', exact: true }).click();
    const dialog = page.getByRole('dialog');

    const slot = dialog.locator('.argo-slot').first();
    await slot.getByRole('button', { name: 'Edit' }).click();
    await slot.getByRole('textbox').fill('   ');
    await slot.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toContainText('cannot be empty');
  });

  test('a steps-only template says it has no image of its own', async ({ page }) => {
    await page.getByRole('tab', { name: /Templates/ }).click();
    await page.getByRole('button', { name: 'orchestrator', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('its steps reference other templates');
    await expect(dialog.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });

  test('templates offer Run now', async ({ page }) => {
    await page.getByRole('tab', { name: /Templates/ }).click();
    const row = page.getByRole('row').filter({ hasText: 'nightly-etl' });
    await expect(row.getByRole('button', { name: 'Run now' })).toBeEnabled();
  });
});

test.describe('argo editing beyond the image', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto('/preview.html?view=argo');
    await page.waitForSelector('.argo-page');
  });

  test('live usage appears for the running workflow and only for it', async ({ page }) => {
    const running = page.getByRole('row').filter({ hasText: 'ledger-backfill-p9qrt' });
    await expect(running).toContainText('1.2 cores · 3.2Gi');
    const done = page.getByRole('row').filter({ hasText: 'nightly-etl-7ttw4' });
    await expect(done.locator('.argo-usage')).toContainText('—');
  });

  test('a cron workflow opens with its schedule editable', async ({ page }) => {
    await page.getByRole('tab', { name: /Cron workflows/ }).click();
    await page.getByRole('button', { name: 'nightly-etl', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('0 2 * * *');

    await dialog.locator('.argo-schedule').getByRole('button', { name: 'Edit' }).click();
    await dialog.getByLabel('Cron schedule').fill('0 4 * * *');
    await dialog.locator('.argo-schedule').getByRole('button', { name: 'Save' }).click();
    await expect(dialog.locator('.argo-schedule')).toContainText('0 4 * * *');
  });

  test('each slot shows its resources in words, unset included', async ({ page }) => {
    await page.getByRole('tab', { name: /Cron workflows/ }).click();
    await page.getByRole('button', { name: 'nightly-etl', exact: true }).click();
    const dialog = page.getByRole('dialog');

    const extract = dialog.locator('.argo-slot').filter({ hasText: 'extract' });
    await expect(extract).toContainText('requests 200m · 512Mi, limits 1 · 2Gi');
    const load = dialog.locator('.argo-slot').filter({ hasText: 'load' });
    await expect(load).toContainText('no requests or limits set');
  });

  test('resources are edited per container and saved in place', async ({ page }) => {
    await page.getByRole('tab', { name: /Cron workflows/ }).click();
    await page.getByRole('button', { name: 'nightly-etl', exact: true }).click();
    const dialog = page.getByRole('dialog');

    const load = dialog.locator('.argo-slot').filter({ hasText: 'load' });
    await load.getByRole('button', { name: 'Resources' }).click();
    await expect(load).toContainText('Memory limit is the OOMKill point');
    await load.getByPlaceholder(/1Gi/).fill('2Gi');
    await load.getByPlaceholder(/256Mi/).fill('512Mi');
    await load.getByRole('button', { name: 'Save resources' }).click();

    await expect(load).toContainText('requests 512Mi, limits 2Gi');
  });
});

test.describe('argo absent', () => {
  test('absence is a fact with an explanation, not an error page', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto('/preview.html?view=argo-absent');
    await page.waitForSelector('.argo-page');
    await expect(page.locator('.argo-page')).toContainText('No Argo Workflows in this cluster');
    await expect(page.locator('.argo-page')).toContainText('No Argo server or CLI is involved');
  });
});

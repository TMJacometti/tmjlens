import { expect, test } from '@playwright/test';

/**
 * The Access screen's guarantees: a fresh SSO login is guest (Cluster Overview
 * only), the three profiles are fixed rather than a permission matrix, the
 * admin cannot deactivate their own account, and the audit trail names the
 * person and the outcome — including the refusals.
 */
test.describe('access', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto('/preview.html?view=access');
    await page.waitForSelector('.access-page');
  });

  test('the model is stated up front and the KPIs surface who is still a guest', async ({ page }) => {
    await expect(page.locator('.wl-lead')).toContainText('guest');
    await expect(page.locator('.wl-lead')).toContainText('Cluster Overview');
    await expect(page.locator('.access-kpis')).toContainText('Guests');
    await expect(page.locator('.access-kpis')).toContainText('waiting for a promotion');
    await expect(page.locator('.access-kpis')).toContainText('Denied recently');
  });

  test('a fresh registration shows as guest and can still be promoted', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'novo.colega@tmjsistemas.com.br' });
    await expect(row).toContainText('guest');
    await expect(row.locator('select.access-grant')).toBeVisible();
    await expect(row.locator('select.access-grant')).toContainText('developer');
    await expect(row.locator('select.access-grant')).toContainText('admin');
  });

  test('a developer is listed as such, not as a bundle of permissions', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'maria.souza@tmjsistemas.com.br' });
    await expect(row).toContainText('developer');
    await expect(row).not.toContainText('viewer');
  });

  test('the signed-in admin cannot deactivate themselves', async ({ page }) => {
    const self = page.getByRole('row').filter({ hasText: 'tm.jacometti@tmjsistemas.com.br' });
    await expect(self).toContainText('you');
    const button = self.getByRole('button', { name: 'Deactivate' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /another admin/);
  });

  test('a deactivated account is dimmed and offers reactivation only', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'ex.funcionario@tmjsistemas.com.br' });
    await expect(row).toContainText('deactivated');
    await expect(row.getByRole('button', { name: 'Reactivate' })).toBeEnabled();
  });

  test('profiles are the three fixed roles, described, not a permission grid', async ({ page }) => {
    await page.getByRole('tab', { name: /Profiles/ }).click();
    const cards = page.locator('.access-profile');
    await expect(cards).toHaveCount(3);
    await expect(page.getByRole('heading', { name: 'admin' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'developer' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'guest' })).toBeVisible();
    await expect(page.locator('.access-profile').filter({ hasText: 'developer' }))
      .toContainText('Cluster Overview');
    await expect(page.locator('.access-profile').filter({ hasText: 'developer' }))
      .toContainText('Cannot scale, delete a deploy, or port-forward');
    await expect(page.locator('.access-profile').filter({ hasText: 'guest' }))
      .toContainText('Cluster Overview only');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('.access-profile-new')).toHaveCount(0);
  });

  test('the audit trail names the person and shows denials in red', async ({ page }) => {
    await page.getByRole('tab', { name: /Audit/ }).click();
    const denied = page.getByRole('row').filter({ hasText: 'list_pods' });
    await expect(denied).toContainText('novo.colega@tmjsistemas.com.br');
    await expect(denied).toContainText('denied');
    await expect(denied).toContainText("requires 'view'");
    const scaleDenied = page.getByRole('row').filter({ hasText: 'scale_workload' });
    await expect(scaleDenied).toContainText('maria.souza@tmjsistemas.com.br');
    await expect(scaleDenied).toContainText('denied');
    const granted = page.getByRole('row').filter({ hasText: 'bootstrap-admin-granted' });
    await expect(granted).toContainText('allowed');
  });
});

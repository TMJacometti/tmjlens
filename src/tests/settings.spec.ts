import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * The About tab must never lie about the build: the version comes from
 * package.json (it once said 0.1.0 forever), and the what's-new box describes
 * the running release.
 */
test.describe('settings about', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/preview.html?view=settings');
    await page.getByRole('button', { name: 'About' }).click();
  });

  test('the version shown is the version built', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toContainText(`Version`);
    await expect(dialog).toContainText(version);
    await expect(dialog).not.toContainText('0.1.0');
  });

  test('the release notes close the tab and name this release', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toContainText(`What's new in ${version}`);
    await expect(dialog).toContainText('developer profile now follows the environment');
    await expect(dialog).toContainText('audit trail can be switched off');
  });
});

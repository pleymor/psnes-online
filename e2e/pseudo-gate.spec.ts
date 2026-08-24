import { test, expect } from '@playwright/test';
import { loginDev, apiFetch } from './helpers';

/**
 * The onboarding gate, and the one claim about it a unit test cannot make.
 *
 * requirePseudo is covered directly in backend/test/require-pseudo.test.ts, and
 * the format rules in backend/test/pseudo.test.ts. What only a browser can
 * settle is whether the rest of the page is genuinely unreachable behind the
 * modal, and whether a deep link survives it - which is the argument that made
 * an overlay preferable to a /welcome redirect, so it has to be verified
 * rather than assumed.
 *
 * Dev user 3 is put back in front of the gate on every sign-in, so this file
 * can run more than once against the same database.
 */
test.describe('the onboarding gate', () => {
  test('an account with no chosen nickname cannot reach anything else', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Dev User 3/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The page behind carries the native `inert` attribute, which takes it out
    // of the tab order and out of pointer events at once.
    await expect(page.locator('.app')).toHaveAttribute('inert', '');

    // And the rule survives the browser entirely: the server refuses the
    // routes, which is what a curl with this session cookie would meet.
    const cookie = await loginDev('3');
    const rooms = await apiFetch(cookie, '/api/rooms');
    expect(rooms.status).toBe(409);
    expect((await rooms.json()).error).toBe('PSEUDO_REQUIRED');
  });

  test('the modal refuses a nickname the rule rejects', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Dev User 3/ }).click();

    const dialog = page.getByRole('dialog');
    const field = dialog.getByRole('textbox');
    const submit = dialog.getByRole('button');

    await field.fill('ab');
    await expect(submit).toBeDisabled();

    await field.fill('Émile');
    await expect(submit).toBeDisabled();

    await field.fill('Valid_One');
    await expect(submit).toBeEnabled();
  });

  test('a deep link survives the gate, rather than being redirected away', async ({ page }) => {
    // The room need not exist: what is under test is that the URL is still
    // there afterwards, which a redirect to a dedicated page would lose.
    await page.goto('/');
    await page.getByRole('button', { name: /Dev User 3/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.goto('/room/deep-link-target');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/room/deep-link-target');

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('Newbie');
    await dialog.getByRole('button').click();

    await expect(dialog).toBeHidden();
    // Still on the address they arrived at, with the modal gone.
    expect(new URL(page.url()).pathname).toBe('/room/deep-link-target');
  });

  test('a friend is added by handle, and only by handle', async ({ page }) => {
    const cookie = await loginDev('1');

    // The search endpoint is gone, not merely hidden.
    const search = await apiFetch(cookie, '/api/friends/search?query=Dev');
    expect(search.status).toBe(404);

    const malformed = await apiFetch(cookie, '/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ handle: 'DevTwo' })
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe('HANDLE_MALFORMED');

    const missing = await apiFetch(cookie, '/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ handle: 'DevTwo#9999' })
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('HANDLE_NOT_FOUND');

    // An internal id is no longer a way in, even though room payloads carry
    // one: that was the bypass the friendId path would have left open.
    const byId = await apiFetch(cookie, '/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ friendId: 'dev-user-2' })
    });
    expect(byId.status).toBe(400);
  });

  test('the profile shows the code that replaced the email', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Dev User 1/ }).click();
    await page.goto('/profile');

    await expect(page.getByText('DevOne#0001')).toBeVisible();
    // The email line is gone with the column.
    await expect(page.getByText('@dev.local')).toHaveCount(0);
  });
});

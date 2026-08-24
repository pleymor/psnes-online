import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import { loginDev, connectSocket, createRoom, befriendDevUsers } from './helpers';

test.describe('app shell', () => {
  let friendSocket: Socket | undefined;

  test.afterAll(() => friendSocket?.close());

  test('dev login lands on a populated library without a reload', async ({ page }) => {
    // Give Dev User 1 a friend who is hosting a room, so the sidebar has
    // something that can only come from /api/rooms.
    const c1 = await loginDev('1');
    const c2 = await loginDev('2');
    await befriendDevUsers(c1, c2);
    friendSocket = await connectSocket(c2);
    await createRoom(friendSocket, 'Zelda (friend room)');

    const consoleErrors: string[] = [];
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));

    const roomsRequests: number[] = [];
    page.on('response', r => {
      if (new URL(r.url()).pathname === '/api/rooms') roomsRequests.push(r.status());
    });

    await page.goto('/');
    await expect(page.getByText('Development Mode')).toBeVisible();

    await page.getByRole('button', { name: /Dev User 1/ }).click();

    // Authenticated shell
    await expect(page.locator('.app-layout')).toBeVisible();
    // The top bar identifies the player by pseudonym now - there is no display
    // name left to show. It lives on the avatar link's title, which is also
    // the link's accessible name, so this asserts what a screen reader hears
    // rather than an incidental piece of markup.
    await expect(page.getByTitle('DevOne')).toBeVisible();

    // Regression: loginDev used to only user.set()+goto('/'), which does not
    // re-run onMount, so the library and room fetches never fired until F5.
    await expect
      .poll(() => roomsRequests.length, { message: '/api/rooms must be fetched after dev login' })
      .toBeGreaterThan(0);
    expect(roomsRequests).toContain(200);

    // The friend's room title is what /api/rooms feeds, and it lives in the
    // friends drawer - which is closed until asked for.
    //
    // These two lines used to assert the title and a `Join` button on the page
    // itself, and had been failing since the profile/top-bar work moved the
    // friends list behind that drawer: nothing outside it renders a friend's
    // room, and the Join button does not exist anywhere in the frontend any
    // more (checked against a311107, before the pseudonym work started, so
    // this is a repair rather than an accommodation). Joining a friend's room
    // goes through the friend details modal now.
    await page.getByRole('button', { name: 'Friends' }).click();
    await expect(page.getByText('Zelda (friend room)')).toBeVisible();

    // A 401 on /auth/me before logging in is expected; nothing else should throw.
    const unexpected = consoleErrors.filter(e => !e.includes('401'));
    expect(unexpected, 'no unexpected console errors').toEqual([]);
  });
});

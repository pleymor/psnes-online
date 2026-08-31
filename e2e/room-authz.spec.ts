import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import {
  loginDev, apiFetch, connectSocket, createRoom, waitForEvent,
  clearFriendships, befriendDevUsers, seatGuestByInvitation, joinAnonymously, API
} from './helpers';

// Events a non-member must never be able to trigger on someone else's room.
const HOSTILE_EVENTS = (roomId: string): Array<[string, unknown]> => [
  ['game:stop', { roomId }],
  ['room:release-game', { roomId }],
  ['game:pause', { roomId }],
  ['game:start', { roomId }],
  ['game:setSpeed', { roomId, speed: 4 }],
  ['p2p:join', { roomId }],
  ['p2p:host_ready', { roomId }],
  ['webrtc:signal', { roomId, signal: { type: 'offer', sdp: 'malicious' } }],
  ['game:save', { roomId, slotNumber: 1, name: 'pwned', saveData: 'AAAA' }],
  ['sync:checksum', { roomId, frame: 1, checksum: 'deadbeef' }]
];

// Events the host would observe if any of the above took effect.
const LEAK_EVENTS = [
  'game:stopped', 'room:gameReleased', 'game:paused', 'game:started', 'game:loaded',
  'game:speedChanged', 'p2p:peer-joined', 'webrtc:signal', 'sync:result'
];

test.describe('room authorization', () => {
  let c1: string, c2: string, host: Socket, outsider: Socket;

  test.beforeAll(async () => {
    c1 = await loginDev('1');
    c2 = await loginDev('2');
    await clearFriendships(c1);
    host = await connectSocket(c1);
    outsider = await connectSocket(c2);
  });

  test.afterAll(() => {
    host?.close();
    outsider?.close();
  });

  test('a non-member cannot affect a room it is not in', async () => {
    const room = await createRoom(host, 'Authz Test');

    const observed: string[] = [];
    for (const ev of LEAK_EVENTS) host.on(ev, () => observed.push(ev));

    for (const [event, payload] of HOSTILE_EVENTS(room.id)) outsider.emit(event, payload);
    await new Promise(r => setTimeout(r, 2500));

    expect(observed, 'outsider must not trigger any room event').toEqual([]);
    for (const ev of LEAK_EVENTS) host.removeAllListeners(ev);
  });

  test('the host can still drive its own room', async () => {
    const room = await createRoom(host, 'Host Flow Test');
    host.emit('room:selectPort', { roomId: room.id, port: 1 });

    const paused = waitForEvent(host, 'game:paused', 4000);
    host.emit('game:pause', { roomId: room.id });
    expect(await paused, 'host pause must still work').not.toBeNull();
  });

  test('a guest who joined the room is allowed to act', async () => {
    const room = await createRoom(host, 'Guest Flow Test');

    // `outsider` stops being one here on purpose: the invitation is the only
    // door in now, so this is what turning it into a genuine member takes -
    // and the point of the test below is what a genuine member, as opposed
    // to the host, is allowed to do.
    const joined = await seatGuestByInvitation(c1, c2, host, outsider, room.id, 'dev-user-2');
    expect(joined, 'guest must be able to join').not.toBeNull();

    // Guests legitimately pause/resume/quit, so membership (not host-only) is
    // the correct gate.
    const paused = waitForEvent(host, 'game:paused', 4000);
    outsider.emit('game:pause', { roomId: room.id });
    expect(await paused, 'a member guest must be able to pause').not.toBeNull();

    outsider.emit('room:leave', { roomId: room.id });
  });

  test('GET /api/rooms hides rooms of users who are not friends', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Scoping Test');

    const mine = await apiFetch(c1, '/api/rooms').then(r => r.json());
    const theirs = await apiFetch(c2, '/api/rooms').then(r => r.json());

    expect(mine.map((r: any) => r.id)).toContain(room.id);
    expect(theirs.map((r: any) => r.id)).not.toContain(room.id);
  });

  test('GET /api/rooms shows a friend’s room, without leaking keyConfig', async () => {
    await befriendDevUsers(c1, c2);
    const room = await createRoom(host, 'Friend Visible Test');

    const theirs = await apiFetch(c2, '/api/rooms').then(r => r.json());
    const seen = theirs.find((r: any) => r.id === room.id);

    expect(seen, 'a friend must see the room (the sidebar depends on it)').toBeTruthy();
    expect(seen.createdBy).toBe('dev-user-1');
    expect(seen.players[0]).not.toHaveProperty('keyConfig');
    expect(JSON.stringify(theirs)).not.toContain('keyConfig');
  });

  test('rooms:list on connect is scoped and carries no keyConfig', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Socket List Test');

    // A freshly connected non-friend must not be handed the room over the
    // socket either, otherwise the REST scoping is trivially bypassed.
    const fresh = await connectSocket(c2);
    const list = fresh.initialRoomsList;
    fresh.close();

    expect(list, 'rooms:list must still be emitted at connect').toBeDefined();
    expect(list.map((r: any) => r.id)).not.toContain(room.id);
    expect(JSON.stringify(list)).not.toContain('keyConfig');
  });

  /*
   * Le joueur sans compte.
   *
   * Ces tests sont écrits d'abord pour ce qu'un anonyme *ne peut pas* faire.
   * La porte est nouvelle et non authentifiée, et la seule façon de vérifier
   * qu'elle n'ouvre rien d'autre est de frapper à chacune des autres.
   */
  test('un compte non ami entre dans un salon en attente dont il tient le lien', async () => {
    /*
     * La moitié qui manquait : la porte sans compte admettait le porteur du
     * lien, mais un ami connecté se faisait refuser au même endroit. Partager
     * l'URL d'un salon ne pouvait donc pas marcher pour le cas le plus
     * courant.
     */
    await clearFriendships(c1);
    const room = await createRoom(host, 'Link Join Test');

    const updated = waitForEvent<any>(host, 'room:updated', 5000);
    outsider.emit('room:join', { roomId: room.id });
    const seen = await updated;

    expect(seen, 'l hôte doit voir le salon changer').not.toBeNull();
    expect(seen.players.length, 'deux joueurs assis').toBe(2);

    outsider.emit('room:leave', { roomId: room.id });
  });

  test('une partie en cours reste fermée au lien', async () => {
    // Le lien est un point de rendez-vous avant de jouer. S'y inviter une fois
    // lancé dérangerait deux joueurs, et le serveur refuse de toute façon de
    // changer le jeu d'un salon qui joue.
    await clearFriendships(c1);
    const room = await createRoom(host, 'Playing Room Test');

    host.emit('game:start', { roomId: room.id });
    await waitForEvent<any>(host, 'game:started', 5000);

    const refused = waitForEvent<any>(outsider, 'error', 5000);
    outsider.emit('room:join', { roomId: room.id });
    const err = await refused;

    expect(err, 'le lien ne doit pas ouvrir une partie en cours').not.toBeNull();
    expect(err.code).toBe('roomGone');
  });

  test('un anonyme entre dans le salon dont il tient le lien, et y prend un siège', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Anonymous Join Test');

    const cookie = await joinAnonymously(room.id, 'Passant');
    const anon = await connectSocket(cookie);

    const updated = waitForEvent<any>(host, 'room:updated', 5000);
    anon.emit('room:join', { roomId: room.id });
    const seen = await updated;

    expect(seen, 'l hôte doit voir le salon changer').not.toBeNull();
    expect(seen.players.map((p: any) => p.pseudo)).toContain('Passant');

    anon.emit('room:leave', { roomId: room.id });
    anon.close();
  });

  test('un anonyme n entre dans aucun autre salon que le sien', async () => {
    await clearFriendships(c1);
    const mine = await createRoom(host, 'Anonymous Own Room');
    // Un second salon, tenu par quelqu'un d'autre. Son identifiant circule
    // (liste des salons, notifications d amis) : en tenir un ne doit pas
    // suffire à y entrer.
    const other = await createRoom(outsider, 'Someone Elses Room');

    const cookie = await joinAnonymously(mine.id);
    const anon = await connectSocket(cookie);

    const observed: string[] = [];
    outsider.on('room:updated', () => observed.push('room:updated'));
    anon.emit('room:join', { roomId: other.id });
    await new Promise(r => setTimeout(r, 2000));

    expect(observed, 'le lien ouvre une porte, pas le bâtiment').toEqual([]);
    outsider.removeAllListeners('room:updated');
    anon.close();
  });

  test('un anonyme reçoit 403 sur toutes les routes de compte', async () => {
    const room = await createRoom(host, 'Anonymous Routes Test');
    const cookie = await joinAnonymously(room.id);

    for (const path of ['/api/games', '/api/friends', '/api/user/controls', '/api/rooms', '/api/logs']) {
      const res = await apiFetch(cookie, path);
      expect(res.status, `${path} doit être fermée à une session sans compte`).toBe(403);
      expect((await res.json()).error).toBe('ANONYMOUS_FORBIDDEN');
    }

    // Celle-ci comptait le plus : c est la sortie du portique du pseudonyme,
    // ouverte à tout compte connecté. Un anonyme y réserverait un handle
    // définitif dans un espace de noms unique, au nom d une session qui
    // disparaît le soir même.
    const claimed = await apiFetch(cookie, '/api/pseudo', {
      method: 'PUT',
      body: JSON.stringify({ pseudo: 'Squatteur' })
    });
    expect(claimed.status).toBe(403);
    expect((await claimed.json()).error).toBe('ANONYMOUS_FORBIDDEN');
  });

  test('un anonyme assis dans un salon n en change pas la configuration', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Anonymous Setup Test');
    const cookie = await joinAnonymously(room.id);
    const anon = await connectSocket(cookie);

    const seated = waitForEvent<any>(host, 'room:updated', 5000);
    anon.emit('room:join', { roomId: room.id });
    expect(await seated, 'l anonyme doit d abord être assis').not.toBeNull();

    // Membre du salon, donc `getMemberRoom` le laisserait passer : ce qui
    // l arrête ici est la grille, pas la qualité de membre.
    const observed: string[] = [];
    for (const ev of ['room:updated', 'game:stopped', 'room:gameReleased', 'game:saved']) {
      host.on(ev, () => observed.push(ev));
    }

    for (const [event, payload] of [
      ['room:choose-game', { roomId: room.id, gameId: 'x', gameTitle: 'x' }],
      ['room:release-game', { roomId: room.id }],
      ['room:choose-save', { roomId: room.id, saveId: 'x' }],
      ['room:setEmulationMode', { roomId: room.id, emulationMode: 'dual' }],
      ['room:setLatencyMode', { roomId: room.id, latencyMode: 8 }],
      ['game:save', { roomId: room.id, name: 'pwned', saveData: 'AAAA' }],
      ['lobby:invite', { roomId: room.id, friendId: 'dev-user-2' }]
    ] as Array<[string, unknown]>) {
      anon.emit(event, payload);
    }
    await new Promise(r => setTimeout(r, 2500));

    expect(observed, 'rejoindre un salon n est pas pouvoir le reconfigurer').toEqual([]);
    for (const ev of ['room:updated', 'game:stopped', 'room:gameReleased', 'game:saved']) {
      host.removeAllListeners(ev);
    }

    anon.emit('room:leave', { roomId: room.id });
    anon.close();
  });

  test('la porte refuse un salon qui n existe pas, sans dire lequel', async () => {
    const res = await fetch(`${API}/auth/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: '00000000-0000-4000-8000-000000000000' })
    });

    expect(res.status).toBe(404);
    // La même réponse qu un salon plein : confirmer l existence d un salon à
    // qui en tient l identifiant lui apprendrait quelque chose, et cette route
    // est ouverte à n importe qui.
    expect((await res.json()).error).toBe('ROOM_NOT_FOUND');
  });

  test('la porte refuse quelqu un qui a déjà une session', async () => {
    const room = await createRoom(host, 'Anonymous Signed In Test');

    const res = await apiFetch(c2, '/auth/anonymous', {
      method: 'POST',
      body: JSON.stringify({ roomId: room.id })
    });

    // Refusé plutôt que remplacé : effacer la session d un joueur connecté
    // parce qu il a cliqué sur un lien lui coûterait son compte le temps d une
    // partie.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ALREADY_SIGNED_IN');
  });

  test('friends:online for an accepted friend carries only the allowed fields', async () => {
    await befriendDevUsers(c1, c2);

    const online = waitForEvent<any[]>(host, 'friends:online', 4000);
    host.emit('friends:getOnlineStatus');
    const friends = await online;

    expect(friends, 'friends:online must still be emitted').not.toBeNull();
    const friend = friends!.find((f: any) => f.id === 'dev-user-2');
    expect(friend, 'the accepted friend must appear in the online-friends list').toBeTruthy();

    // The exact key set, not a list of things that must be absent.
    //
    // Naming what may not appear only catches the leaks somebody thought of;
    // this catches the next column added to User as well. The repository now
    // projects to PublicUser at the source, so a field could only get here by
    // being put there on purpose - and this says so out loud.
    expect(Object.keys(friend).sort()).toEqual(
      ['avatar', 'discriminator', 'id', 'online', 'pseudo']
    );
    // The email is gone with the column it came from.
    expect(friend).not.toHaveProperty('email');
  });
});

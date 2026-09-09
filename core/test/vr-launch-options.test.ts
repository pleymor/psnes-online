/**
 * What the launch screen shows, decided away from the screen.
 *
 * Three rules here are load-bearing rather than cosmetic, and each is a trap
 * documented in the code this replaces.
 *
 * A dump is found by CRC32, never by game id. Each player has their own `Game`
 * row for one dump, so a room whose game the friend chose carries THEIR id, and
 * looking that up in my library finds nothing.
 *
 * The save may only be chosen by whoever opened the room. The server refuses
 * otherwise (`room-handlers.ts:383`), and the refusal arrives as an `error`
 * that nothing in a headset displays - so the screen has to know before it asks.
 *
 * And nothing may claim the launch is possible when it is not. A ROM this
 * device cannot read must be named as such, because the alternative - measured
 * on 2026-09-03 - is a black screen with nothing in the logs.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  launchOptions,
  type LaunchRoom,
  type LibraryGame
} from '../../frontend/src/lib/vr/launch-options.js';
import { autoSaveName } from '../../frontend/src/lib/saves/api.js';
import { QUICK_SAVE_NAME } from '../../frontend/src/lib/saves/quick.js';

/*
 * A full `SaveSummary`, because the screen now shows what the flat page shows.
 *
 * The three fields this fixture gained - `screenshot`, `createdAt`,
 * `updatedAt` - are not decoration: `saveIdentity` reads `createdAt` to decide
 * whether a name was generated, `updatedAt` for the moment it prints, and the
 * headset draws the thumbnail. `/api/games` has always served all three
 * (`db/games.ts:127`); only the VR types dropped them.
 */
const SAVE = {
  id: 's1',
  name: 'Before the boss',
  slotNumber: 1,
  screenshot: 'data:image/png;base64,iVBORw0KGgo=',
  createdAt: '2026-09-03T18:44:00.000Z',
  updatedAt: '2026-09-03T18:44:00.000Z'
};

const LOCALE = 'fr';
const QUICK_LABEL = 'Sauvegarde rapide';

/** The two fields every call below needs and no test varies. */
const NAMING = { locale: LOCALE, quickSaveLabel: QUICK_LABEL };

function library(over: Partial<LibraryGame> = {}): LibraryGame[] {
  return [
    { id: 'mine', title: 'Super Mario World', crc32: 'aaaa1111', saves: [SAVE], ...over }
  ];
}

function room(over: Partial<LaunchRoom> = {}): LaunchRoom {
  return {
    id: 'r1',
    createdBy: 'me',
    // `me` opened this room, so `me` is its host - which matters now that the
    // host is who a guest asks for a missing ROM.
    hostId: 'me',
    status: 'waiting',
    gameCrc32: 'aaaa1111',
    players: [
      { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
      { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: true }
    ],
    ...over
  };
}

const OPENABLE = new Set(['aaaa1111']);

test('the dump is found by CRC32, not by game id', () => {
  // The room carries the friend's game id for the same cartridge. Looking that
  // up here would find nothing and the screen would have no game to draw.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ gameCrc32: 'aaaa1111' }),
    me: 'me',
    openable: OPENABLE
  });

  assert.ok(options, 'the dump is in the library and must be found');
  assert.equal(options.game.title, 'Super Mario World');
});

test('a dump that is in no library entry has nothing to show', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'ffff9999',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options, null);
});

test('the saves come from the library entry, never from a request', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.deepEqual(options!.saves.map((s) => s.id), ['s1']);
});

test('the save may be chosen in solo, because the room does not exist yet', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.mayChooseSave, true);
});

test('the save may not be chosen when somebody else opened the room', () => {
  // Not a preference: the server refuses, and the refusal is invisible in a
  // headset. Where the game starts is not a private choice.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ createdBy: 'you' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.mayChooseSave, false);
});

test('the chosen save comes from the room in a group, and from the staged value in solo', () => {
  const inGroup = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ resumeSaveId: 's1' }),
    me: 'me',
    openable: OPENABLE,
    stagedSaveId: 'ignored'
  });
  assert.equal(inGroup!.chosenSaveId, 's1', 'the room is the truth once it exists');

  const alone = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE,
    stagedSaveId: 's1'
  });
  assert.equal(alone!.chosenSaveId, 's1', 'nothing else holds it before the room exists');
});

test('the save may be chosen alone, even in a room somebody else created', () => {
  /*
   * `createdBy` never changes once a room exists - only `hostId` does, when
   * the creator leaves. A room built by a friend who then left is a real
   * state, not a hypothetical one: the lone remaining player's room still
   * carries the departed creator's id. Keying `mayChooseSave` on the room
   * existing, instead of on being a group, read this exactly like a guest in
   * somebody else's group and greyed out a list the solo launch would have
   * accepted whole.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      createdBy: 'you',
      players: [{ userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.mayChooseSave, true, 'alone is alone, whoever created the room');
});

test('the chosen save is the staged one alone, even over a stale resumeSaveId', () => {
  // The same room as above can still carry a `resumeSaveId` from before the
  // friend left. A room holding only me is not the group truth that field
  // belongs to - the locally staged choice is, exactly as in solo.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [{ userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }],
      resumeSaveId: 's1'
    }),
    me: 'me',
    openable: OPENABLE,
    stagedSaveId: undefined
  });
  assert.equal(options!.chosenSaveId, null, 'a stale resumeSaveId is not mine to inherit while alone');
});

test('there is no friend when there is no group', () => {
  const alone = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(alone!.friend, null);

  const oneSeat = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ players: [{ userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }] }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(oneSeat!.friend, null, 'a room with only me in it is not a group');
});

test('a lone player who is not me is still not a group', () => {
  /*
   * The fixture that makes the threshold provable.
   *
   * The test above only tries a one-player room whose player IS me, where
   * `length >= 2` and `length >= 1` behave identically - so it cannot tell the
   * two apart, and the rule it looks like it guards was unguarded. Caught by
   * the mutation probe on 2026-09-04, in the plan's own test code.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ players: [{ userId: 'you', pseudo: 'Bob', port: 1, isReady: true, online: true }] }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.friend, null, 'one player is not a group, whoever it is');
});

test('the friend is named with the state that decides whether the game can start', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: false }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });

  assert.deepEqual(options!.friend, { pseudo: 'Bob', online: false, port: null, isReady: false });
});

test('my port is read from my own row, and is null before I sit', () => {
  const seated = launchOptions({
    ...NAMING,
    library: library(), crc32: 'aaaa1111', room: room(), me: 'me', openable: OPENABLE
  });
  assert.equal(seated!.myPort, 1);

  const standing = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: true }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(standing!.myPort, null);
});

test('my row is found by id, not by position', () => {
  /*
   * Every other fixture puts me at index 0, which a plain `players[0]` would
   * satisfy just as well - so the matching logic read as guarded and was not.
   * A room I joined second puts my row at index 1, and matching by position
   * would hand me my friend's port and my friend my own.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: true },
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });

  assert.equal(options!.myPort, 1, 'my port was read from the wrong row');
  assert.equal(options!.friend!.pseudo, 'Bob', 'and my friend from mine');
});

test('a device that can open other games still cannot open this one', () => {
  /*
   * Every other fixture passes either the exactly-matching set or an empty
   * one, which `openable.size > 0` would satisfy too. A folder of forty
   * cartridges minus this one is the ordinary case, and getting it wrong is
   * the silent black screen this whole module exists to prevent.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    // Sans room : personne a qui demander, donc l absence bloque encore et le
    // test porte bien sur `openable` et pas sur le transfert.
    room: null,
    me: 'me',
    openable: new Set(['bbbb2222', 'cccc3333'])
  });

  assert.equal(options!.romHere, false);
  assert.equal(options!.blocked, 'rom-missing');
});

test('a ROM this device cannot read blocks the launch and says so', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    // Personne dans la room pour l envoyer : c est ce qui rend l absence
    // bloquante, plutot que le fait de ne pas avoir le fichier.
    room: null,
    me: 'me',
    openable: new Set<string>()
  });

  assert.equal(options!.romHere, false);
  assert.equal(options!.blocked, 'rom-missing', 'silence here is a black screen in the headset');
});

test('a room already playing blocks the launch', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ status: 'playing' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'already-playing');
});

test('a group with nobody seated blocks the launch, mirroring the server', () => {
  // `game:start` refuses when no player has a port and is ready. Offering the
  // button anyway would earn an error nothing in here displays.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: true }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'no-seat');
});

test('solo needs no seat', () => {
  // There is no port to pick alone, so the server's seating rule cannot apply.
  const options = launchOptions({
    ...NAMING,
    library: library(), crc32: 'aaaa1111', room: null, me: 'me', openable: OPENABLE
  });
  assert.equal(options!.blocked, null);
});

test('a missing ROM outranks a missing seat', () => {
  // The player can do something about a seat from in here. They cannot do
  // anything about a ROM that is not on the device and that nobody can send,
  // so that is what to say. Bob is offline: were he there the game would be on
  // its way and the seat would be the only thing left to fix.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: null, isReady: false, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: false }
      ]
    }),
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options!.blocked, 'rom-missing');
});

test('a friend who has gone away blocks the launch, mirroring the server', () => {
  /*
   * `game:start` refuses when a seated player - port taken, ready - is not
   * online: a closed tab keeps both, so the room would otherwise show
   * "Ready" and a live Launch button that earns an `error` nothing in a
   * headset draws.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
        { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: false }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'friend-away');
});

test('an away friend who never took a seat does not block the launch', () => {
  /*
   * Mirroring the server exactly rather than approximating it: `game:start`
   * only inspects players who are seated - port and ready - never every
   * player in the room. An away friend with no seat was never who the game
   * was waiting on, so a version of this rule that reads "any offline
   * player blocks" would fail this where the real guard does not.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
        { userId: 'you', pseudo: 'Bob', port: null, isReady: false, online: false }
      ]
    }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, null);
});

test('a missing ROM outranks an away friend', () => {
  // Same ranking as the missing seat above: nothing in here fixes a ROM
  // that is not on the device, so that is the reason to lead with.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      players: [
        { userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true },
        { userId: 'you', pseudo: 'Bob', port: 2, isReady: true, online: false }
      ]
    }),
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options!.blocked, 'rom-missing');
});

test('a room that no longer holds this game refuses the launch', async () => {
  /*
   * A friend releasing the game clears `gameCrc32` and returns the room to
   * `waiting`, and `game:stopped` reaches the headset before the room's own
   * update does - so the launch screen reopens for a game the room is about
   * to stop carrying. Every other guard then passes: two players, both
   * seated, both online, status `waiting`. The button existed, and
   * `game:start` refused it with an `error` nothing in a headset draws.
   */
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ gameCrc32: 'bbbb2222' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.blocked, 'game-changed');
});

test('a room holding no game at all does not refuse a solo-shaped launch', async () => {
  // `gameCrc32` undefined is the ordinary state of a group that has not
  // chosen yet; only a DIFFERENT game is a refusal.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ gameCrc32: undefined }),
    me: 'me',
    openable: OPENABLE
  });
  assert.notEqual(options!.blocked, 'game-changed');
});

/*
 * The three tests below are the headset catching up with the flat page.
 *
 * `drawRow` printed `save.name` raw, which is not what a save is called: the
 * quick save is stored under the sentinel `__quick__` (`saves/quick.ts:18`),
 * chosen precisely so that no player could ever type it, and an ordinary save
 * is named by `autoSaveName` - a date string that says nothing extra once the
 * moment is printed beside it. `saveIdentity` is what the flat grid has always
 * used to turn one into the other, and reusing it rather than writing a second
 * one is the whole point: two implementations of "what is this save called"
 * would drift apart the first time either changed.
 */

test('the quick save is named, never shown under its sentinel', () => {
  const options = launchOptions({
    ...NAMING,
    library: library({ saves: [{ ...SAVE, id: 'q', name: QUICK_SAVE_NAME }] }),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  const row = options!.saves.find((s) => s.id === 'q');
  assert.ok(row, 'the quick save vanished from the list');
  assert.equal(row.primary, QUICK_LABEL);
  assert.ok(
    !JSON.stringify(options!.saves).includes(QUICK_SAVE_NAME),
    'an internal sentinel reached the screen'
  );
});

test('an auto-named save prints its moment once, not twice', () => {
  // `autoSaveName` builds the name out of the date, so name and date are the
  // same fact. The flat tile drops the second line; so must this one.
  const created = new Date('2026-09-04T21:07:00.000Z');
  const options = launchOptions({
    ...NAMING,
    library: library({
      saves: [
        {
          ...SAVE,
          id: 'auto',
          name: autoSaveName(LOCALE, created),
          createdAt: created.toISOString(),
          updatedAt: created.toISOString()
        }
      ]
    }),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  const row = options!.saves.find((s) => s.id === 'auto');
  assert.ok(row, 'the auto-named save vanished from the list');
  assert.equal(row.secondary, null, 'the date was printed twice');
});

test('a named save keeps its name and gains the moment underneath', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  const row = options!.saves[0];
  assert.equal(row.primary, 'Before the boss');
  assert.ok(row.secondary, 'a save the player named says nothing about when it was taken');
});

/*
 * The cap is five, and which five was never decided.
 *
 * `options.saves.slice(0, 5)` took the first five in store order - the order
 * `/api/games`' SQL happened to return, which is neither newest nor oldest.
 * With six saves the headset therefore hid an arbitrary one, while the flat
 * grid (`byNewest`, `saves/api.ts:85`) showed them most recent first. A cap is
 * defensible; an arbitrary cap is not.
 */
test('the list is ordered newest first, so the cap drops the oldest', () => {
  const at = (day: number) => `2026-09-0${day}T12:00:00.000Z`;
  const options = launchOptions({
    ...NAMING,
    library: library({
      saves: [3, 1, 5, 2, 4].map((day) => ({
        ...SAVE,
        id: `d${day}`,
        name: `Day ${day}`,
        createdAt: at(day),
        updatedAt: at(day)
      }))
    }),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  assert.deepEqual(
    options!.saves.map((s) => s.id),
    ['d5', 'd4', 'd3', 'd2', 'd1'],
    'the screen showed them in whatever order the store held'
  );
});

test('a save carries its thumbnail through to the screen', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  assert.equal(options!.saves[0].screenshot, SAVE.screenshot);
});

test('the game carries its id, which is how a cover is found', () => {
  // `VrShell` keys its `covers` map by game id, so an id that stops here is a
  // jaquette that can never be drawn - the placeholder rectangle this screen
  // shipped with.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: OPENABLE
  });

  assert.equal(options!.game.id, 'mine');
});


/*
 * Un ROM absent n'est plus fatal quand quelqu'un peut l'envoyer.
 *
 * Rapporte depuis deux casques : « il n'avait pas le jeu. le jeu ne se
 * lancait pas, et lui avait une erreur disant de lancer le jeu hors VR. on a
 * donc du faire une partie a deux hors VR avant. »
 *
 * Le serveur relaie `rom:request` depuis toujours et la page plate s'en sert :
 * un invite sans cartouche la recoit de l'hote, verifiee contre le CRC32 de la
 * room. La VR etait la seule room a ne jamais l'avoir appris, et ce module
 * disait meme que le ROM manquant est « le seul [blocage] qu'ils ne peuvent
 * pas resoudre depuis le casque ». Ce n'est plus vrai, et c'est ici que ca se
 * decide - pas dans le panneau, qui ne fait que dessiner.
 *
 * L'invite peut recevoir ; l'HOTE, non. Le serveur route `rom:request` vers le
 * socket de l'hote, donc un hote sans cartouche n'a personne a qui demander.
 */
test('un invite sans le ROM peut lancer : l hote va le lui envoyer', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ hostId: 'you' }),
    me: 'me',
    openable: new Set<string>()
  });

  assert.equal(options!.romHere, false, 'le ROM n est pas la, et ca reste vrai');
  assert.equal(options!.romIncoming, true, 'et il va arriver');
  assert.equal(options!.blocked, null, 'donc plus rien ne bloque le lancement');
});

test('un hote sans le ROM le recoit de l autre joueur', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ hostId: 'me' }),
    me: 'me',
    openable: new Set<string>()
  });
  // Etre hote ne veut pas dire tenir la cartouche : la fiche est sur le
  // serveur, les octets sont sur un appareil. Un hote qui joue depuis une
  // deuxieme machine n avait personne a qui demander, et c est exactement ce
  // que la prod a montre le 2026-09-09.
  assert.equal(options!.romIncoming, true);
  assert.equal(options!.blocked, null);
});

test('seul dans sa room, personne n envoie rien', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({
      hostId: 'you',
      players: [{ userId: 'me', pseudo: 'Ada', port: 1, isReady: true, online: true }]
    }),
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options!.romIncoming, false, 'une room a un joueur n est pas un groupe');
  assert.equal(options!.blocked, 'rom-missing');
});

test('en solo, un ROM absent bloque toujours', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: null,
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options!.romIncoming, false);
  assert.equal(options!.blocked, 'rom-missing');
});

test('rien n arrive quand le ROM est deja la', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ hostId: 'you' }),
    me: 'me',
    openable: OPENABLE
  });
  assert.equal(options!.romHere, true);
  assert.equal(options!.romIncoming, false, 'annoncer un transfert qui n aura pas lieu');
});

/*
 * Le jeu de la room, pour un dump qui n'est dans aucune bibliotheque.
 *
 * C'est l'autre moitie de la meme soiree, et la plus deroutante : sans entree
 * de bibliotheque ce module rendait `null`, et `VrShell` remettait alors le
 * DAMIER DE TEST. L'invite n'a donc eu aucun ecran de lancement - ni titre, ni
 * jaquette, ni port, ni bouton - puis une phrase rouge sur le pupitre de
 * gauche, a soixante degres de son regard, quand l'hote a lance.
 *
 * La room porte deja le titre, la jaquette et le CRC32. Il n'y a aucune raison
 * de ne rien dessiner.
 */
test('un dump absent de la bibliotheque se dessine depuis la room', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'ffff9999',
    room: room({ hostId: 'you', gameCrc32: 'ffff9999' }),
    me: 'me',
    openable: new Set<string>(),
    roomGame: { title: 'Super Metroid', coverUrl: 'https://example.test/cover.png' }
  });

  assert.ok(options, 'la room dit tout ce qu il faut pour dessiner un ecran');
  assert.equal(options.game.title, 'Super Metroid');
  assert.equal(options.game.crc32, 'ffff9999');
  assert.equal(options.game.coverUrl, 'https://example.test/cover.png');
  // Les sauvegardes appartiennent au proprietaire du jeu, donc l invite n en a
  // aucune : une liste vide, pas celles d un autre dump.
  assert.deepEqual(options.saves, []);
  assert.equal(options.romIncoming, true);
  assert.equal(options.blocked, null);
});

test('l entree de bibliotheque gagne contre le jeu de la room', () => {
  // Sinon un joueur qui POSSEDE le jeu perdrait ses sauvegardes de l ecran
  // parce que la room porte le titre choisi par l autre.
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'aaaa1111',
    room: room({ hostId: 'you' }),
    me: 'me',
    openable: OPENABLE,
    roomGame: { title: 'Un autre titre' }
  });
  assert.equal(options!.game.title, 'Super Mario World');
  assert.equal(options!.saves.length, 1);
});

test('sans entree ET sans jeu de room, il n y a toujours rien a dessiner', () => {
  const options = launchOptions({
    ...NAMING,
    library: library(),
    crc32: 'ffff9999',
    room: room({ hostId: 'you', gameCrc32: 'ffff9999' }),
    me: 'me',
    openable: new Set<string>()
  });
  assert.equal(options, null);
});

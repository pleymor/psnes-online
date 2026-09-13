/**
 * Le centre de notifications : ce qui se pose, ce qui se lit, ce qui s efface.
 *
 * Tout ici est pur ou prend son stockage, pour la raison que `transfer.ts`
 * donne pour les siens : ce depot teste sous Bun, sans navigateur. Les
 * boutons, eux, ont besoin de la socket - ils sont enregistres a l execution
 * et n apparaissent donc pas dans ce fichier.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { NOTICE_SHAPES, shapeOf } from '../../frontend/src/lib/notices/shapes.js';

test('un kind inconnu n a pas de forme', () => {
	assert.equal(shapeOf('rien-de-tel'), null);
});

test('le kind brut rend le message qu on lui a donne', () => {
	const shape = shapeOf('raw');

	assert.ok(shape);
	assert.equal(shape.text({ message: 'Sauvegarde creee' }, 'fr'), 'Sauvegarde creee');
	assert.equal(shape.tone, 'info');
});

test('chaque kind rend un texte non vide dans les deux langues', () => {
	// La garde que `i18n-parity` ne peut pas donner : elle compare les cles
	// des deux locales, pas les kinds qui les utilisent. Un kind ajoute avec
	// une cle oubliee compile et rend une chaine vide a l ecran.
	const params = { message: 'x', name: 'Bob', title: 'Umihara Kawase', count: 2 };

	for (const kind of Object.keys(NOTICE_SHAPES)) {
		for (const lang of ['en', 'fr'] as const) {
			const text = shapeOf(kind)?.text(params, lang) ?? '';
			assert.notEqual(text.trim(), '', `${kind} n a pas de texte en ${lang}`);
		}
	}
});

import { get } from 'svelte/store';
import { createNotices } from '../../frontend/src/lib/notices/store.js';

test('poser une notification la met dans la liste et dans le compte', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'Sauvegarde creee' });

	assert.equal(get(notices.list).length, 1);
	assert.equal(get(notices.count), 1);
});

test('la plus recente vient en dernier', () => {
	const notices = createNotices();

	notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['un', 'deux']
	);
});

test('fermer le centre consomme ce qui n a pas de bouton', () => {
	// Et non l ouvrir : videes a l ouverture, elles s effaceraient sous les
	// yeux de qui vient les lire.
	const notices = createNotices();
	notices.post('raw', { message: 'un' });

	notices.openCentre();
	assert.equal(get(notices.list).length, 1, 'la liste doit tenir pendant la lecture');

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('ce qui arrive pendant la lecture s ajoute, puis s en va avec le reste', () => {
	const notices = createNotices();
	notices.openCentre();

	notices.post('raw', { message: 'pendant' });
	assert.equal(get(notices.list).length, 1);

	notices.closeCentre();
	assert.equal(get(notices.list).length, 0);
});

test('une echeance depassee quitte la liste', () => {
	const notices = createNotices();
	notices.post('raw', { message: 'dix minutes' }, { expiresAt: 1_000 });

	notices.sweep(1_001);

	assert.equal(get(notices.list).length, 0);
});

test('retirer par identifiant ne touche pas les autres', () => {
	const notices = createNotices();
	const id = notices.post('raw', { message: 'un' });
	notices.post('raw', { message: 'deux' });

	notices.dismiss(id);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['deux']
	);
});

test('fermer le centre laisse ce qui porte des boutons', () => {
	// closeCentre() doit à la fois consommer ce qui n'en a pas ET laisser ce qui en a.
	const notices = createNotices({ hasActions: (kind) => kind === 'avec-boutons' });
	notices.post('raw', { message: 'a lire' });
	notices.post('avec-boutons', { message: 'a repondre' });

	notices.openCentre();
	notices.closeCentre();

	assert.deepEqual(
		get(notices.list).map((n) => n.kind),
		['avec-boutons']
	);
});

test('une notification sans echeance survit au sweep', () => {
	// sweep() doit retirer ce qui a passé expiresAt, mais garder ce qui n'en a pas.
	const notices = createNotices();
	notices.post('raw', { message: 'sans echeance' });
	notices.post('raw', { message: 'expiree' }, { expiresAt: 1_000 });

	notices.sweep(1_001);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['sans echeance']
	);
});

import {
	NOTICES_KEY,
	readNotices,
	writeNotices
} from '../../frontend/src/lib/notices/persist.js';

/** Un stockage de test, sans navigateur. */
function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key)
	};
}

const RAW = { id: 'a', kind: 'raw', params: { message: 'un' }, at: 10 };

test('ce qui est ecrit se relit', () => {
	const storage = fakeStorage();

	writeNotices(storage, [RAW]);

	assert.deepEqual(readNotices(storage, 100), [RAW]);
});

test('une echeance depassee ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, expiresAt: 50 }]);

	assert.deepEqual(readNotices(storage, 51), []);
});

test('un kind qui depend d une session vivante ne ressort pas', () => {
	// La socket est morte avec l onglet : la reposer, c est offrir un bouton
	// qui ne peut plus rien declencher.
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'share-offer' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un kind que cette version ne connait plus ne ressort pas', () => {
	const storage = fakeStorage();
	writeNotices(storage, [{ ...RAW, kind: 'ce-kind-a-ete-supprime' }]);

	assert.deepEqual(readNotices(storage, 100), []);
});

test('un stockage illisible rend une liste vide et s efface', () => {
	const storage = fakeStorage({ [NOTICES_KEY]: '{ pas du json' });

	assert.deepEqual(readNotices(storage, 100), []);
	assert.equal(storage.data.has(NOTICES_KEY), false);
});

test('ecrire une liste vide efface l entree', () => {
	const storage = fakeStorage();
	writeNotices(storage, [RAW]);

	writeNotices(storage, []);

	assert.equal(storage.data.has(NOTICES_KEY), false);
});

import {
	actionsOf,
	hasActions,
	registerNoticeActions
} from '../../frontend/src/lib/notices/actions.js';

test('un kind sans boutons enregistres n en a pas', () => {
	assert.equal(hasActions('raw'), false);
	assert.deepEqual(actionsOf('raw'), []);
});

test('des boutons enregistres se retrouvent par leur kind', () => {
	const run = () => {};
	registerNoticeActions('essai', [{ label: 'cancel', run }]);

	assert.equal(hasActions('essai'), true);
	assert.equal(actionsOf('essai').length, 1);

	// La table est un module partage par tout le processus bun : sans ce
	// nettoyage, le kind 'essai' fuit dans les autres fichiers de test qui
	// tournent dans le meme processus.
	registerNoticeActions('essai', []);
});

test('un abonnement pose apres hydrate() voit la liste hydratee, jamais une liste vide d abord', () => {
	// C'est la regle que `services/notification.ts` doit respecter pour ne pas
	// effacer le stockage : hydrater avant de s'abonner, jamais l'inverse. Un
	// `writable` de Svelte tire son abonne immediatement, avec la valeur
	// courante - s'abonner avant `hydrate()` verrait donc une liste vide en
	// premier, et l'ecrire suffirait a vider ce que le stockage tenait.
	const notices = createNotices();
	notices.hydrate([{ id: 'a', kind: 'raw', params: { message: 'un' }, at: 10 }]);

	const seen: unknown[][] = [];
	notices.list.subscribe((list) => seen.push(list));

	assert.equal(seen.length, 1);
	assert.equal(seen[0].length, 1);
});

test('hydrater n efface pas ce qui est deja dans la liste', () => {
	const notices = createNotices();
	notices.post('raw', { message: 'deja la' });

	notices.hydrate([{ id: 'b', kind: 'raw', params: { message: 'reapporte' }, at: 5 }]);

	assert.deepEqual(
		get(notices.list).map((n) => n.params.message),
		['deja la', 'reapporte']
	);
});

import { startNoticeSession } from '../../frontend/src/lib/notices/session.js';

test('la session lit le stockage avant d y ecrire', () => {
	// La regression exacte : abonne avant d hydrater, le writable tire
	// immediatement avec une liste vide et efface la cle avant la lecture.
	// Seul l ORDRE des appels le montre - l etat final, lui, se ressemble.
	const journal: string[] = [];
	const storage = {
		getItem: (key: string) => {
			journal.push(`lu ${key}`);
			return null;
		},
		setItem: (key: string) => void journal.push(`ecrit ${key}`),
		removeItem: (key: string) => void journal.push(`efface ${key}`)
	};

	startNoticeSession(createNotices(), storage, 0);

	assert.equal(journal[0], `lu ${NOTICES_KEY}`, `ordre obtenu : ${journal.join(' -> ')}`);
});

test('ce qui est relu du stockage se retrouve dans la liste', () => {
	const storage = fakeStorage();
	writeNotices(storage, [RAW]);

	const notices = createNotices();
	startNoticeSession(notices, storage, 100);

	assert.deepEqual(get(notices.list), [RAW]);
});

test('une notification postee apres le demarrage est ecrite', () => {
	const storage = fakeStorage();
	const notices = createNotices();
	startNoticeSession(notices, storage, 0);

	notices.post('raw', { message: 'nouvelle' });

	const stored = JSON.parse(storage.getItem(NOTICES_KEY) ?? '[]');
	assert.equal(stored.length, 1);
	assert.equal(stored[0].params.message, 'nouvelle');
});

test('la fonction d arret rendue coupe reellement l ecriture', () => {
	const storage = fakeStorage();
	const notices = createNotices();
	const stop = startNoticeSession(notices, storage, 0);

	notices.post('raw', { message: 'avant arret' });
	stop();
	notices.post('raw', { message: 'apres arret' });

	const stored = JSON.parse(storage.getItem(NOTICES_KEY) ?? '[]');
	assert.equal(stored.length, 1);
	assert.equal(stored[0].params.message, 'avant arret');
});

import { screenSeconds } from '../../frontend/src/lib/notices/shapes.js';

const AT = { id: 'x', params: {}, at: 0 };

test('sans rien de dit, une notification tient six secondes a l ecran', () => {
	assert.equal(screenSeconds({ ...AT, kind: 'raw' }), 6);
});

test('la duree passee a show l emporte sur la valeur par defaut', () => {
	assert.equal(screenSeconds({ ...AT, kind: 'raw', params: { seconds: 5 } }), 5);
});

test('un kind qui se repond ne s efface pas tout seul', () => {
	// `keep-rom` arrive a la tache 7 ; jusque-la un kind inconnu tombe sur la
	// valeur par defaut, ce que le premier test dit deja.
	assert.equal(screenSeconds({ ...AT, kind: 'raw', params: { seconds: 0 } }), 0);
});

test('l invitation se nomme par celui qui invite et par le jeu', () => {
	const shape = shapeOf('invitation');

	assert.ok(shape);
	assert.match(shape.text({ name: 'Bob', title: 'Umihara Kawase' }, 'fr'), /Bob/);
	assert.equal(shape.duringGame ?? false, false, 'une invitation ne coupe pas une partie');
});

test('l offre de jeu depend d une session vivante', () => {
	assert.equal(shapeOf('share-offer')?.live, true);
});

/*
 * Plus de question du conservage, decide le 13/09/2026.
 *
 * Un ROM recu ne reste plus jamais sur l appareil de l invite - c est le
 * comportement de l ancien « Non merci », devenu le seul - donc il n y a plus
 * rien a lui demander, ni pendant une partie ni ailleurs.
 *
 * La MECANIQUE `duringGame` reste dans NoticeToast, elle : `keep-rom` en etait
 * le seul client, mais la surface vient d etre construite et la prochaine
 * notification qui doit tenir en plein ecran la voudra. Ce qui part est la
 * question, pas le moyen de poser une question.
 */
test('la question du conservage n est plus une notification connue', () => {
	assert.equal(shapeOf('keep-rom'), null);
});

import { toneOf } from '../../frontend/src/lib/notices/shapes.js';

test('un ton pose dans les params l emporte sur celui de la forme', () => {
	// `raw` fige le sien a 'info' ; un appelant qui poste 'error' doit quand
	// meme s afficher en 'error'.
	assert.equal(toneOf({ kind: 'raw', params: { tone: 'error' } }), 'error');
});

test('sans ton dans les params, celui de la forme s applique', () => {
	assert.equal(toneOf({ kind: 'raw', params: {} }), 'info');
});

test('un ton invalide dans les params est ignore, pas affiche tel quel', () => {
	assert.equal(toneOf({ kind: 'raw', params: { tone: 'n importe quoi' } }), 'info');
});

test('un kind inconnu sans ton dans les params rend info', () => {
	assert.equal(toneOf({ kind: 'rien-de-tel', params: {} }), 'info');
});

test('chaque offre porte SA regle, et ce ne sont pas les memes', () => {
	// Les deux cartes d offre affichaient une mention legale avant de perdre
	// leur rendu propre, et ce test a d abord affirme qu elles portaient LA
	// MEME - ce qui n etait vrai que par accident de restauration.
	//
	// Recevoir une copie est une REDISTRIBUTION : posseder la cartouche n y
	// autorise personne, seule la licence du jeu le fait. La garder ensuite est
	// de la DETENTION, ou la cartouche est justement ce qui compte. Deux
	// moments, deux regles, et les confondre avertit de travers.
	//
	// `keep-rom` portait l autre des deux, et a disparu le 13/09/2026 ; la
	// distinction reste ecrite ici parce que c est elle qui explique pourquoi
	// `shareLegalShort` ne dit pas « si tu possedes la cartouche ».
	assert.equal(shapeOf('share-offer')?.legal, 'shareLegalShort');
});

import { isOnScreen } from '../../frontend/src/lib/notices/shapes.js';

test('dans son temps d ecran, une notification y est encore', () => {
	assert.equal(isOnScreen({ kind: 'raw', params: {}, at: 0 }, 3_000), true);
});

test('hors de son temps d ecran, elle n y est plus', () => {
	// Six secondes par defaut : a sept secondes, c est fini.
	assert.equal(isOnScreen({ kind: 'raw', params: {}, at: 0 }, 7_000), false);
});

test('seconds: 0 reste toujours a l ecran', () => {
	assert.equal(isOnScreen({ kind: 'raw', params: { seconds: 0 }, at: 0 }, 1_000_000), true);
});

test('sweep purge par l age, meme sans echeance posee', () => {
	// Le plafond nomme dans store.ts : un jour.
	const notices = createNotices({ now: () => 0 });
	notices.post('raw', { message: 'vieille' });

	notices.sweep(24 * 60 * 60 * 1000 + 1);

	assert.equal(get(notices.list).length, 0);
});

test('une notification dans le plafond d age survit au sweep', () => {
	const notices = createNotices({ now: () => 0 });
	notices.post('raw', { message: 'fraiche' });

	notices.sweep(24 * 60 * 60 * 1000 - 1);

	assert.equal(get(notices.list).length, 1);
});

test('sweep borne le nombre de notifications retenues, en gardant les plus recentes', () => {
	const notices = createNotices({ now: () => 0 });
	for (let i = 0; i < 60; i++) {
		notices.post('raw', { message: `n${i}` });
	}

	notices.sweep(0);

	const list = get(notices.list);
	assert.equal(list.length, 50);
	assert.equal(list[0].params.message, 'n10');
	assert.equal(list[list.length - 1].params.message, 'n59');
});

import { writable } from 'svelte/store';
import { waitFor } from '../../frontend/src/lib/notices/wait-for.js';

test('waitFor se resout tout de suite si le predicat est deja vrai', async () => {
	const store = writable(1);
	const start = Date.now();

	await waitFor(store, (v) => v === 1, 1_000);

	assert.ok(Date.now() - start < 200, 'ne doit pas attendre le delai de garde');
});

test('waitFor se resout quand le store finit par satisfaire le predicat', async () => {
	const store = writable<string | null>('en-vol');
	const seen: (string | null)[] = [];

	const done = waitFor(store, (v) => v === null, 1_000).then(() => seen.push('resolu'));

	assert.deepEqual(seen, [], 'pas encore resolu avant le changement');
	store.set(null);
	await done;

	assert.deepEqual(seen, ['resolu']);
});

test('waitFor rend la main par le delai de garde si la reponse ne vient jamais', async () => {
	const store = writable<string | null>('en-vol');
	const start = Date.now();

	await waitFor(store, (v) => v === null, 20);

	assert.ok(Date.now() - start < 500, 'le delai de garde doit ecourter l attente');
});

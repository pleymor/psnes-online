/**
 * Ce que la page d'un salon propose à quelqu'un qui n'a pas de compte, et ce
 * qu'elle cesse de proposer à quelqu'un qui en a un.
 *
 * Deux décisions, toutes deux invisiblement fausses si on se trompe. La
 * première : un lien de salon ouvert sans session doit offrir une porte
 * plutôt que renvoyer vers Google - c'est l'objet même de la fonctionnalité, et
 * la seule façon de s'en apercevoir est d'ouvrir le lien en navigation privée.
 * La seconde : un joueur anonyme ne doit pas se voir offrir une bibliothèque,
 * des amis, un profil ou une sauvegarde. Le serveur refuse tout cela en 403,
 * donc s'en remettre à lui ne casse rien - cela offre simplement des boutons
 * qui échouent, ce qui se lit comme une panne.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anonymousJoinState,
  anonymousDoorMessage,
  accountFeaturesAllowed
} from '../../frontend/src/lib/rooms/anonymous-join.js';

const ROOM = 'room-1';

test('tant que la session est en cours de lecture, on ne propose rien', () => {
  // Le pire moment pour proposer une porte sans compte est celui où on ne sait
  // pas encore s'il y en a un : l'offre clignoterait devant un joueur connecté
  // à chaque chargement de page.
  const state = anonymousJoinState({ user: null, loading: true, enabled: true, roomId: ROOM });

  assert.deepEqual(state, { kind: 'waiting' });
});

test('un joueur déjà connecté ne voit pas la porte, anonyme ou non', () => {
  const account = anonymousJoinState({
    user: { isAnonymous: false }, loading: false, enabled: true, roomId: ROOM
  });
  const anon = anonymousJoinState({
    user: { isAnonymous: true }, loading: false, enabled: true, roomId: ROOM
  });

  assert.deepEqual(account, { kind: 'joined' });
  assert.deepEqual(anon, { kind: 'joined' });
});

test('sans session, la porte est proposée pour ce salon-là', () => {
  const state = anonymousJoinState({ user: null, loading: false, enabled: true, roomId: ROOM });

  assert.deepEqual(state, { kind: 'offer', roomId: ROOM });
});

test('déploiement sans porte anonyme : la connexion reste le seul chemin', () => {
  const state = anonymousJoinState({ user: null, loading: false, enabled: false, roomId: ROOM });

  assert.deepEqual(state, { kind: 'signInOnly' });
});

test('un salon sans identifiant n ouvre aucune porte', () => {
  const state = anonymousJoinState({ user: null, loading: false, enabled: true, roomId: '' });

  assert.deepEqual(state, { kind: 'signInOnly' });
});

// ------------------------------------------------------- les refus du serveur

test('chaque refus de la porte a son message, et l inconnu en a un aussi', () => {
  assert.equal(anonymousDoorMessage(404, 'ROOM_NOT_FOUND'), 'anonymousRoomGone');
  assert.equal(anonymousDoorMessage(409, 'ALREADY_SIGNED_IN'), 'anonymousAlreadySignedIn');
  assert.equal(anonymousDoorMessage(400, 'PSEUDO_INVALID'), 'pseudoInvalid');
  assert.equal(anonymousDoorMessage(429, 'TOO_MANY_ATTEMPTS'), 'anonymousTooManyAttempts');
  assert.equal(anonymousDoorMessage(403, 'ANONYMOUS_DISABLED'), 'anonymousDisabled');
  // Un code que ce client ne connaît pas ne doit pas laisser l écran muet.
  assert.equal(anonymousDoorMessage(500, 'BOOM'), 'anonymousJoinFailed');
});

test('« salon plein » et « salon inexistant » arrivent ici comme la même chose', () => {
  // Le serveur répond la même chose aux deux exprès, pour ne pas confirmer
  // l existence d un salon à qui en tient l identifiant. Ce test est là pour
  // que personne ne « corrige » ce message en croyant qu il manque un cas.
  assert.equal(anonymousDoorMessage(404, 'ROOM_NOT_FOUND'), 'anonymousRoomGone');
});

// ------------------------------------------- ce qu un anonyme ne se voit pas

test('un anonyme ne se voit offrir ni bibliothèque, ni amis, ni profil, ni sauvegarde', () => {
  const allowed = accountFeaturesAllowed({ isAnonymous: true });

  assert.deepEqual(allowed, {
    library: false,
    friends: false,
    profile: false,
    saves: false,
    roomSetup: false
  });
});

test('un compte garde tout, et un visiteur sans session n a rien à offrir', () => {
  assert.deepEqual(accountFeaturesAllowed({ isAnonymous: false }), {
    library: true,
    friends: true,
    profile: true,
    saves: true,
    roomSetup: true
  });
  // Pas de session : les mêmes réponses que pour un anonyme. Rien de tout cela
  // n a de sens sans compte, et un `null` qui répondrait « oui » monterait des
  // écrans que la première requête refuserait.
  assert.deepEqual(accountFeaturesAllowed(null), {
    library: false,
    friends: false,
    profile: false,
    saves: false,
    roomSetup: false
  });
});

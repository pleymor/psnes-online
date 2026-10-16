/**
 * Le formulaire d'inscription, décidé sans serveur.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { looksLikeEmail, passwordAuthEnabled, signupFormDecision } from '../src/auth/credentials-door.js';

const OK = { enabled: true, email: 'bob@example.fr', password: '0123456789', emailTaken: false };

test('la porte est ouverte par défaut et se referme sans toucher à AUTH_MODE', () => {
  assert.equal(passwordAuthEnabled({}), true);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'off' }), false);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'OFF' }), false);
  assert.equal(passwordAuthEnabled({ PASSWORD_AUTH: 'on' }), true);
  // AUTH_MODE n'y est pour rien, dans un sens comme dans l'autre.
  assert.equal(passwordAuthEnabled({ AUTH_MODE: 'google' }), true);
  assert.equal(passwordAuthEnabled({ AUTH_MODE: 'dev', PASSWORD_AUTH: 'off' }), false);
});

test('en production, la porte reste fermée tant qu\'aucun SMTP n\'est configuré', () => {
  // Sans SMTP, le lien de réinitialisation finirait dans le journal au lieu
  // d'une boîte mail. Fermer la porte, et non refuser de démarrer : Google
  // continue de fonctionner pendant que les identifiants SMTP arrivent.
  assert.equal(passwordAuthEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(passwordAuthEnabled({ NODE_ENV: 'production', SMTP_URL: '' }), false);
  assert.equal(passwordAuthEnabled({ NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@h:465' }), true);
  assert.equal(
    passwordAuthEnabled({ NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@h:465', PASSWORD_AUTH: 'off' }),
    false
  );
  // Hors production, le repli qui journalise est ce qui rend tout testable.
  assert.equal(passwordAuthEnabled({ NODE_ENV: 'development' }), true);
});

test('un formulaire correct passe', () => {
  const decision = signupFormDecision(OK);
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.email, 'bob@example.fr');
});

test('la porte fermée refuse avant de lire quoi que ce soit', () => {
  const decision = signupFormDecision({ ...OK, enabled: false, email: 'n\'importe quoi' });
  assert.equal(!decision.ok && decision.error, 'PASSWORD_AUTH_DISABLED');
  assert.equal(!decision.ok && decision.status, 404);
});

test('une adresse doit ressembler à une adresse', () => {
  for (const bad of ['', 'bob', 'bob@', '@example.fr', 'bob example.fr', 'bob@exemple', 42, null]) {
    assert.equal(looksLikeEmail(bad), false, `${String(bad)} ne devrait pas passer`);
  }
  assert.equal(looksLikeEmail(`${'a'.repeat(250)}@x.fr`), false);
  assert.equal(looksLikeEmail('bob@example.fr'), true);
  assert.equal(looksLikeEmail('bob+psnes@sous.example.co.uk'), true);
});

test('un mot de passe trop court est refusé, et le dit', () => {
  const decision = signupFormDecision({ ...OK, password: '123456789' });
  assert.equal(!decision.ok && decision.error, 'PASSWORD_TOO_SHORT');
  assert.equal(!decision.ok && decision.status, 400);
});

test('un mot de passe qui n\'est pas une chaîne est refusé', () => {
  const decision = signupFormDecision({ ...OK, password: 1234567890 });
  assert.equal(!decision.ok && decision.error, 'PASSWORD_TOO_SHORT');
});

test('une adresse déjà prise est refusée — et c\'est un oracle assumé', () => {
  // Ce refus dit à qui détient une invitation qu'une adresse a déjà un compte
  // ici. C'est le prix d'un message utilisable : l'alternative -- accepter
  // silencieusement puis envoyer un mail « vous avez déjà un compte » --
  // consommerait l'invitation du filleul pour rien. La porte d'invitation
  // borne déjà qui peut poser la question.
  const decision = signupFormDecision({ ...OK, emailTaken: true });
  assert.equal(!decision.ok && decision.error, 'EMAIL_TAKEN');
  assert.equal(!decision.ok && decision.status, 409);
});

test('l\'adresse est refusée avant d\'être testée en base', () => {
  const decision = signupFormDecision({ ...OK, email: 'pas une adresse', emailTaken: true });
  assert.equal(!decision.ok && decision.error, 'EMAIL_MALFORMED');
});

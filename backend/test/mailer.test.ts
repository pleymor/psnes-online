/**
 * Le contenu des deux mails, et le repli qui les journalise.
 *
 * L'envoi lui-même n'est pas testé ici -- il n'y a rien à apprendre d'un
 * nodemailer mocké. Ce qui compte et se teste : que le lien soit dans le
 * corps, que la durée y soit dite, et que l'absence de SMTP ne fasse pas
 * échouer une inscription en développement, ni ne journalise un jeton en
 * production.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { passwordResetMail, sendMail, signupConfirmationMail, smtpConfigured } from '../src/services/mailer.js';

test('le mail de confirmation porte le lien et sa durée', () => {
  const mail = signupConfirmationMail('bob@example.fr', 'https://psnes.example/auth/signup/confirm?token=xyz');
  assert.equal(mail.to, 'bob@example.fr');
  assert.ok(mail.text.includes('https://psnes.example/auth/signup/confirm?token=xyz'));
  assert.match(mail.text, /24\s*h|vingt-quatre/i);
  assert.ok(mail.subject.length > 0);
});

test('le mail de réinitialisation porte le lien, sa durée, et le rappel « sinon, ignorez »', () => {
  const mail = passwordResetMail('bob@example.fr', 'https://psnes.example/reset?token=xyz');
  assert.ok(mail.text.includes('https://psnes.example/reset?token=xyz'));
  assert.match(mail.text, /1\s*h|une heure/i);
  // Quelqu'un qui n'a rien demandé doit lire quoi faire : rien.
  assert.match(mail.text, /ignor/i);
});

test('aucun mail ne contient de balise HTML', () => {
  // Texte brut, délibérément : un lien de récupération n'a pas besoin d'être
  // joli, et un mail texte passe mieux les filtres.
  for (const mail of [
    signupConfirmationMail('bob@example.fr', 'https://x/y'),
    passwordResetMail('bob@example.fr', 'https://x/y')
  ]) {
    assert.equal(/<[a-z]/i.test(mail.text), false);
  }
});

test('SMTP absent est un état reconnu, pas une panne', () => {
  assert.equal(smtpConfigured({}), false);
  assert.equal(smtpConfigured({ SMTP_URL: '' }), false);
  assert.equal(smtpConfigured({ SMTP_URL: 'smtps://u:p@host:465' }), true);
});

test('sans SMTP, hors production, le mail est journalisé et l\'envoi réussit', async () => {
  const saved = { smtp: process.env.SMTP_URL, env: process.env.NODE_ENV };
  delete process.env.SMTP_URL;
  process.env.NODE_ENV = 'test';
  try {
    await sendMail(signupConfirmationMail('bob@example.fr', 'https://x/y'));
  } finally {
    if (saved.smtp !== undefined) process.env.SMTP_URL = saved.smtp;
    process.env.NODE_ENV = saved.env;
  }
});

test('sans SMTP, en production, l\'envoi échoue plutôt que de journaliser un jeton', async () => {
  const saved = { smtp: process.env.SMTP_URL, env: process.env.NODE_ENV };
  delete process.env.SMTP_URL;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(sendMail(passwordResetMail('bob@example.fr', 'https://x/reset?token=secret')));
  } finally {
    if (saved.smtp !== undefined) process.env.SMTP_URL = saved.smtp;
    process.env.NODE_ENV = saved.env;
  }
});

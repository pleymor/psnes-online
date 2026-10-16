/**
 * La porte e-mail + mot de passe, par HTTP, sur une vraie base.
 *
 * Les routes sont montées dans une application Express qui écoute sur un port
 * libre, avec une vraie session (`MemoryStore`) et le vrai passport : c'est ce
 * qui permet de vérifier qu'une connexion pose bien une session, et qu'une
 * réinitialisation ferme celles des autres appareils. Seul le magasin change
 * par rapport à la production (Redis), et `destroySessionsOf` ne connaît que
 * l'interface `Store` commune aux deux.
 *
 * Chaque test parle depuis sa propre adresse (`X-Forwarded-For`, avec
 * `trust proxy`) : les limites de tentatives sont des singletons de module, et
 * sans cela les échecs d'un test fermeraient la porte au suivant.
 *
 * La transaction de confirmation a aussi ses tests directs (`confirmSignup`),
 * sans HTTP : c'est la partie qui doit tenir ou tomber d'un bloc.
 */

import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

// Sous le dossier de test et non dans le temp du système, qui est partagé.
const dir = mkdtempSync(join(import.meta.dirname, '.tmp-credentials-api-'));
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;
process.env.AUTH_MODE = 'dev';
process.env.FRONTEND_URL = 'http://front.test';
delete process.env.PASSWORD_AUTH;
delete process.env.SMTP_URL;

const { default: express } = await import('express');
const { default: session } = await import('express-session');
const { default: passport } = await import('passport');
const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { initializeAuth } = await import('../src/auth/passport.js');
const { authRouter } = await import('../src/api/auth.js');
const { credentialsRouter, confirmSignup } = await import('../src/api/credentials.js');
const { hashPassword, verifyPassword } = await import('../src/auth/password.js');
const { newToken } = await import('../src/auth/tokens.js');
const { mintInvite, findInviteByCode, revokeInvite } = await import('../src/db/signup-invites.js');
const { createPendingSignup, findLivePendingSignupByToken } = await import('../src/db/pending-signups.js');
const { createCredential, findCredentialByEmail } = await import('../src/db/credentials.js');
const { createPasswordReset } = await import('../src/db/password-resets.js');
const { createPasswordUser } = await import('../src/db/users.js');
const { insertUser } = await import('./helpers.js');

forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
initializeAuth();
app.use('/auth', credentialsRouter);
app.use('/auth', authRouter);
const server = app.listen(0);
await new Promise<void>(done => server.once('listening', () => done()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;

afterAll(() => {
  server.close();
  // `migrate` prépare ses requêtes avec `db.prepare` sans les finaliser ; tant
  // qu'elles vivent, SQLite garde le fichier ouvert après `close`, et Windows
  // refuse alors de supprimer le dossier. Les ramasser d'abord.
  Bun.gc(true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Un hash réel, calculé une fois : argon2 coûte.
const PASSWORD = 'correct horse battery';
const HASH = await hashPassword(PASSWORD);

let ipSerial = 1;
let mailSerial = 0;

/** Un visiteur : une adresse IP à lui, et un pot à cookie. */
function visitor() {
  const ip = `10.0.0.${ipSerial++}`;
  let cookie = '';
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...(cookie ? { cookie } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  }
  return {
    post: (path: string, body: unknown) => call('POST', path, body),
    get: (path: string) => call('GET', path),
    async me() {
      return (await call('GET', '/me')).json();
    }
  };
}

function freshEmail() {
  return `joueur${mailSerial++}@example.fr`;
}

function inviteFromSomeone() {
  const alice = insertUser(db);
  return mintInvite(db, alice.id);
}

/** Un compte à mot de passe déjà confirmé. */
function passwordAccount(email = freshEmail()) {
  const user = createPasswordUser(db);
  createCredential(db, user.id, email, HASH);
  return { user, email };
}

// ------------------------------------------------------------ confirmSignup

test('confirmer crée le compte, l\'identifiant, consomme le lien et efface l\'attente', () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();
  const { token, hash } = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: invite.id, tokenHash: hash });

  const result = confirmSignup(db, token);

  assert.equal(result.ok, true);
  const credential = findCredentialByEmail(db, email);
  assert.ok(credential);
  assert.equal(result.ok && result.user.id, credential!.userId);
  assert.equal(result.ok && result.user.googleId, null);
  assert.equal(findInviteByCode(db, invite.code)?.inviteeId, credential!.userId);
  assert.notEqual(findInviteByCode(db, invite.code)?.usedAt, null);
  assert.equal(findLivePendingSignupByToken(db, hash), null);
});

test('un jeton inconnu ne crée rien', () => {
  const result = confirmSignup(db, newToken().token);
  assert.equal(!result.ok && result.error, 'TOKEN_INVALID');
});

test('la porte est reconsultée à la confirmation, pas seulement au formulaire', () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();
  const { token, hash } = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: invite.id, tokenHash: hash });

  // La centième place part pendant que Bob lit ses mails.
  process.env.MAX_USERS = '1';
  try {
    const result = confirmSignup(db, token);
    assert.equal(!result.ok && result.error, 'PLATFORM_FULL');
    // Et rien n'a été écrit.
    assert.equal(findCredentialByEmail(db, email), null);
    assert.equal(findInviteByCode(db, invite.code)?.usedAt, null);
    assert.ok(findLivePendingSignupByToken(db, hash));
  } finally {
    delete process.env.MAX_USERS;
  }
});

test('une invitation révoquée pendant l\'attente refuse la confirmation', () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();
  const { token, hash } = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: invite.id, tokenHash: hash });

  revokeInvite(db, invite.id);

  const result = confirmSignup(db, token);
  assert.equal(!result.ok && result.error, 'INVITE_REVOKED');
  assert.equal(findCredentialByEmail(db, email), null);
});

test('une adresse confirmée entre-temps par une autre invitation est refusée, lisiblement', () => {
  const email = freshEmail();
  const first = newToken();
  const second = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: inviteFromSomeone().id, tokenHash: first.hash });
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: inviteFromSomeone().id, tokenHash: second.hash });

  assert.equal(confirmSignup(db, first.token).ok, true);
  const result = confirmSignup(db, second.token);
  assert.equal(!result.ok && result.error, 'EMAIL_TAKEN');
});

test('deux confirmations du même jeton ne font qu\'un compte', () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();
  const { token, hash } = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: invite.id, tokenHash: hash });

  const first = confirmSignup(db, token);
  const second = confirmSignup(db, token);

  assert.equal(first.ok, true);
  assert.equal(!second.ok && second.error, 'TOKEN_INVALID');
  const count = db.query(`SELECT COUNT(*) AS n FROM "Credential" WHERE email = ?`).get(email) as { n: number };
  assert.equal(count.n, 1);
});

// ------------------------------------------------------------ POST /signup

test('l\'inscription sans invitation est refusée', async () => {
  const res = await visitor().post('/signup', { email: freshEmail(), password: PASSWORD });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'INVITE_UNKNOWN');
});

test('l\'inscription refuse une adresse malformée, un mot de passe court, une adresse prise', async () => {
  const invite = inviteFromSomeone();
  const v = visitor();

  let res = await v.post('/signup', { code: invite.code, email: 'pas une adresse', password: PASSWORD });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'EMAIL_MALFORMED');

  res = await v.post('/signup', { code: invite.code, email: freshEmail(), password: '123456789' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'PASSWORD_TOO_SHORT');

  const { email } = passwordAccount();
  res = await v.post('/signup', { code: invite.code, email: email.toUpperCase(), password: PASSWORD });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'EMAIL_TAKEN');

  // Aucun de ces refus n'a retenu le lien.
  const pending = db.query(`SELECT COUNT(*) AS n FROM "PendingSignup" WHERE inviteId = ?`).get(invite.id) as { n: number };
  assert.equal(pending.n, 0);
});

test('l\'inscription acceptée ne crée aucun compte, et retient le lien', async () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();

  const res = await visitor().post('/signup', { code: invite.code, email, password: PASSWORD });
  assert.equal(res.status, 202);

  // Le mail est la vérification : pas de compte avant le clic.
  assert.equal(findCredentialByEmail(db, email), null);
  const row = db.query(`SELECT passwordHash FROM "PendingSignup" WHERE inviteId = ?`).get(invite.id) as { passwordHash: string };
  // Le mot de passe en attente est déjà haché.
  assert.match(row.passwordHash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(PASSWORD, row.passwordHash), true);

  // Un second visiteur sur le même lien trouve la place retenue.
  const second = await visitor().post('/signup', { code: invite.code, email: freshEmail(), password: PASSWORD });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'INVITE_HELD');
  // Et Google aussi : la retenue est dans la porte commune.
  const lookup = await visitor().get(`/invite/${invite.code}`);
  assert.equal((await lookup.json()).error, 'INVITE_HELD');
});

// ------------------------------------------------------ GET /signup/confirm

test('le clic dans le mail crée le compte, connecte, et ne sert qu\'une fois', async () => {
  const invite = inviteFromSomeone();
  const email = freshEmail();
  const { token, hash } = newToken();
  createPendingSignup(db, { email, passwordHash: HASH, inviteId: invite.id, tokenHash: hash });

  const v = visitor();
  const res = await v.get(`/signup/confirm?token=${token}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'http://front.test');

  const me = await v.me();
  assert.equal(me.id, findCredentialByEmail(db, email)!.userId);
  // Il passe par le portique d'embarquement, comme un compte Google.
  assert.equal(me.needsPseudo, true);

  const again = await visitor().get(`/signup/confirm?token=${token}`);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), 'http://front.test/signup?signupError=TOKEN_INVALID');
});

// ------------------------------------------------------------- POST /login

test('la connexion avec le bon mot de passe pose une session', async () => {
  const { user, email } = passwordAccount();
  const v = visitor();

  // La casse de l'adresse n'y change rien.
  const res = await v.post('/login', { email: email.toUpperCase(), password: PASSWORD });
  assert.equal(res.status, 200);
  const self = await res.json();
  assert.equal(self.id, user.id);
  // `toSelf` et rien d'autre : ni adresse, ni hash.
  assert.equal('email' in self, false);
  assert.equal('passwordHash' in self, false);

  assert.equal((await v.me()).id, user.id);
});

test('un mauvais mot de passe et une adresse inconnue reçoivent la même réponse', async () => {
  const { email } = passwordAccount();
  const v = visitor();

  const wrong = await v.post('/login', { email, password: 'pas le bon mot de passe' });
  const unknown = await v.post('/login', { email: freshEmail(), password: PASSWORD });
  const empty = await v.post('/login', {});

  for (const res of [wrong, unknown, empty]) {
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'BAD_CREDENTIALS' });
  }
  assert.equal(await v.me(), null);
});

test('un compte Google n\'a pas de mot de passe', async () => {
  // Une méthode par compte : rien ne relie un googleId à une adresse.
  const res = await visitor().post('/login', { email: 'google@example.fr', password: PASSWORD });
  assert.equal(res.status, 401);
});

test('dix échecs sur une adresse ferment la porte, même depuis une autre IP', async () => {
  const { email } = passwordAccount();
  for (let i = 0; i < 10; i++) {
    const res = await visitor().post('/login', { email, password: `mauvais-${i}-mot-de-passe` });
    assert.equal(res.status, 401);
  }
  const blocked = await visitor().post('/login', { email, password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'TOO_MANY_ATTEMPTS');
});

test('dix échecs depuis une IP ferment la porte à cette IP, pour toutes les adresses', async () => {
  const v = visitor();
  for (let i = 0; i < 10; i++) {
    await v.post('/login', { email: freshEmail(), password: PASSWORD });
  }
  const { email } = passwordAccount();
  const blocked = await v.post('/login', { email, password: PASSWORD });
  assert.equal(blocked.status, 429);
});

// ------------------------------------------------------------ POST /forgot

test('« mot de passe oublié » répond pareil, qu\'un compte existe ou non', async () => {
  const { user, email } = passwordAccount();

  const known = await visitor().post('/forgot', { email });
  const unknown = await visitor().post('/forgot', { email: freshEmail() });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());

  const resets = db.query(`SELECT COUNT(*) AS n FROM "PasswordReset" WHERE userId = ?`).get(user.id) as { n: number };
  assert.equal(resets.n, 1);
});

// ------------------------------------------------------------- POST /reset

test('la réinitialisation refuse un mot de passe court, puis un jeton inconnu', async () => {
  const v = visitor();

  const short = await v.post('/reset', { token: newToken().token, password: 'court' });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error, 'PASSWORD_TOO_SHORT');

  const unknown = await v.post('/reset', { token: newToken().token, password: 'un mot de passe neuf' });
  assert.equal(unknown.status, 410);
  assert.equal((await unknown.json()).error, 'TOKEN_INVALID');
});

test('réinitialiser change le mot de passe, ferme les autres sessions, et ne sert qu\'une fois', async () => {
  const { user, email } = passwordAccount();

  // Un appareil déjà connecté -- peut-être celui d'un intrus.
  const other = visitor();
  assert.equal((await other.post('/login', { email, password: PASSWORD })).status, 200);
  assert.equal((await other.me()).id, user.id);

  const { token, hash } = newToken();
  createPasswordReset(db, user.id, hash);

  const owner = visitor();
  const res = await owner.post('/reset', { token, password: 'un mot de passe neuf' });
  assert.equal(res.status, 200);
  assert.equal((await owner.me()).id, user.id);

  // L'autre appareil est déconnecté.
  assert.equal(await other.me(), null);

  // L'ancien mot de passe ne marche plus, le nouveau si.
  assert.equal((await visitor().post('/login', { email, password: PASSWORD })).status, 401);
  assert.equal((await visitor().post('/login', { email, password: 'un mot de passe neuf' })).status, 200);

  // Le même lien ne sert pas deux fois.
  const again = await visitor().post('/reset', { token, password: 'encore un autre mot de passe' });
  assert.equal(again.status, 410);
});

// ------------------------------------------------------- PASSWORD_AUTH=off

test('PASSWORD_AUTH=off ferme les quatre routes, et /auth/mode le dit', async () => {
  const { user, email } = passwordAccount();
  const invite = inviteFromSomeone();
  const v = visitor();

  assert.equal((await (await v.get('/mode')).json()).passwordAuth, true);

  process.env.PASSWORD_AUTH = 'off';
  try {
    assert.equal((await (await v.get('/mode')).json()).passwordAuth, false);
    assert.equal((await v.post('/login', { email, password: PASSWORD })).status, 404);
    assert.equal((await v.post('/signup', { code: invite.code, email: freshEmail(), password: PASSWORD })).status, 404);
    assert.equal((await v.post('/reset', { token: newToken().token, password: PASSWORD })).status, 404);

    // /forgot répond toujours 200 -- mais n'envoie rien.
    assert.equal((await v.post('/forgot', { email })).status, 200);
    const resets = db.query(`SELECT COUNT(*) AS n FROM "PasswordReset" WHERE userId = ?`).get(user.id) as { n: number };
    assert.equal(resets.n, 0);
  } finally {
    delete process.env.PASSWORD_AUTH;
  }
});

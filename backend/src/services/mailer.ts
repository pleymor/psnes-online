import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Mailer');

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export function smtpConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(env.SMTP_URL && env.SMTP_URL.length > 0);
}

/**
 * Texte brut, en français, et rien d'autre.
 *
 * Pas de gabarit HTML : un lien de récupération de compte n'a pas besoin
 * d'être joli, un mail texte passe mieux les filtres, et une seule version à
 * écrire est une seule version à maintenir juste.
 */
export function signupConfirmationMail(to: string, link: string): Mail {
  return {
    to,
    subject: 'Confirmez votre compte psnes',
    text: [
      'Bonjour,',
      '',
      'Quelqu\'un (vous, sans doute) a créé un compte psnes avec cette adresse.',
      'Ce lien le confirme et vous connecte :',
      '',
      link,
      '',
      'Il est valable 24 h. Passé ce délai, l\'invitation qui vous a été donnée',
      'retourne à la personne qui vous l\'avait offerte, et il faudra lui en',
      'redemander une.',
      '',
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message :',
      'aucun compte n\'a encore été créé.'
    ].join('\n')
  };
}

export function passwordResetMail(to: string, link: string): Mail {
  return {
    to,
    subject: 'Réinitialiser votre mot de passe psnes',
    text: [
      'Bonjour,',
      '',
      'Ce lien vous laisse choisir un nouveau mot de passe :',
      '',
      link,
      '',
      'Il est valable 1 h et ne sert qu\'une fois. L\'utiliser déconnectera',
      'toutes vos sessions ouvertes, sur tous vos appareils.',
      '',
      'Si vous n\'avez rien demandé, ignorez ce message : votre mot de passe',
      'actuel continue de fonctionner, et personne n\'a accès à votre compte.'
    ].join('\n')
  };
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL!);
  return transport;
}

/**
 * Envoie, ou journalise le lien quand aucun SMTP n'est configuré.
 *
 * Le repli n'est pas un confort : c'est ce qui rend les deux parcours
 * testables de bout en bout sans identifiants, et le mode développement
 * utilisable hors ligne.
 *
 * Jamais en production : `passwordAuthEnabled` y ferme la porte sans
 * `SMTP_URL`, donc aucune route ne devrait arriver ici. Si l'une y arrive
 * quand même, elle échoue plutôt que d'écrire un jeton de reprise de compte
 * dans le journal.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (!smtpConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_URL is not set: refusing to log a mail in production');
    }
    logger.warn(
      { to: mail.to, subject: mail.subject, body: mail.text },
      'Aucun SMTP configuré : le message est journalisé au lieu d\'être envoyé'
    );
    return;
  }
  await getTransport().sendMail({
    from: process.env.MAIL_FROM || 'psnes <no-reply@localhost>',
    to: mail.to,
    subject: mail.subject,
    text: mail.text
  });
}

/**
 * La page de documentation, dans les deux langues.
 *
 * Ici plutôt que dans `i18n/translations.ts` parce que le volume n'est pas
 * comparable : cette page est une soixantaine de phrases, et les noyer parmi
 * les libellés d'interface rendrait la table des traductions illisible pour
 * les deux usages. La structure - des sections, des paragraphes, des puces,
 * des liens - est aussi ce qui permet au test de vérifier la PARITÉ : une
 * section, une puce ou un lien qui n'existerait que dans une langue est un
 * trou, et sur une page qui parle de données personnelles et de droit, un trou
 * n'est pas cosmétique.
 *
 * Chaque affirmation sur le stockage vient du code et pas d'un souvenir :
 *
 * - « les ROMs ne touchent jamais le serveur » : `backend/src/api/games.ts` le
 *   dit dans son en-tête et n'expose aucune route de téléchargement ; la table
 *   `Game` ne porte ni octets ni chemin, seulement un nom de fichier et un
 *   CRC32.
 * - « le transfert entre joueurs n'est pas stocké » :
 *   `backend/src/websocket/rom-transfer.ts` réémet chaque morceau vers le
 *   socket du destinataire, borne sa taille et vérifie qu'il est membre du
 *   salon. Rien n'est écrit.
 * - « ni e-mail ni nom réel » : les deux colonnes ont été SUPPRIMÉES par
 *   `backend/migrations/0004_pseudonymous_users.sql`.
 * - « une session anonyme est balayée après 24 h » :
 *   `ANONYMOUS_SESSION_TTL_MS` dans `backend/src/bootstrap/jobs.ts`.
 * - « aucun traqueur » : vérifié par recherche sur tout le dépôt.
 *
 * Les deux citations de droit ont été relues sur Legifrance, mot pour mot, et
 * les liens vérifiés un par un : un lien inventé sur une page de ce genre
 * serait pire que pas de lien.
 */

export interface DocLink {
  label: string;
  href: string;
}

export interface DocSection {
  /** Sert d'ancre et de clé de parité. Jamais traduit. */
  id: string;
  title: string;
  /** Les paragraphes, dans l'ordre. Du texte brut : la page les rend. */
  body: string[];
  bullets?: string[];
  links?: DocLink[];
}

export interface DocPage {
  title: string;
  intro: string;
  sections: DocSection[];
  /** Ce que la page dit de sa propre fraîcheur. */
  updated: string;
}

export type DocLocale = 'en' | 'fr';

/** Le responsable de traitement et l'adresse des demandes RGPD. */
export const PRIVACY_CONTACT = 'privacy@pleymor.com';
export const DATA_CONTROLLER = 'Pleymor';

const LAW_LINKS: DocLink[] = [
  {
    label: 'CPI, art. L122-4',
    href: 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006278911'
  },
  {
    label: 'CPI, art. L122-5',
    href: 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000037388886/'
  },
  {
    label: 'CPI, art. L122-6-1',
    href: 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044365559'
  },
  {
    label: 'CPI, art. L335-2',
    href: 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032655082'
  },
  {
    label: 'Directive 2009/24/CE',
    href: 'https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32009L0024'
  }
];

const FR: DocPage = {
  title: 'Documentation',
  intro:
    'psnes fait tourner des jeux Super Nintendo dans le navigateur : seul, à deux ' +
    'en réseau, et dans un casque de réalité virtuelle. Cette page explique ce ' +
    'qu’il fait, où vivent vos fichiers, quelles données il garde, et ce que dit ' +
    'la loi sur les ROMs.',
  updated: 'Dernière mise à jour : 8 septembre 2026.',
  sections: [
    {
      id: 'what',
      title: 'Le projet',
      body: [
        'psnes est un émulateur Super Nintendo qui tourne entièrement dans votre ' +
          'navigateur. Il n’y a rien à installer : la page charge le cœur ' +
          'd’émulation, lit le fichier de jeu depuis votre propre machine, et joue.',
        'Le principe qui gouverne tout le reste : vos jeux restent chez vous. ' +
          'Le serveur sait qu’un jeu existe dans votre bibliothèque - son titre, sa ' +
          'jaquette, son empreinte - et n’en détient jamais les octets.'
      ]
    },
    {
      id: 'features',
      title: 'Ce que vous pouvez faire',
      body: [
        'Tout fonctionne au clavier, à la manette, au doigt sur un écran tactile, ' +
          'et dans un casque.'
      ],
      bullets: [
        'Jouer seul, avec sauvegardes d’état et sauvegarde de pile de la cartouche.',
        'Jouer à deux en réseau, en pas-à-pas synchronisé : les deux machines ' +
          'émulent la même partie et n’échangent que les touches.',
        'Inviter un ami, voir qui est en ligne et à quoi il joue.',
        'Retrouver sa bibliothèque et ses sauvegardes depuis n’importe quel appareil.',
        'Entrer dans une salle en réalité virtuelle : écran incurvé ou plat, ' +
          'réglable en distance, en taille et en hauteur, pupitres pour la ' +
          'bibliothèque et les amis, et une tablette flottante pour les options.',
        'Reconfigurer les huit boutons depuis le casque, ou brancher une manette ' +
          'Bluetooth.',
        'Exporter et réimporter ses réglages et ses sauvegardes.'
      ]
    },
    {
      id: 'roms',
      title: 'Où vivent les ROMs',
      body: [
        'Un fichier de jeu n’est jamais téléversé, jamais stocké et jamais servi ' +
          'par le serveur. Il n’existe aucune route pour en télécharger un, et la ' +
          'base ne contient aucun octet de jeu : une entrée de bibliothèque porte ' +
          'un titre, un nom de fichier, une jaquette et une empreinte CRC32.',
        'C’est cette empreinte qui fait le lien. Elle identifie votre fichier sur ' +
          'votre machine, ce qui permet à deux joueurs de vérifier qu’ils font ' +
          'tourner exactement le même jeu avant de lancer une partie commune.',
        'Vos fichiers sont lus soit depuis un dossier que vous autorisez une fois ' +
          '- l’autorisation est demandée par le navigateur, et le site ne voit ' +
          'jamais le reste de votre disque -, soit depuis le stockage local du ' +
          'navigateur pour un fichier que vous avez désigné à la main.',
        'Quand un ami rejoint votre partie sans avoir le jeu, votre copie lui est ' +
          'transmise morceau par morceau à travers le serveur, qui la relaie sans ' +
          'la conserver, et son navigateur vérifie l’empreinte à l’arrivée. Elle ne ' +
          's’installe chez lui que s’il répond oui à la question posée à l’écran : ' +
          'recevoir n’est pas posséder.'
      ]
    },
    {
      id: 'saves',
      title: 'Où vivent les sauvegardes',
      body: [
        'Les sauvegardes, elles, sont sur le serveur - c’est ce qui vous permet de ' +
          'reprendre une partie depuis un autre appareil ou depuis le casque.',
        'Deux choses distinctes y sont gardées : les sauvegardes d’état, avec leur ' +
          'nom, la date et une capture d’écran du moment ; et la sauvegarde de pile ' +
          'de la cartouche, celle que le jeu lui-même écrit quand il propose de ' +
          'sauvegarder.',
        'Vous pouvez les exporter dans un fichier, les réimporter, et supprimer ' +
          'une sauvegarde depuis le menu de pause comme depuis le casque. ' +
          'Supprimer un jeu de votre bibliothèque supprime ses sauvegardes avec ' +
          'lui, et supprimer un compte supprime l’ensemble.'
      ]
    },
    {
      id: 'privacy',
      title: 'Données personnelles (RGPD)',
      body: [
        `Responsable de traitement : ${DATA_CONTROLLER}. Pour toute demande ` +
          `relative à vos données : ${PRIVACY_CONTACT}.`,
        'Le service en garde le strict nécessaire, et il en a délibérément retiré : ' +
          'ni adresse e-mail ni nom réel ne sont conservés. Les deux colonnes qui ' +
          'les portaient ont été supprimées de la base. Vous êtes un pseudonyme que ' +
          'vous choisissez, suivi d’un discriminant à quatre chiffres.',
        'Ce qui est conservé pour un compte : l’identifiant opaque fourni par ' +
          'Google lors de la connexion, votre pseudonyme et son discriminant, ' +
          'votre avatar, votre configuration de touches, et les dates de création ' +
          'et de mise à jour. S’y ajoutent votre bibliothèque, vos sauvegardes et ' +
          'vos liens d’amitié.',
        'Vous pouvez aussi jouer sans compte. Une session anonyme n’a aucune ' +
          'identité persistante : elle est effacée à la déconnexion, et balayée ' +
          'automatiquement au bout de vingt-quatre heures.',
        'Il n’y a aucun traqueur, aucune mesure d’audience, aucune régie ' +
          'publicitaire et aucun outil de suivi d’erreur. Un cookie de session ' +
          'vous garde connecté, et c’est le seul. Le seul tiers est Google, pour ' +
          'la connexion.',
        'Vos droits d’accès, de rectification, d’effacement, de portabilité et ' +
          'd’opposition s’exercent à l’adresse ci-dessus. Deux précisions ' +
          'honnêtes : la portabilité est déjà en libre-service, par l’export de ' +
          'vos réglages et de vos sauvegardes ; l’effacement d’un compte, lui, se ' +
          'demande par courriel - il n’y a pas encore de bouton pour cela, et une ' +
          'demande est traitée à la main.'
      ]
    },
    {
      id: 'law',
      title: 'Les ROMs et la loi',
      body: [
        'Ce qui suit rassemble des références, ce n’est pas un conseil juridique. ' +
          'Elles valent pour la France et l’Union européenne ; d’autres pays ' +
          'tranchent autrement.',
        'Le principe est à l’article L122-4 du code de la propriété ' +
          'intellectuelle : toute reproduction faite sans le consentement de ' +
          'l’auteur est illicite. Un jeu Super Nintendo est protégé, et l’âge d’une ' +
          'console n’y change rien.',
        'L’exception de copie privée ne sauve pas un logiciel : l’article L122-5 ' +
          'exclut expressément les « copies d’un logiciel autres que la copie de ' +
          'sauvegarde établie dans les conditions prévues au II de l’article ' +
          'L. 122-6-1 ».',
        'Cette copie de sauvegarde est la seule porte, et elle est étroite. ' +
          'L’article L122-6-1 II dit que « la personne ayant le droit d’utiliser ' +
          'le logiciel peut faire une copie de sauvegarde lorsque celle-ci est ' +
          'nécessaire pour préserver l’utilisation du logiciel ». La directive ' +
          'européenne 2009/24/CE dit la même chose à son article 5 §2.',
        'En pratique, la distinction porte sur l’origine du fichier : une ROM que ' +
          'vous avez extraite de votre propre cartouche est la copie de sauvegarde ' +
          'de ce dont vous avez le droit d’usage ; une ROM téléchargée ne l’est ' +
          'pas, quelle que soit la cartouche posée sur votre étagère. La ' +
          'contrefaçon est un délit, puni par l’article L335-2.',
        'Ce site ne distribue aucun jeu et n’en héberge aucun. Il lit les fichiers ' +
          'que vous lui présentez, et vous êtes seul responsable du droit que vous ' +
          'avez d’en disposer.'
      ],
      links: LAW_LINKS
    }
  ]
};

const EN: DocPage = {
  title: 'Documentation',
  intro:
    'psnes runs Super Nintendo games in the browser: alone, with a friend over ' +
    'the network, and inside a virtual reality headset. This page explains what ' +
    'it does, where your files live, what data it keeps, and what the law says ' +
    'about ROMs.',
  updated: 'Last updated: 8 September 2026.',
  sections: [
    {
      id: 'what',
      title: 'The project',
      body: [
        'psnes is a Super Nintendo emulator that runs entirely in your browser. ' +
          'There is nothing to install: the page loads the emulation core, reads the ' +
          'game file from your own machine, and plays.',
        'The principle that governs everything else: your games stay with you. The ' +
          'server knows a game exists in your library - its title, its cover, its ' +
          'checksum - and never holds its bytes.'
      ]
    },
    {
      id: 'features',
      title: 'What you can do',
      body: [
        'Everything works with a keyboard, a gamepad, a finger on a touch screen, ' +
          'and inside a headset.'
      ],
      bullets: [
        'Play alone, with savestates and the cartridge’s own battery save.',
        'Play with a friend over the network in lockstep: both machines emulate the ' +
          'same game and exchange nothing but button presses.',
        'Invite a friend, see who is online and what they are playing.',
        'Find your library and your saves again from any device.',
        'Enter a virtual reality room: a curved or flat screen, adjustable in ' +
          'distance, size and height, lecterns for the library and your friends, and ' +
          'a floating tablet for the settings.',
        'Rebind the eight buttons from inside the headset, or plug in a Bluetooth ' +
          'pad.',
        'Export and re-import your settings and your saves.'
      ]
    },
    {
      id: 'roms',
      title: 'Where the ROMs live',
      body: [
        'A game file is never uploaded, never stored and never served by the ' +
          'server. There is no route to download one, and the database holds no game ' +
          'bytes at all: a library entry carries a title, a file name, a cover and a ' +
          'CRC32 checksum.',
        'That checksum is what ties things together. It identifies your file on your ' +
          'own machine, which is how two players can confirm they are running exactly ' +
          'the same game before starting a session together.',
        'Your files are read either from a folder you authorise once - the browser ' +
          'asks, and the site never sees the rest of your disk - or from the ' +
          'browser’s local storage for a file you picked by hand.',
        'When a friend joins your game without owning it, your copy is sent to them ' +
          'chunk by chunk through the server, which relays it without keeping it, and ' +
          'their browser checks the checksum on arrival. It is only installed on ' +
          'their device if they answer yes to the question on screen: receiving is ' +
          'not owning.'
      ]
    },
    {
      id: 'saves',
      title: 'Where the saves live',
      body: [
        'Saves, on the other hand, are on the server - that is what lets you pick a ' +
          'game up again from another device, or from the headset.',
        'Two distinct things are kept: savestates, with their name, the date and a ' +
          'screenshot of the moment; and the cartridge’s battery save, the one the ' +
          'game itself writes when it offers to save.',
        'You can export them to a file, re-import them, and delete a save from the ' +
          'pause menu as well as from inside the headset. Deleting a game from your ' +
          'library deletes its saves with it, and deleting an account deletes ' +
          'everything.'
      ]
    },
    {
      id: 'privacy',
      title: 'Personal data (GDPR)',
      body: [
        `Data controller: ${DATA_CONTROLLER}. For any request about your data: ` +
          `${PRIVACY_CONTACT}.`,
        'The service keeps the bare minimum, and it has deliberately given some ' +
          'up: neither an email address nor a real name is stored. The two columns ' +
          'that held them were removed from the database. You are a pseudonym you ' +
          'choose, followed by a four-digit discriminator.',
        'What is kept for an account: the opaque identifier Google provides when ' +
          'you sign in, your pseudonym and its discriminator, your avatar, your ' +
          'control bindings, and the creation and update dates. To that are added ' +
          'your library, your saves and your friendships.',
        'You can also play without an account. An anonymous session has no ' +
          'persistent identity at all: it is erased when you sign out, and swept ' +
          'automatically after twenty-four hours.',
        'There is no tracker, no analytics, no ad network and no error-reporting ' +
          'tool. A session cookie keeps you signed in, and it is the only one. The ' +
          'only third party is Google, for signing in.',
        'Your rights of access, rectification, erasure, portability and objection ' +
          'are exercised at the address above. Two honest details: portability is ' +
          'already self-service, through the export of your settings and saves; ' +
          'erasing an account, however, is requested by email - there is no button ' +
          'for it yet, and a request is handled by hand.'
      ]
    },
    {
      id: 'law',
      title: 'ROMs and the law',
      body: [
        'What follows gathers references; it is not legal advice. They apply to ' +
          'France and the European Union; other countries decide differently.',
        'The principle is in article L122-4 of the French intellectual property ' +
          'code: any reproduction made without the author’s consent is unlawful. A ' +
          'Super Nintendo game is protected, and the age of a console changes ' +
          'nothing about that.',
        'The private-copy exception does not save software: article L122-5 ' +
          'expressly excludes "copies of software other than the backup copy made ' +
          'under the conditions of article L. 122-6-1 II".',
        'That backup copy is the only door, and it is narrow. Article L122-6-1 II ' +
          'says that "the person having the right to use the software may make a ' +
          'backup copy where this is necessary to preserve the use of the ' +
          'software". European directive 2009/24/EC says the same in its article 5 ' +
          '§2.',
        'In practice the distinction is about where the file came from: a ROM you ' +
          'dumped from your own cartridge is the backup copy of something you have ' +
          'the right to use; a downloaded ROM is not, whatever cartridge sits on ' +
          'your shelf. Infringement is a criminal offence under article L335-2.',
        'This site distributes no games and hosts none. It reads the files you ' +
          'hand it, and you alone are responsible for the rights you hold over ' +
          'them.'
      ],
      links: LAW_LINKS
    }
  ]
};

export const DOCS: Record<DocLocale, DocPage> = { en: EN, fr: FR };

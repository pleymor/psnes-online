export const translations = {
  en: {
    // Legal disclaimer
    legalWarning: 'Legal Warning',
    legalText: 'This platform is provided for educational and preservation purposes. You must legally own the games for which you use ROMs. Using ROMs without owning the original games is illegal. By using this service, you agree to be solely responsible for complying with intellectual property laws.',
    legalUploadWarning: 'You must own an original physical copy of the game. Uploading and using ROMs without owning the original game is illegal. You are solely responsible for complying with intellectual property laws.',

    // Navigation
    library: 'Library',
    logout: 'Logout',

    // Home page
    playWithFriends: 'Play classic SNES games with your friends',
    signInWithGoogle: 'Sign in with Google',
    welcome: 'Welcome',
    goToLibrary: 'Go to my library',

    // Friends
    friends: 'Friends',
    requests: 'Requests',
    noFriendsYet: 'No friends yet',
    addFriend: 'Add Friend',
    friendEmail: "Friend's email",
    send: 'Send',
    friendRequestSent: 'Friend request sent!',
    failedToSendRequest: 'Failed to send request',
    offline: 'Offline',
    joinRoom: 'Join',
    inRoom: 'In room: {gameTitle}',

    // Friend details
    friendDetails: 'Friend Details',
    friendsSince: 'Friends since',
    exactDate: 'Exact date',
    removeFriend: 'Remove Friend',
    confirmRemoveFriend: 'Are you sure you want to remove {name} from your friends?',
    today: 'Today',
    daysAgo: '{count} days ago',
    dayAgo: '1 day ago',
    monthsAgo: '{count} months ago',
    monthAgo: '1 month ago',
    yearsAgo: '{count} years ago',
    yearAgo: '1 year ago',

    // Upload game
    uploadROM: 'Upload ROM',
    gameTitle: 'Game Title',
    romFile: 'ROM File',
    supportedFormats: 'Supported formats',
    upload: 'Upload',
    uploading: 'Uploading...',
    cancel: 'Cancel',

    // Room
    loading: 'Loading...',
    startGame: 'Start Game',
    leaveRoom: 'Leave Room',
    joiningRoom: 'Joining room...',

    // Pause menu
    pauseMenu: 'Pause Menu',
    controls: 'Controls',
    saveGame: 'Save Game',
    loadGame: 'Load Game',
    resume: 'Resume',
    quit: 'Quit',

    // General
    close: 'Close',
    yes: 'Yes',
    no: 'No',
    save: 'Save',
    delete: 'Delete',
    confirm: 'Confirm'
  },
  fr: {
    // Legal disclaimer
    legalWarning: 'Avertissement Légal',
    legalText: 'Cette plateforme est fournie à des fins éducatives et de préservation. Vous devez posséder légalement les jeux dont vous utilisez les ROMs. L\'utilisation de ROMs sans posséder les jeux originaux est illégale. En utilisant ce service, vous acceptez d\'être seul responsable du respect des lois sur la propriété intellectuelle.',
    legalUploadWarning: 'Vous devez posséder une copie physique originale du jeu. L\'upload et l\'utilisation de ROMs sans posséder le jeu original sont illégaux. Vous êtes seul responsable du respect des lois sur la propriété intellectuelle.',

    // Navigation
    library: 'Bibliothèque',
    logout: 'Déconnexion',

    // Home page
    playWithFriends: 'Jouez aux jeux SNES classiques avec vos amis',
    signInWithGoogle: 'Se connecter avec Google',
    welcome: 'Bienvenue',
    goToLibrary: 'Accéder à ma bibliothèque',

    // Friends
    friends: 'Amis',
    requests: 'Demandes',
    noFriendsYet: 'Pas encore d\'amis',
    addFriend: 'Ajouter un ami',
    friendEmail: 'Email de l\'ami',
    send: 'Envoyer',
    friendRequestSent: 'Demande d\'ami envoyée !',
    failedToSendRequest: 'Échec de l\'envoi de la demande',
    offline: 'Hors ligne',
    joinRoom: 'Rejoindre',
    inRoom: 'En room : {gameTitle}',

    // Friend details
    friendDetails: 'Détails de l\'ami',
    friendsSince: 'Amis depuis',
    exactDate: 'Date exacte',
    removeFriend: 'Retirer l\'ami',
    confirmRemoveFriend: 'Êtes-vous sûr de vouloir retirer {name} de vos amis ?',
    today: 'Aujourd\'hui',
    daysAgo: 'Il y a {count} jours',
    dayAgo: 'Il y a 1 jour',
    monthsAgo: 'Il y a {count} mois',
    monthAgo: 'Il y a 1 mois',
    yearsAgo: 'Il y a {count} ans',
    yearAgo: 'Il y a 1 an',

    // Upload game
    uploadROM: 'Upload ROM',
    gameTitle: 'Titre du jeu',
    romFile: 'Fichier ROM',
    supportedFormats: 'Formats supportés',
    upload: 'Uploader',
    uploading: 'Upload en cours...',
    cancel: 'Annuler',

    // Room
    loading: 'Chargement...',
    startGame: 'Démarrer le jeu',
    leaveRoom: 'Quitter la room',
    joiningRoom: 'Connexion à la room...',

    // Pause menu
    pauseMenu: 'Menu Pause',
    controls: 'Contrôles',
    saveGame: 'Sauvegarder',
    loadGame: 'Charger',
    resume: 'Reprendre',
    quit: 'Quitter',

    // General
    close: 'Fermer',
    yes: 'Oui',
    no: 'Non',
    save: 'Enregistrer',
    delete: 'Supprimer',
    confirm: 'Confirmer'
  }
};

export type TranslationKey = keyof typeof translations.en;

export function t(lang: 'en' | 'fr', key: TranslationKey, params?: Record<string, string | number>): string {
  let text = translations[lang][key] || translations.en[key] || key;

  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(`{${paramKey}}`, String(value));
    });
  }

  return text;
}

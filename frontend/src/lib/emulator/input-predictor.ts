import type { InputState } from '$lib/types';

function getEmptyInput(): InputState {
  return {
    a: false, b: false, x: false, y: false,
    l: false, r: false, start: false, select: false,
    up: false, down: false, left: false, right: false
  };
}

export class InputPredictor {
  private history: InputState[] = [];
  private historySize: number = 5;

  // Enregistrer inputs passés
  recordInput(input: InputState): void {
    this.history.push(input);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }
  }

  // Prédire le prochain input (stratégie simple)
  predict(): InputState {
    if (this.history.length === 0) {
      return getEmptyInput();
    }

    // Stratégie simple: répéter le dernier input
    // (fonctionne bien pour mouvements continus)
    return { ...this.history[this.history.length - 1] };
  }

  // Stratégie avancée: dead reckoning
  predictAdvanced(): InputState {
    if (this.history.length < 2) {
      return this.predict();
    }

    // Détecter tendance (ex: si le joueur va à droite, continuer)
    const last = this.history[this.history.length - 1];
    const previous = this.history[this.history.length - 2];

    // Si même input 2 fois de suite → probablement continue
    if (this.isSameInput(last, previous)) {
      return { ...last };
    }

    // Si changement récent, utiliser le dernier input connu
    return { ...last };
  }

  // Prédiction basée sur la fréquence (pour les inputs répétés)
  predictByFrequency(): InputState {
    if (this.history.length < 3) {
      return this.predict();
    }

    // Compter la fréquence de chaque pattern d'input
    const buttonFrequency: Partial<Record<keyof InputState, number>> = {};

    for (const input of this.history) {
      for (const button in input) {
        const key = button as keyof InputState;
        if (input[key]) {
          buttonFrequency[key] = (buttonFrequency[key] || 0) + 1;
        }
      }
    }

    // Créer un input basé sur les boutons les plus fréquents (>60% du temps)
    const predicted: InputState = getEmptyInput();
    const threshold = this.history.length * 0.6;

    for (const button in buttonFrequency) {
      const key = button as keyof InputState;
      if (buttonFrequency[key]! >= threshold) {
        predicted[key] = true;
      }
    }

    return predicted;
  }

  private isSameInput(a: InputState, b: InputState): boolean {
    // Compare tous les boutons
    return (
      a.a === b.a && a.b === b.b && a.x === b.x && a.y === b.y &&
      a.l === b.l && a.r === b.r && a.start === b.start && a.select === b.select &&
      a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right
    );
  }

  // Vérifier si un input est neutre (aucun bouton pressé)
  isNeutral(input: InputState): boolean {
    return !input.a && !input.b && !input.x && !input.y &&
           !input.l && !input.r && !input.start && !input.select &&
           !input.up && !input.down && !input.left && !input.right;
  }

  // Reset l'historique
  reset(): void {
    this.history = [];
  }

  // Obtenir la taille de l'historique
  getHistorySize(): number {
    return this.history.length;
  }
}

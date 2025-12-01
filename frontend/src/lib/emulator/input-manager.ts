import type { InputState } from '$lib/types';

export class InputManager {
  private localInputs: Map<number, InputState> = new Map(); // frame -> inputs

  // Enregistrer les inputs locaux avec timestamp frame
  recordInput(frame: number, input: InputState): void {
    this.localInputs.set(frame, input);

    // Nettoyer les anciens inputs (garder seulement les 120 dernières frames = 2 secondes)
    const oldestFrame = frame - 120;
    for (const [f] of this.localInputs) {
      if (f < oldestFrame) {
        this.localInputs.delete(f);
      }
    }
  }

  // Récupérer un input enregistré
  getInput(frame: number): InputState | null {
    return this.localInputs.get(frame) || null;
  }

  // Encoder inputs en format binaire compact
  encodeInput(input: InputState): Uint8Array {
    const buffer = new Uint8Array(2);
    buffer[0] = this.encodeButtons(input);  // 8 boutons SNES
    buffer[1] = this.encodeDpad(input);     // 4 directions
    return buffer;
  }

  // Décoder inputs binaires
  decodeInput(buffer: Uint8Array): InputState {
    const buttons = this.decodeButtons(buffer[0]);
    const dpad = this.decodeDpad(buffer[1]);
    return { ...buttons, ...dpad } as InputState;
  }

  private encodeButtons(input: InputState): number {
    let byte = 0;
    if (input.a) byte |= (1 << 0);
    if (input.b) byte |= (1 << 1);
    if (input.x) byte |= (1 << 2);
    if (input.y) byte |= (1 << 3);
    if (input.l) byte |= (1 << 4);
    if (input.r) byte |= (1 << 5);
    if (input.start) byte |= (1 << 6);
    if (input.select) byte |= (1 << 7);
    return byte;
  }

  private encodeDpad(input: InputState): number {
    let byte = 0;
    if (input.up) byte |= (1 << 0);
    if (input.down) byte |= (1 << 1);
    if (input.left) byte |= (1 << 2);
    if (input.right) byte |= (1 << 3);
    return byte;
  }

  private decodeButtons(byte: number): Partial<InputState> {
    return {
      a: !!(byte & (1 << 0)),
      b: !!(byte & (1 << 1)),
      x: !!(byte & (1 << 2)),
      y: !!(byte & (1 << 3)),
      l: !!(byte & (1 << 4)),
      r: !!(byte & (1 << 5)),
      start: !!(byte & (1 << 6)),
      select: !!(byte & (1 << 7))
    };
  }

  private decodeDpad(byte: number): Partial<InputState> {
    return {
      up: !!(byte & (1 << 0)),
      down: !!(byte & (1 << 1)),
      left: !!(byte & (1 << 2)),
      right: !!(byte & (1 << 3))
    };
  }

  // Créer un input vide
  createEmptyInput(): InputState {
    return {
      a: false,
      b: false,
      x: false,
      y: false,
      l: false,
      r: false,
      start: false,
      select: false,
      up: false,
      down: false,
      left: false,
      right: false
    };
  }
}

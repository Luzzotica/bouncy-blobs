export class KeyboardInput {
  private keys: Set<string> = new Set();

  constructor() {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
  }

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.keys.clear();
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  getMoveX(slot: 1 | 2 = 1): number {
    let x = 0;
    if (slot === 1) {
      if (this.keys.has('KeyA')) x -= 1;
      if (this.keys.has('KeyD')) x += 1;
    } else {
      if (this.keys.has('ArrowLeft')) x -= 1;
      if (this.keys.has('ArrowRight')) x += 1;
    }
    return x;
  }

  getMoveY(slot: 1 | 2 = 1): number {
    let y = 0;
    if (slot === 1) {
      if (this.keys.has('KeyW')) y -= 1;
      if (this.keys.has('KeyS')) y += 1;
    } else {
      if (this.keys.has('ArrowUp')) y -= 1;
      if (this.keys.has('ArrowDown')) y += 1;
    }
    return y;
  }

  isExpanding(slot: 1 | 2 = 1): boolean {
    if (slot === 1) return this.keys.has('Space');
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  isPressed(code: string): boolean {
    return this.keys.has(code);
  }
}

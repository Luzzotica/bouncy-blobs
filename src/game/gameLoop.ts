export class GameLoop {
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private onTick: (dt: number) => void;

  constructor(onTick: (dt: number) => void) {
    this.onTick = onTick;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.tick(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 20); // cap at 50ms
    this.lastTime = now;
    this.onTick(dt);
    this.rafId = requestAnimationFrame(this.tick);
  };
}

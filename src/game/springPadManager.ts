import { SoftBodyWorld } from '../physics/softBodyWorld';
import { Vec2, vec2, add, scale, sub, dot, length } from '../physics/vec2';
import { SpringPadDef } from '../levels/types';

const EXPAND_FORCE_MULT = 1.8;
const SPRING_FORCE_MULT = 10.0;
const TRIGGER_RADIUS = 80;

interface RegisteredSpring {
  def: SpringPadDef;
  launchDir: Vec2;
  animTimer: number;
}

export class SpringPadManager {
  private springs: RegisteredSpring[] = [];
  private world: SoftBodyWorld | null = null;
  private time = 0;

  initialize(world: SoftBodyWorld, defs: SpringPadDef[]): void {
    this.world = world;
    this.springs = [];
    this.time = 0;

    for (const def of defs) {
      const launchDir = vec2(Math.cos(def.rotation), Math.sin(def.rotation));
      this.springs.push({
        def,
        launchDir,
        animTimer: 0,
      });
    }
  }

  /** Add a spring pad at runtime (for party mode placement). */
  addSpring(def: SpringPadDef): void {
    const launchDir = vec2(Math.cos(def.rotation), Math.sin(def.rotation));
    this.springs.push({
      def,
      launchDir,
      animTimer: 0,
    });
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.world) return;

    // Check each blob centroid against each spring pad
    for (const spring of this.springs) {
      if (spring.animTimer > 0) {
        spring.animTimer = Math.max(0, spring.animTimer - dt);
      }

      const { def, launchDir } = spring;
      const springPos = vec2(def.x, def.y);

      for (let bi = 0; bi < this.world.blobRanges.length; bi++) {
        const blob = this.world.blobRanges[bi];
        // Compute blob centroid
        let cx = 0, cy = 0;
        for (const idx of blob.hull) {
          cx += this.world.pos[idx].x;
          cy += this.world.pos[idx].y;
        }
        cx /= blob.hull.length;
        cy /= blob.hull.length;

        const dx = cx - def.x;
        const dy = cy - def.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > TRIGGER_RADIUS) continue;

        // Check approach direction — only trigger if blob is not already launched
        // (or at least not moving away fast in the launch direction)
        let blobVelX = 0, blobVelY = 0;
        for (const idx of blob.hull) {
          blobVelX += this.world.vel[idx].x;
          blobVelY += this.world.vel[idx].y;
        }
        blobVelX /= blob.hull.length;
        blobVelY /= blob.hull.length;

        // Don't re-trigger if already moving fast in launch direction
        const velAlongLaunch = blobVelX * launchDir.x + blobVelY * launchDir.y;
        if (velAlongLaunch > def.force * SPRING_FORCE_MULT * 0.5) continue;

        // Fire!
        spring.animTimer = 0.3;

        // Check if expanding
        const shape = this.world.shapes[blob.shapeIdx];
        const isExpanding = shape && shape.shapeMatchRestScale > 1.2;
        const forceMult = isExpanding ? EXPAND_FORCE_MULT : 1.0;

        // Apply velocity impulse to all particles in the blob
        const impulse = scale(launchDir, def.force * forceMult * SPRING_FORCE_MULT);
        for (let i = blob.start; i < blob.end; i++) {
          // First cancel existing velocity in the opposite direction of launch
          const velAgainstLaunch = dot(this.world.vel[i], launchDir);
          if (velAgainstLaunch < 0) {
            this.world.vel[i] = sub(this.world.vel[i], scale(launchDir, velAgainstLaunch));
          }
          // Then add launch impulse
          this.world.vel[i] = add(this.world.vel[i], impulse);
        }
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const spring of this.springs) {
      const { def, animTimer } = spring;

      // Compression animation
      const compress = animTimer > 0 ? Math.sin(animTimer * Math.PI / 0.3) * 0.4 : 0;

      ctx.save();
      ctx.translate(def.x, def.y);

      // The spring is oriented so its flat base is perpendicular to launch direction
      // and the coils extend in the opposite direction of launch
      ctx.rotate(def.rotation);

      const baseW = def.width;
      const baseH = def.height;
      const hw = baseW / 2;
      const hh = baseH / 2;

      // === Draw spring coils (zigzag pattern) ===
      const coilLength = baseW * 0.8;
      const coilAmplitude = hh * 0.7;
      const numZigs = 5;
      const compressedLength = coilLength * (1 - compress);

      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Coils extend to the left (opposite of launch direction which is +x after rotation)
      const coilStartX = -hw * 0.2;
      const coilEndX = coilStartX - compressedLength;
      const zigStep = compressedLength / numZigs;

      ctx.beginPath();
      // Bottom anchor
      ctx.moveTo(coilStartX, 0);

      for (let i = 0; i < numZigs; i++) {
        const x = coilStartX - (i + 0.5) * zigStep;
        const yDir = i % 2 === 0 ? -1 : 1;
        ctx.lineTo(x, yDir * coilAmplitude);
      }
      ctx.lineTo(coilEndX, 0);
      ctx.stroke();

      // === Base plate (the flat surface blobs hit) ===
      ctx.fillStyle = '#e8e8e8';
      ctx.strokeStyle = '#aaaaaa';
      ctx.lineWidth = 2;
      const plateW = 8;
      ctx.beginPath();
      ctx.roundRect(coilStartX, -hh, plateW, baseH, 2);
      ctx.fill();
      ctx.stroke();

      // === Back plate (wall the spring is attached to) ===
      ctx.fillStyle = '#888888';
      ctx.strokeStyle = '#666666';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(coilEndX - 6, -hh * 1.2, 6, baseH * 1.2, 1);
      ctx.fill();
      ctx.stroke();

      // === Small arrow showing launch direction ===
      ctx.fillStyle = 'rgba(255, 200, 50, 0.7)';
      ctx.beginPath();
      const arrowX = coilStartX + plateW + 8;
      ctx.moveTo(arrowX + 12, 0);
      ctx.lineTo(arrowX, -5);
      ctx.lineTo(arrowX, 5);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }
  }

  cleanup(): void {
    this.springs = [];
    this.world = null;
  }
}

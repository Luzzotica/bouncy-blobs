import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from './EditorState';
import { LevelData } from '../levels/types';

function blankLevel(): LevelData {
  return {
    name: 'test', version: 1,
    bounds: { width: 1000, height: 1000 },
    platforms: [], walls: [], spawnPoints: [], npcBlobs: [],
  };
}

describe('EditorState — PointShape tool', () => {
  let state: EditorState;
  beforeEach(() => { state = new EditorState(blankLevel()); state.snapToGrid = false; });

  it('begins a draft when beginDraftPointShape is called', () => {
    state.beginDraftPointShape();
    expect(state.draftPointShape).not.toBeNull();
    expect(state.draftPointShape!.points).toEqual([]);
  });

  it('appendDraftPoint stores points; Shift flag marks them anchored', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(10, 20, false);
    state.appendDraftPoint(50, 60, true);
    expect(state.draftPointShape!.points).toHaveLength(2);
    expect(state.draftPointShape!.points[0]).toMatchObject({ x: 10, y: 20, anchored: false });
    expect(state.draftPointShape!.points[1]).toMatchObject({ x: 50, y: 60, anchored: true });
  });

  it('commitDraftPointShape with fewer than 2 points discards the draft', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.commitDraftPointShape();
    expect(state.draftPointShape).toBeNull();
    expect(state.level.pointShapes ?? []).toHaveLength(0);
  });

  it('commitDraftPointShape persists the shape as a closed soft-blob hull', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(200, 0, true);
    state.commitDraftPointShape();

    expect(state.draftPointShape).toBeNull();
    expect(state.level.pointShapes).toHaveLength(1);
    const shape = state.level.pointShapes![0];
    expect(shape.points).toHaveLength(3);
    // Point shapes are closed soft-blob hulls; `edges` is vestigial (the
    // loader ignores it and walks the point ring directly).
    expect(shape.edges).toEqual([]);
    expect(shape.closed).toBe(true);
    expect(state.selectedElement).toEqual({ type: 'pointShape', id: shape.id });
  });

  it('closing the shape sets closed=true on commit', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(50, 100, false);
    state.commitDraftPointShape(true);
    expect(state.level.pointShapes![0].closed).toBe(true);
  });

  it('clicking near the first point auto-closes and commits', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(50, 100, false);
    state.appendDraftPoint(5, 5, false); // close to first point → auto-close
    expect(state.draftPointShape).toBeNull();
    expect(state.level.pointShapes).toHaveLength(1);
    expect(state.level.pointShapes![0].closed).toBe(true);
  });

  it('cancelDraftPointShape discards in-progress points without committing', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.cancelDraftPointShape();
    expect(state.draftPointShape).toBeNull();
    expect(state.level.pointShapes ?? []).toHaveLength(0);
  });

  it('togglePointAnchored flips a vertex anchored flag', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(50, 80, false);
    state.commitDraftPointShape();
    const shape = state.level.pointShapes![0];

    state.togglePointAnchored(shape.id, 0);
    expect(shape.points[0].anchored).toBe(true);
    state.togglePointAnchored(shape.id, 0);
    expect(shape.points[0].anchored).toBe(false);
  });

  it('deleting a vertex reindexes edges and tidies dependent action targets', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(200, 0, false);
    state.commitDraftPointShape();
    const shape = state.level.pointShapes![0];

    // Author an action targeting point index 2 of this shape.
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 2);
    state.advanceDraftActionPhase();
    state.commitDraftAction();
    const action = state.level.actions![0];
    const target = action.targets[0];
    if (target.kind !== 'shapePoint') throw new Error('expected shapePoint target');
    expect(target.pointIndex).toBe(2);

    // Delete the MIDDLE vertex — index 2 should shift to 1.
    state.selectedElement = { type: 'pointShapeVertex', id: shape.id, pointIndex: 1 };
    state.deleteSelected();

    expect(shape.points).toHaveLength(2);
    const after = action.targets[0];
    if (after.kind !== 'shapePoint') throw new Error('expected shapePoint target');
    expect(after.pointIndex).toBe(1);
  });

  it('deleting a PointShape removes actions that targeted only that shape', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(50, 80, false);
    state.commitDraftPointShape();
    const shape = state.level.pointShapes![0];

    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 0);
    state.advanceDraftActionPhase();
    state.commitDraftAction();

    state.selectedElement = { type: 'pointShape', id: shape.id };
    state.deleteSelected();

    expect(state.level.pointShapes).toHaveLength(0);
    expect(state.level.actions ?? []).toHaveLength(0);
  });
});

describe('EditorState — Trigger (area) tool', () => {
  let state: EditorState;
  beforeEach(() => { state = new EditorState(blankLevel()); state.snapToGrid = false; });

  it('addTrigger creates a trigger area with sensible defaults and selects it', () => {
    state.addTrigger(40, 50);
    expect(state.level.triggers).toHaveLength(1);
    const t = state.level.triggers![0];
    expect(t.x).toBe(40);
    expect(t.y).toBe(50);
    expect(t.width).toBeGreaterThan(0);
    expect(t.height).toBeGreaterThan(0);
    expect(state.selectedElement).toEqual({ type: 'trigger', id: t.id });
    expect(state.selectedTool).toBe('select');
  });

  it('startPlacement(trigger) + drag updates the trigger dimensions', () => {
    state.startPlacement('trigger', 0, 0);
    state.updatePlacement(200, 30);
    state.finishPlacement();
    const t = state.level.triggers![0];
    expect(t.width).toBe(200);
    expect(t.height).toBe(30);
    expect(t.x).toBe(100);
    expect(t.y).toBe(15);
  });

  it('deleting a trigger removes it from the level and drops it from action source lists', () => {
    state.addTrigger(0, 0);
    const triggerId = state.level.triggers![0].id;
    // Manually inject an action that references this trigger so we can verify cleanup.
    state.level.actions = [{
      id: 'a1', kind: 'movePoints', targets: [{ kind: 'shapePoint', shapeId: 'x', pointIndex: 0, endX: 0, endY: 0 }],
      duration: 1, sourceTriggerIds: [triggerId], requireMode: 'any', mode: 'switch',
    }];

    state.selectedElement = { type: 'trigger', id: triggerId };
    state.deleteSelected();

    expect(state.level.triggers).toHaveLength(0);
    expect(state.level.actions![0].sourceTriggerIds).not.toContain(triggerId);
  });
});

describe('EditorState — Action tool', () => {
  let state: EditorState;
  beforeEach(() => {
    state = new EditorState(blankLevel());
    state.snapToGrid = false;
    // Seed a CLOSED 3+ point shape so actions have something to target.
    // commitDraftPointShape requires at least 3 points (it's a soft-body blob now).
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(50, 80, false);
    state.commitDraftPointShape();
  });

  it('beginDraftAction initializes pickPoints phase', () => {
    state.beginDraftAction();
    expect(state.draftAction).not.toBeNull();
    expect(state.draftAction!.phase).toBe('pickPoints');
    expect(state.draftAction!.targets).toEqual([]);
  });

  it('appendActionTargetAtVertex adds a target with a default end offset', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 0);
    expect(state.draftAction!.targets).toHaveLength(1);
    const t = state.draftAction!.targets[0];
    if (t.kind !== 'shapePoint') throw new Error('expected shapePoint target');
    expect(t).toMatchObject({ shapeId: shape.id, pointIndex: 0 });
    // End should be offset from the source point.
    expect(t.endX !== shape.points[0].x || t.endY !== shape.points[0].y).toBe(true);
  });

  it('appendActionTargetAtVertex de-duplicates by (shapeId, pointIndex)', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 0);
    state.appendActionTargetAtVertex(shape.id, 0);
    expect(state.draftAction!.targets).toHaveLength(1);
  });

  it('advanceDraftActionPhase requires at least one target', () => {
    state.beginDraftAction();
    state.advanceDraftActionPhase();
    expect(state.draftAction!.phase).toBe('pickPoints'); // no targets → stays

    const shape = state.level.pointShapes![0];
    state.appendActionTargetAtVertex(shape.id, 0);
    state.advanceDraftActionPhase();
    expect(state.draftAction!.phase).toBe('placeEnds');
  });

  it('setDraftActionTargetEnd updates the configured end position', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 0);
    state.setDraftActionTargetEnd(0, 250, -90);
    const target = state.draftAction!.targets[0];
    if (target.kind === 'shapePoint') {
      expect(target.endX).toBe(250);
      expect(target.endY).toBe(-90);
    } else {
      throw new Error(`expected shapePoint target, got ${target.kind}`);
    }
  });

  it('commitDraftAction persists the action with default mode=switch and selects it', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 1);
    state.setDraftActionTargetEnd(0, 200, 50);
    state.advanceDraftActionPhase();
    state.commitDraftAction();

    expect(state.draftAction).toBeNull();
    expect(state.level.actions).toHaveLength(1);
    const action = state.level.actions![0];
    expect(action.kind).toBe('movePoints');
    expect(action.mode).toBe('switch');
    expect(action.requireMode).toBe('any');
    expect(action.targets).toHaveLength(1);
    const target = action.targets[0];
    if (target.kind !== 'shapePoint') throw new Error('expected shapePoint target');
    expect(target).toMatchObject({ shapeId: shape.id, pointIndex: 1, endX: 200, endY: 50 });
    expect(state.selectedElement).toEqual({ type: 'action', id: action.id });
  });

  it('cancelDraftAction does not persist anything', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftAction();
    state.appendActionTargetAtVertex(shape.id, 0);
    state.cancelDraftAction();
    expect(state.draftAction).toBeNull();
    expect(state.level.actions ?? []).toHaveLength(0);
  });

  it('toggleActionSourceTrigger adds and removes trigger references', () => {
    state.beginDraftAction();
    state.appendActionTargetAtVertex(state.level.pointShapes![0].id, 0);
    state.commitDraftAction();
    const action = state.level.actions![0];

    state.toggleActionSourceTrigger(action.id, 't1');
    state.toggleActionSourceTrigger(action.id, 't2');
    expect(action.sourceTriggerIds).toEqual(['t1', 't2']);

    state.toggleActionSourceTrigger(action.id, 't1');
    expect(action.sourceTriggerIds).toEqual(['t2']);
  });

  it('hitTestPointShapeVertex returns the closest vertex within radius', () => {
    const shape = state.level.pointShapes![0];
    expect(state.hitTestPointShapeVertex(2, 2)).toEqual({ shapeId: shape.id, pointIndex: 0 });
    expect(state.hitTestPointShapeVertex(99, 1)).toEqual({ shapeId: shape.id, pointIndex: 1 });
    expect(state.hitTestPointShapeVertex(500, 500)).toBeNull();
  });

  describe('hitTestDraftActionEnd — per target kind', () => {
    it('shapePoint: small circle around endX/endY', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetAtVertex(shape.id, 0);
      // Auto-advances to placeEnds after first target.
      expect(state.draftAction!.phase).toBe('placeEnds');
      state.setDraftActionTargetEnd(0, 500, 500);

      expect(state.hitTestDraftActionEnd(500, 500)).toBe(0);     // dead-centre
      expect(state.hitTestDraftActionEnd(505, 500)).toBe(0);     // inside small radius
      expect(state.hitTestDraftActionEnd(600, 500)).toBeNull();  // outside radius
    });

    it('platform: full ghost rectangle (rotated) is hit-testable', () => {
      // Seed a wide platform; default ghost is offset (plat.x + 200, plat.y)
      // so a click anywhere inside the rect should drag it.
      state.level.platforms.push({
        id: 'plat_test', x: 0, y: 0, width: 400, height: 60, rotation: 0,
      });
      state.beginDraftAction();
      state.appendActionTargetAtPlatform('plat_test');
      expect(state.draftAction!.phase).toBe('placeEnds');
      // Default end is (200, 0). Hit-test points inside the 400×60 rect.
      expect(state.hitTestDraftActionEnd(200, 0)).toBe(0);     // dead-centre
      expect(state.hitTestDraftActionEnd(150, 20)).toBe(0);    // well inside
      expect(state.hitTestDraftActionEnd(395, -25)).toBe(0);   // corner-ish, still inside
      expect(state.hitTestDraftActionEnd(420, 0)).toBeNull();  // outside +x
      expect(state.hitTestDraftActionEnd(200, 40)).toBeNull(); // outside +y
    });

    it('platform: respects endRotation when hit-testing the ghost', () => {
      // 100×40 narrow plank. Rotate 90° → the rect's long axis is vertical.
      state.level.platforms.push({
        id: 'plank', x: 0, y: 0, width: 100, height: 40, rotation: 0,
      });
      state.beginDraftAction();
      state.appendActionTargetAtPlatform('plank');
      state.setDraftActionTargetEnd(0, 0, 0);
      // Set endRotation directly on the draft target.
      const t = state.draftAction!.targets[0];
      if (t.kind !== 'platform') throw new Error('expected platform target');
      t.endRotation = Math.PI / 2;
      // 90°-rotated rect is vertical: hits inside the rotated bounds.
      expect(state.hitTestDraftActionEnd(15, 40)).toBe(0);     // inside rotated rect
      expect(state.hitTestDraftActionEnd(45, 0)).toBeNull();   // outside long side
    });

    it('rotateShape: NOT draggable on canvas (no positional ghost)', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetRotateShape(shape.id);
      expect(state.draftAction!.phase).toBe('placeEnds');
      // Hit-test anywhere should miss — rotateShape has no draggable handle.
      expect(state.hitTestDraftActionEnd(0, 0)).toBeNull();
      expect(state.hitTestDraftActionEnd(50, 50)).toBeNull();
      expect(state.hitTestDraftActionEnd(100, 0)).toBeNull();
    });

    it('only returns hits while in placeEnds phase', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetAtVertex(shape.id, 0);
      // Force back to pickPoints to simulate the pre-target state.
      state.draftAction!.phase = 'pickPoints';
      const target = state.draftAction!.targets[0];
      if (target.kind !== 'shapePoint') throw new Error('expected shapePoint');
      expect(state.hitTestDraftActionEnd(target.endX, target.endY)).toBeNull();
    });
  });

  describe('setDraftActionTargetEnd — drag updates per target kind', () => {
    it('shapePoint: drag updates endX/endY', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetAtVertex(shape.id, 0);
      state.setDraftActionTargetEnd(0, 123, -45);
      const t = state.draftAction!.targets[0];
      if (t.kind !== 'shapePoint') throw new Error('expected shapePoint');
      expect(t.endX).toBe(123);
      expect(t.endY).toBe(-45);
    });

    it('platform: drag updates endX/endY', () => {
      state.level.platforms.push({ id: 'p1', x: 0, y: 0, width: 100, height: 30, rotation: 0 });
      state.beginDraftAction();
      state.appendActionTargetAtPlatform('p1');
      state.setDraftActionTargetEnd(0, 777, 888);
      const t = state.draftAction!.targets[0];
      if (t.kind !== 'platform') throw new Error('expected platform');
      expect(t.endX).toBe(777);
      expect(t.endY).toBe(888);
    });

    it('rotateShape: drag is a no-op (no positional fields to update)', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetRotateShape(shape.id);
      // Should not throw and should not gain endX/endY fields.
      state.setDraftActionTargetEnd(0, 100, 100);
      const t = state.draftAction!.targets[0];
      expect(t.kind).toBe('rotateShape');
      expect((t as { endX?: number }).endX).toBeUndefined();
      expect((t as { endY?: number }).endY).toBeUndefined();
    });
  });

  describe('hitTestSelectedActionEnd — committed action ghosts', () => {
    it('returns hit for the SELECTED action only', () => {
      const shape = state.level.pointShapes![0];
      // Commit one action targeting the shape's first point at (250, 250).
      state.beginDraftAction();
      state.appendActionTargetAtVertex(shape.id, 0);
      state.setDraftActionTargetEnd(0, 250, 250);
      state.commitDraftAction();
      const action = state.level.actions![0];
      // Selection deliberately cleared — verify no hit fires.
      state.selectedElement = null;
      expect(state.hitTestSelectedActionEnd(250, 250)).toBeNull();
      // Selecting the action → hit fires on the ghost.
      state.selectedElement = { type: 'action', id: action.id };
      expect(state.hitTestSelectedActionEnd(250, 250)).toEqual({ actionId: action.id, index: 0 });
      expect(state.hitTestSelectedActionEnd(2000, 2000)).toBeNull();
    });
  });

  describe('setActionTargetEndRotation', () => {
    it('platform target accepts endRotation', () => {
      state.level.platforms.push({ id: 'p1', x: 0, y: 0, width: 100, height: 30, rotation: 0 });
      state.beginDraftAction();
      state.appendActionTargetAtPlatform('p1');
      state.commitDraftAction();
      const action = state.level.actions![0];
      state.setActionTargetEndRotation(action.id, 0, Math.PI / 2);
      const t = action.targets[0];
      if (t.kind !== 'platform') throw new Error('expected platform');
      expect(t.endRotation).toBeCloseTo(Math.PI / 2);
    });

    it('rotateShape target accepts endRotation', () => {
      const shape = state.level.pointShapes![0];
      state.beginDraftAction();
      state.appendActionTargetRotateShape(shape.id);
      state.commitDraftAction();
      const action = state.level.actions![0];
      state.setActionTargetEndRotation(action.id, 0, Math.PI);
      const t = action.targets[0];
      if (t.kind !== 'rotateShape') throw new Error('expected rotateShape');
      expect(t.endRotation).toBeCloseTo(Math.PI);
    });
  });
});

describe('EditorState — nextId hydration on load', () => {
  it('does not collide with ids in a loaded level', () => {
    // Mimic a saved level with high-numeric ids.
    const saved: LevelData = {
      name: 'saved', version: 1,
      bounds: { width: 1000, height: 1000 },
      platforms: [
        { id: 'plat_1', x: 0, y: 0, width: 100, height: 30, rotation: 0 },
        { id: 'plat_5', x: 100, y: 0, width: 100, height: 30, rotation: 0 },
      ],
      walls: [], spawnPoints: [], npcBlobs: [],
    };
    const state = new EditorState(saved);
    state.snapToGrid = false;
    // Adding a new platform should NOT reuse plat_1 / plat_5.
    state.addPlatform(500, 500);
    const newPlat = state.level.platforms.find(p => p.id !== 'plat_1' && p.id !== 'plat_5');
    expect(newPlat).toBeTruthy();
    // The original two platforms must remain unchanged in count + ids.
    const ids = state.level.platforms.map(p => p.id);
    expect(ids).toContain('plat_1');
    expect(ids).toContain('plat_5');
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});

describe('EditorState — game-mode validation + setLevelTypes', () => {
  it('setLevelTypes replaces the array and clears legacy levelType', () => {
    const state = new EditorState(blankLevel());
    state.level.levelType = 'solo_racing'; // simulate legacy
    state.setLevelTypes(['party', 'koth']);
    expect(state.level.levelTypes).toEqual(['party', 'koth']);
    expect(state.level.levelType).toBeUndefined();
  });
});

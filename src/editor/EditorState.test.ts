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

  it('commitDraftPointShape persists the shape and generates sequential edges', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(200, 0, true);
    state.commitDraftPointShape();

    expect(state.draftPointShape).toBeNull();
    expect(state.level.pointShapes).toHaveLength(1);
    const shape = state.level.pointShapes![0];
    expect(shape.points).toHaveLength(3);
    expect(shape.edges).toEqual([{ a: 0, b: 1 }, { a: 1, b: 2 }]);
    expect(shape.closed).toBe(false);
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
    // Seed a shape so actions have something to target.
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
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
    expect(state.draftAction!.targets[0].endX).toBe(250);
    expect(state.draftAction!.targets[0].endY).toBe(-90);
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
});

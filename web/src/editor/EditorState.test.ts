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

  it('deleting a vertex reindexes edges and tidies dependent trigger targets', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, false);
    state.appendDraftPoint(100, 0, false);
    state.appendDraftPoint(200, 0, false);
    state.commitDraftPointShape();
    const shape = state.level.pointShapes![0];

    // Author a trigger targeting point index 2 of this shape.
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 2);
    state.advanceDraftTriggerPhase();
    state.commitDraftTrigger();
    const trig = state.level.triggers![0];
    expect(trig.targets[0].pointIndex).toBe(2);

    // Delete the MIDDLE vertex — index 2 should shift to 1, and the surviving edge should
    // reference indices 0 and 1 (formerly 0 and 2).
    state.selectedElement = { type: 'pointShapeVertex', id: shape.id, pointIndex: 1 };
    state.deleteSelected();

    expect(shape.points).toHaveLength(2);
    expect(trig.targets[0].pointIndex).toBe(1);
  });

  it('deleting a PointShape cascades to triggers + plate bindings', () => {
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.commitDraftPointShape();
    const shape = state.level.pointShapes![0];

    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.advanceDraftTriggerPhase();
    state.commitDraftTrigger();
    const trig = state.level.triggers![0];

    state.addPressurePlate(0, 200);
    const plate = state.level.pressurePlates![0];
    state.togglePlateTriggerBinding(plate.id, trig.id);
    expect(plate.triggerIds).toContain(trig.id);

    state.selectedElement = { type: 'pointShape', id: shape.id };
    state.deleteSelected();

    expect(state.level.pointShapes).toHaveLength(0);
    expect(state.level.triggers).toHaveLength(0);
    expect(plate.triggerIds).not.toContain(trig.id);
  });
});

describe('EditorState — PressurePlate tool', () => {
  let state: EditorState;
  beforeEach(() => { state = new EditorState(blankLevel()); state.snapToGrid = false; });

  it('addPressurePlate creates a plate with sensible defaults and selects it', () => {
    state.addPressurePlate(40, 50);
    expect(state.level.pressurePlates).toHaveLength(1);
    const p = state.level.pressurePlates![0];
    expect(p.x).toBe(40);
    expect(p.y).toBe(50);
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
    expect(p.triggerIds).toEqual([]);
    expect(state.selectedElement).toEqual({ type: 'plate', id: p.id });
    expect(state.selectedTool).toBe('select');
  });

  it('startPlacement(plate) + drag updates the plate dimensions', () => {
    state.startPlacement('plate', 0, 0);
    state.updatePlacement(200, 30);
    state.finishPlacement();
    const p = state.level.pressurePlates![0];
    expect(p.width).toBe(200);
    expect(p.height).toBe(30);
    expect(p.x).toBe(100);
    expect(p.y).toBe(15);
  });

  it('togglePlateTriggerBinding adds and removes trigger references', () => {
    state.addPressurePlate(0, 0);
    const plateId = state.level.pressurePlates![0].id;

    state.togglePlateTriggerBinding(plateId, 'trig1');
    state.togglePlateTriggerBinding(plateId, 'trig2');
    expect(state.level.pressurePlates![0].triggerIds).toEqual(['trig1', 'trig2']);

    state.togglePlateTriggerBinding(plateId, 'trig1');
    expect(state.level.pressurePlates![0].triggerIds).toEqual(['trig2']);
  });

  it('deleting a plate removes it from the level', () => {
    state.addPressurePlate(0, 0);
    const id = state.level.pressurePlates![0].id;
    state.selectedElement = { type: 'plate', id };
    state.deleteSelected();
    expect(state.level.pressurePlates).toHaveLength(0);
  });
});

describe('EditorState — Trigger tool', () => {
  let state: EditorState;
  beforeEach(() => {
    state = new EditorState(blankLevel());
    state.snapToGrid = false;
    // Seed a shape so triggers have something to target.
    state.beginDraftPointShape();
    state.appendDraftPoint(0, 0, true);
    state.appendDraftPoint(100, 0, false);
    state.commitDraftPointShape();
  });

  it('beginDraftTrigger initializes pickPoints phase', () => {
    state.beginDraftTrigger();
    expect(state.draftTrigger).not.toBeNull();
    expect(state.draftTrigger!.phase).toBe('pickPoints');
    expect(state.draftTrigger!.targets).toEqual([]);
  });

  it('appendTriggerTargetAtVertex adds a target with a default end offset', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    expect(state.draftTrigger!.targets).toHaveLength(1);
    const t = state.draftTrigger!.targets[0];
    expect(t).toMatchObject({ shapeId: shape.id, pointIndex: 0 });
    // End should be offset from the source point, not equal to it.
    expect(t.endX !== shape.points[0].x || t.endY !== shape.points[0].y).toBe(true);
  });

  it('appendTriggerTargetAtVertex de-duplicates by (shapeId, pointIndex)', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.appendTriggerTargetAtVertex(shape.id, 0);
    expect(state.draftTrigger!.targets).toHaveLength(1);
  });

  it('advanceDraftTriggerPhase requires at least one target', () => {
    state.beginDraftTrigger();
    state.advanceDraftTriggerPhase();
    expect(state.draftTrigger!.phase).toBe('pickPoints'); // no targets → stays

    const shape = state.level.pointShapes![0];
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.advanceDraftTriggerPhase();
    expect(state.draftTrigger!.phase).toBe('placeEnds');
  });

  it('setDraftTriggerTargetEnd updates the configured end position', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.setDraftTriggerTargetEnd(0, 250, -90);
    expect(state.draftTrigger!.targets[0].endX).toBe(250);
    expect(state.draftTrigger!.targets[0].endY).toBe(-90);
  });

  it('commitDraftTrigger persists the trigger and selects it', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 1);
    state.setDraftTriggerTargetEnd(0, 200, 50);
    state.advanceDraftTriggerPhase();
    state.commitDraftTrigger();

    expect(state.draftTrigger).toBeNull();
    expect(state.level.triggers).toHaveLength(1);
    const trig = state.level.triggers![0];
    expect(trig.kind).toBe('movePoints');
    expect(trig.targets).toHaveLength(1);
    expect(trig.targets[0]).toMatchObject({ shapeId: shape.id, pointIndex: 1, endX: 200, endY: 50 });
    expect(state.selectedElement).toEqual({ type: 'trigger', id: trig.id });
  });

  it('cancelDraftTrigger does not persist anything', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.cancelDraftTrigger();
    expect(state.draftTrigger).toBeNull();
    expect(state.level.triggers ?? []).toHaveLength(0);
  });

  it('hitTestPointShapeVertex returns the closest vertex within radius', () => {
    const shape = state.level.pointShapes![0];
    // point 0 is at (0,0), point 1 at (100,0)
    expect(state.hitTestPointShapeVertex(2, 2)).toEqual({ shapeId: shape.id, pointIndex: 0 });
    expect(state.hitTestPointShapeVertex(99, 1)).toEqual({ shapeId: shape.id, pointIndex: 1 });
    expect(state.hitTestPointShapeVertex(500, 500)).toBeNull();
  });

  it('deleting a trigger removes it and prunes plate bindings', () => {
    const shape = state.level.pointShapes![0];
    state.beginDraftTrigger();
    state.appendTriggerTargetAtVertex(shape.id, 0);
    state.advanceDraftTriggerPhase();
    state.commitDraftTrigger();
    const trig = state.level.triggers![0];

    state.addPressurePlate(0, 200);
    const plate = state.level.pressurePlates![0];
    state.togglePlateTriggerBinding(plate.id, trig.id);

    state.selectedElement = { type: 'trigger', id: trig.id };
    state.deleteSelected();

    expect(state.level.triggers).toHaveLength(0);
    expect(plate.triggerIds).not.toContain(trig.id);
  });
});

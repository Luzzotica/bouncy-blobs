//! egui panels, the canvas (pan / zoom / select / place / handles), the
//! overlay painter, and keyboard shortcuts.

use bb_level::*;
use bevy::prelude::{NextState, ResMut, Result};
use glam::{IVec2, Vec2};
use bevy_egui::EguiContexts;
use bevy_egui::egui::{self, Color32, Pos2, Stroke, UiBuilder};

use super::model::{self, Elem, PtKind};
use super::tools::{self, MoverPreset, Placement, Tool, ZonePreset};
use super::{Drag, Editor, library, storage};
use crate::flow::AppState;

// ------------------------------------------------------------------ view

/// World ↔ screen mapping that matches the game camera (`AutoMin`
/// 1500×860 scaled by `zoom`, centred on `pan`).
#[derive(Clone, Copy)]
struct View {
    c: Pos2,
    ppu: f32,
    pan: Vec2,
}

impl View {
    fn new(full: egui::Rect, ed: &Editor) -> View {
        let base = (full.width() / crate::camera::VIEW_W).min(full.height() / crate::camera::VIEW_H);
        View { c: full.center(), ppu: base / ed.zoom.max(1e-3), pan: ed.pan }
    }
    fn s(&self, p: Vec2) -> Pos2 {
        Pos2::new(self.c.x + (p.x - self.pan.x) * self.ppu, self.c.y - (p.y - self.pan.y) * self.ppu)
    }
    fn w(&self, s: Pos2) -> Vec2 {
        Vec2::new(self.pan.x + (s.x - self.c.x) / self.ppu, self.pan.y - (s.y - self.c.y) / self.ppu)
    }
}

const SEL: Color32 = Color32::from_rgb(255, 214, 64);
const HOVER: Color32 = Color32::from_rgba_premultiplied(255, 255, 255, 140);
const HANDLE: Color32 = Color32::WHITE;

fn elem_color(level: &Level, e: Elem) -> Color32 {
    match e {
        Elem::Spawn => Color32::from_rgb(120, 220, 255),
        Elem::Goal => Color32::from_rgb(255, 240, 150),
        Elem::Terrain(i) if level.terrain[i].one_way => Color32::from_rgb(200, 200, 140),
        Elem::Terrain(_) => Color32::from_rgb(170, 150, 190),
        Elem::Jelly(_) => Color32::from_rgb(150, 230, 170),
        Elem::Platform(_) => Color32::from_rgb(140, 220, 210),
        Elem::Prop(_) => Color32::from_rgb(255, 200, 120),
        Elem::Mover(_) => Color32::from_rgb(190, 200, 220),
        Elem::Rope(_) => Color32::from_rgb(140, 220, 110),
        Elem::Zone(i) => match level.zones[i].kind {
            ZoneKind::Kill => Color32::from_rgb(255, 90, 110),
            ZoneKind::Water { .. } => Color32::from_rgb(90, 170, 255),
            ZoneKind::Wind { .. } => Color32::from_rgb(220, 240, 255),
            ZoneKind::Conveyor { .. } => Color32::from_rgb(255, 210, 90),
            ZoneKind::Gravity { .. } => Color32::from_rgb(190, 140, 255),
            ZoneKind::Goo { .. } => Color32::from_rgb(140, 230, 90),
        },
        Elem::Spring(_) => Color32::from_rgb(255, 130, 180),
        Elem::Spikes(_) => Color32::from_rgb(230, 235, 255),
        Elem::Checkpoint(_) => Color32::from_rgb(255, 230, 120),
        Elem::Pickup(_) => Color32::from_rgb(255, 250, 180),
        Elem::Npc(_) => Color32::from_rgb(255, 160, 220),
        Elem::Hill(_) => Color32::from_rgb(255, 170, 80),
        Elem::Story(i) if level.story[i].script.starts_with("plate:") => Color32::from_rgb(255, 150, 60),
        Elem::Story(_) => Color32::from_rgb(120, 255, 230),
        Elem::Decor(_) => Color32::from_rgb(200, 200, 200),
    }
}

fn faded(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

/// Text label for region elements drawn on the canvas.
fn region_label(level: &Level, e: Elem) -> Option<String> {
    Some(match e {
        Elem::Goal => "GOAL".into(),
        Elem::Hill(_) => "HILL".into(),
        Elem::Zone(i) => match &level.zones[i].kind {
            ZoneKind::Kill => "KILL".into(),
            ZoneKind::Water { .. } => "WATER".into(),
            ZoneKind::Wind { accel } => format!("WIND {:.0},{:.0}", accel.x + 0.0, accel.y + 0.0),
            ZoneKind::Conveyor { speed } => format!("CONVEYOR {speed:.0}"),
            ZoneKind::Gravity { gravity } => format!("GRAVITY {:.0},{:.0}", gravity.x + 0.0, gravity.y + 0.0),
            ZoneKind::Goo { .. } => "GOO".into(),
        },
        Elem::Story(i) => level.story[i].script.clone(),
        _ => return None,
    })
}

fn elem_id(level: &Level, e: Elem) -> String {
    match e {
        Elem::Platform(i) => level.platforms[i].id.clone(),
        Elem::Prop(i) => level.props[i].id.clone(),
        Elem::Mover(i) => level.movers[i].id.clone(),
        Elem::Rope(i) => level.ropes[i].id.clone(),
        Elem::Zone(i) => level.zones[i].id.clone(),
        Elem::Npc(i) => level.npcs[i].id.clone(),
        Elem::Decor(i) => level.decor[i].kind.clone(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- entry

pub(super) fn editor_ui(
    mut contexts: EguiContexts,
    mut ed: ResMut<Editor>,
    mut next: ResMut<NextState<AppState>>,
) -> Result {
    let ctx = contexts.ctx_mut()?.clone();
    let ed = &mut *ed;
    ed.frames += 1;
    dev_hooks(ed);
    let full = ctx.viewport_rect();
    if ed.fit_pending && full.width() > 10.0 {
        ed.fit(Vec2::new(full.width(), full.height()));
        ed.fit_pending = false;
    }
    let mut root = egui::Ui::new(
        ctx.clone(),
        "bb_editor_root".into(),
        UiBuilder::new().layer_id(egui::LayerId::background()).max_rect(full),
    );
    top_bar(&mut root, ed, &mut next);
    status_bar(&mut root, ed);
    side_panel(&mut root, ed);
    egui::CentralPanel::no_frame().show(&mut root, |ui| canvas(ui, ed, full));
    open_dialog(&ctx, ed);
    shortcuts(&ctx, ed, full);
    Ok(())
}

/// A small "back to editor" chip while play-testing.
pub(super) fn playtest_hint(mut contexts: EguiContexts, mut ed: ResMut<Editor>) -> Result {
    if !ed.playtesting {
        return Ok(());
    }
    let ctx = contexts.ctx_mut()?.clone();
    egui::Area::new("bb_playtest_hint".into()).anchor(egui::Align2::LEFT_TOP, egui::vec2(10.0, 10.0)).show(&ctx, |ui| {
        egui::Frame::popup(ui.style()).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Play-test").strong());
                if ui.button("Back to editor (Esc)").clicked() {
                    ed.back_requested = true;
                }
            });
        });
    });
    Ok(())
}

/// Screenshot / automation hooks.
fn dev_hooks(ed: &mut Editor) {
    // `BB_EDIT_PLAY=<frame>` starts a play-test at that editor frame.
    if std::env::var("BB_EDIT_PLAY").ok().and_then(|s| s.parse::<u32>().ok()) == Some(ed.frames) {
        ed.request_play = true;
    }
    if ed.frames != 3 {
        return;
    }
    if let Ok(s) = std::env::var("BB_EDIT_SELECT") {
        let (kind, idx) = s.split_once(':').unwrap_or((s.as_str(), "0"));
        let i: usize = idx.parse().unwrap_or(0);
        let e = match kind {
            "spawn" => Elem::Spawn,
            "goal" => Elem::Goal,
            "terrain" => Elem::Terrain(i),
            "jelly" => Elem::Jelly(i),
            "platform" => Elem::Platform(i),
            "prop" => Elem::Prop(i),
            "mover" => Elem::Mover(i),
            "rope" => Elem::Rope(i),
            "zone" => Elem::Zone(i),
            "spring" => Elem::Spring(i),
            "spikes" => Elem::Spikes(i),
            "checkpoint" => Elem::Checkpoint(i),
            "pickup" => Elem::Pickup(i),
            "npc" => Elem::Npc(i),
            "hill" => Elem::Hill(i),
            "story" => Elem::Story(i),
            _ => Elem::Decor(i),
        };
        if model::exists(&ed.level, e) {
            ed.sel = vec![e];
        }
    }
    if let Some(t) = std::env::var("BB_EDIT_TOOL").ok().and_then(|t| Tool::ALL.into_iter().find(|x| x.name().eq_ignore_ascii_case(&t))) {
        ed.tool = t;
    }
}

// --------------------------------------------------------------- panels

fn top_bar(root: &mut egui::Ui, ed: &mut Editor, next: &mut NextState<AppState>) {
    egui::Panel::top("bb_editor_top").show(root, |ui| {
        egui::MenuBar::new().ui(ui, |ui| {
            ui.menu_button("File", |ui| {
                if ui.button("New level").clicked() {
                    ed.load(tools::starter_level(), None);
                    ed.status = "New level".into();
                }
                if ui.button("Open…").clicked() {
                    ed.open_dialog = true;
                }
                ui.separator();
                if ui.button("Save   Ctrl+S").clicked() {
                    ed.save();
                }
                if ui.button("Save as new map").clicked() {
                    ed.map_id = None;
                    ed.save();
                }
                ui.separator();
                if ui.button("Import JSON (v3 or legacy)…").clicked() {
                    ed.open_dialog = true;
                }
                if ui.button("Export JSON file").clicked() {
                    let id = if ed.level.id.is_empty() { ed.level.name.clone() } else { ed.level.id.clone() };
                    ed.status = match storage::export(&id, &ed.level.to_json()) {
                        Ok(p) => format!("Exported to {p}"),
                        Err(e) => format!("Export: {e}"),
                    };
                }
                if ui.button("Copy JSON to clipboard").clicked() {
                    ui.ctx().copy_text(ed.level.to_json());
                    ed.status = "Level JSON copied".into();
                }
            });
            ui.menu_button("Edit", |ui| {
                if ui.add_enabled(!ed.undo.is_empty(), egui::Button::new("Undo   Ctrl+Z")).clicked() {
                    ed.undo();
                }
                if ui.add_enabled(!ed.redo.is_empty(), egui::Button::new("Redo   Ctrl+Shift+Z")).clicked() {
                    ed.redo();
                }
                ui.separator();
                if ui.button("Duplicate   Ctrl+D").clicked() {
                    duplicate(ed);
                }
                if ui.button("Delete   Del").clicked() {
                    delete_selection(ed);
                }
                if ui.button("Select all   Ctrl+A").clicked() {
                    ed.sel = model::all(&ed.level).into_iter().filter(|e| *e != Elem::Spawn).collect();
                }
            });
            ui.menu_button("View", |ui| {
                ui.checkbox(&mut ed.show_grid, "Grid");
                ui.checkbox(&mut ed.snap, "Snap to grid");
                ui.checkbox(&mut ed.show_ids, "Labels (I)");
                ui.checkbox(&mut ed.animate, "Animate preview");
                if ui.button("Fit level   Home").clicked() {
                    ed.fit_pending = true;
                }
            });
            ui.separator();
            let undo = ui.add_enabled(!ed.undo.is_empty(), egui::Button::new("Undo")).on_hover_text("Ctrl/Cmd+Z");
            if undo.clicked() {
                ed.undo();
            }
            if ui.add_enabled(!ed.redo.is_empty(), egui::Button::new("Redo")).on_hover_text("Ctrl/Cmd+Shift+Z").clicked() {
                ed.redo();
            }
            ui.separator();
            ui.label("Grid");
            ui.add(egui::DragValue::new(&mut ed.grid).range(1.0..=400.0).speed(1.0));
            ui.checkbox(&mut ed.snap, "Snap");
            ui.separator();
            let play = egui::Button::new(egui::RichText::new("▶ Play").strong()).fill(Color32::from_rgb(40, 120, 70));
            if ui.add(play).on_hover_text("Play-test (Enter). Esc returns to the editor.").clicked() {
                ed.request_play = true;
            }
            if ui.button("Save").clicked() {
                ed.save();
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Exit").clicked() {
                    next.set(AppState::Title);
                }
                let title = format!("{}{}", ed.level.name, if ed.unsaved { " •" } else { "" });
                ui.label(egui::RichText::new(title).strong());
            });
        });
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 3.0;
            for t in Tool::ALL {
                let label = t.name();
                let hk = t.hotkey().unwrap_or("");
                let r = ui.selectable_label(ed.tool == t, label).on_hover_text(format!("{} ({hk})\n{}", t.name(), t.hint()));
                if r.clicked() {
                    set_tool(ed, t);
                }
            }
        });
    });
}

fn set_tool(ed: &mut Editor, t: Tool) {
    ed.tool = t;
    ed.draft.clear();
    ed.drag = None;
    match t {
        Tool::Zone if !matches!(ed.opts.zone, ZonePreset::Kill | ZonePreset::Gravity) => {}
        _ => {}
    }
}

fn status_bar(root: &mut egui::Ui, ed: &mut Editor) {
    egui::Panel::bottom("bb_editor_status").show(root, |ui| {
        ui.horizontal(|ui| {
            ui.monospace(format!("{:>7.0},{:>7.0}", ed.cursor.x, ed.cursor.y));
            ui.separator();
            ui.label(format!("Tool: {}", ed.tool.name()));
            ui.separator();
            if !ed.status.is_empty() {
                ui.label(&ed.status);
            } else {
                ui.label(egui::RichText::new(ed.tool.hint()).weak());
            }
        });
    });
}

fn side_panel(root: &mut egui::Ui, ed: &mut Editor) {
    egui::Panel::right("bb_editor_props").default_size(290.0).min_size(240.0).show(root, |ui| {
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            if ed.tool != Tool::Select {
                tool_options(ui, ed);
                ui.separator();
            }
            let before = ed.level.clone();
            let mut changed = false;
            let mut action = None;
            match ed.sel.len() {
                0 => changed |= level_settings(ui, ed),
                1 => {
                    let e = ed.sel[0];
                    if model::exists(&ed.level, e) {
                        ui.heading(e.label());
                        let (c, a) = properties(ui, &mut ed.level, e, ed.sel_vertex);
                        changed |= c;
                        action = a;
                    }
                }
                n => {
                    ui.heading(format!("{n} selected"));
                    ui.horizontal(|ui| {
                        if ui.button("Duplicate").clicked() {
                            action = Some(Act::Duplicate);
                        }
                        if ui.button("Delete").clicked() {
                            action = Some(Act::Delete);
                        }
                    });
                    for e in ed.sel.clone() {
                        ui.label(format!("• {} {}", e.label(), e.index().map(|i| format!("#{i}")).unwrap_or_default()));
                    }
                }
            }
            if changed {
                if ed.panel_edit_frame + 1 < ed.frames {
                    ed.push_undo(before);
                } else {
                    ed.touch();
                }
                ed.panel_edit_frame = ed.frames;
            }
            if let Some(a) = action {
                apply_act(ed, a);
            }
            ui.separator();
            outliner(ui, ed);
        });
    });
}

enum Act {
    Duplicate,
    Delete,
    ToPoly,
    DeleteVertex,
    AddWaypoint,
}

fn apply_act(ed: &mut Editor, a: Act) {
    match a {
        Act::Duplicate => duplicate(ed),
        Act::Delete => delete_selection(ed),
        Act::ToPoly => {
            if let Some(&e) = ed.sel.first() {
                ed.edit(|l| {
                    model::to_poly(l, e);
                });
            }
        }
        Act::DeleteVertex => {
            if let (Some(&e), Some(v)) = (ed.sel.first(), ed.sel_vertex) {
                let mut l = ed.level.clone();
                if model::delete_vertex(&mut l, e, v) {
                    let before = std::mem::replace(&mut ed.level, l);
                    ed.push_undo(before);
                    ed.sel_vertex = None;
                }
            }
        }
        Act::AddWaypoint => {
            if let Some(&Elem::Mover(i)) = ed.sel.first() {
                ed.edit(|l| {
                    let m = &mut l.movers[i];
                    if m.path.is_empty() {
                        m.path.push(Vec2::ZERO);
                    }
                    let last = *m.path.last().unwrap();
                    m.path.push(last + Vec2::new(200.0, 0.0));
                });
            }
        }
    }
}

fn tool_options(ui: &mut egui::Ui, ed: &mut Editor) {
    let o = &mut ed.opts;
    ui.heading(ed.tool.name());
    ui.label(egui::RichText::new(ed.tool.hint()).weak());
    match ed.tool {
        Tool::TerrainRect | Tool::TerrainPoly => {
            material_ui(ui, &mut o.material);
            ui.checkbox(&mut o.one_way, "One-way (jump up through)");
        }
        Tool::Ground => {
            material_ui(ui, &mut o.material);
            num(ui, "Depth", &mut o.ground_depth, 5.0, 40.0..=3000.0);
            num(ui, "Wobble", &mut o.wobble, 0.01, 0.0..=1.0);
        }
        Tool::Jelly => {
            material_ui(ui, &mut o.material);
            num(ui, "Wobble", &mut o.wobble, 0.01, 0.0..=1.0);
        }
        Tool::SoftPlatform => {
            material_ui(ui, &mut o.material);
            pins_ui(ui, &mut o.pins);
        }
        Tool::Prop => {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut o.prop_kind, 0, "Block");
                ui.selectable_value(&mut o.prop_kind, 1, "Ball");
                ui.selectable_value(&mut o.prop_kind, 2, "Star");
            });
            material_ui(ui, &mut o.material);
        }
        Tool::Mover => {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut o.mover, MoverPreset::Elevator, "Elevator");
                ui.selectable_value(&mut o.mover, MoverPreset::Crusher, "Crusher");
                ui.selectable_value(&mut o.mover, MoverPreset::Spinner, "Spinner");
                ui.selectable_value(&mut o.mover, MoverPreset::Loop, "Loop");
            });
        }
        Tool::Zone => {
            ui.horizontal_wrapped(|ui| {
                for z in ZonePreset::ALL {
                    ui.selectable_value(&mut o.zone, z, z.name());
                }
            });
        }
        Tool::Rope => {
            rope_style_ui(ui, &mut o.rope_style);
            ui.label(egui::RichText::new("Vines dangle free; start or end on a prop / soft platform to tie it.").weak());
        }
        Tool::Npc => {
            role_ui(ui, &mut o.npc_role);
        }
        Tool::Decor => {
            decor_ui(ui, &mut o.decor);
        }
        _ => {}
    }
    ui.checkbox(&mut o.keep_tool, "Keep tool after placing");
}

// ---------------------------------------------------------- prop widgets

fn num(ui: &mut egui::Ui, label: &str, v: &mut f32, speed: f64, range: std::ops::RangeInclusive<f32>) -> bool {
    ui.horizontal(|ui| {
        ui.label(label);
        ui.add(egui::DragValue::new(v).speed(speed).range(range)).changed()
    })
    .inner
}

fn vec2(ui: &mut egui::Ui, label: &str, v: &mut Vec2, speed: f64) -> bool {
    ui.horizontal(|ui| {
        ui.label(label);
        let a = ui.add(egui::DragValue::new(&mut v.x).speed(speed).prefix("x ")).changed();
        let b = ui.add(egui::DragValue::new(&mut v.y).speed(speed).prefix("y ")).changed();
        a || b
    })
    .inner
}

fn angle(ui: &mut egui::Ui, label: &str, rad: &mut f32) -> bool {
    ui.horizontal(|ui| {
        ui.label(label);
        let mut deg = rad.to_degrees();
        let r = ui.add(egui::DragValue::new(&mut deg).speed(1.0).suffix("°"));
        if r.changed() {
            *rad = deg.to_radians();
        }
        r.changed()
    })
    .inner
}

fn text(ui: &mut egui::Ui, label: &str, s: &mut String) -> bool {
    ui.horizontal(|ui| {
        ui.label(label);
        ui.text_edit_singleline(s).changed()
    })
    .inner
}

fn combo<T: PartialEq + Clone>(ui: &mut egui::Ui, label: &str, v: &mut T, opts: &[(T, &str)]) -> bool {
    let cur = opts.iter().find(|(o, _)| o == v).map(|(_, n)| *n).unwrap_or("?");
    let mut changed = false;
    ui.horizontal(|ui| {
        ui.label(label);
        egui::ComboBox::from_id_salt(label).selected_text(cur).show_ui(ui, |ui| {
            for (o, n) in opts {
                if ui.selectable_label(v == o, *n).clicked() && v != o {
                    *v = o.clone();
                    changed = true;
                }
            }
        });
    });
    changed
}

fn material_ui(ui: &mut egui::Ui, m: &mut Material) -> bool {
    combo(
        ui,
        "Material",
        m,
        &[
            (Material::Ground, "Ground"),
            (Material::Stone, "Stone"),
            (Material::Ice, "Ice"),
            (Material::Sticky, "Sticky"),
            (Material::Bouncy, "Bouncy"),
        ],
    )
}

fn pins_ui(ui: &mut egui::Ui, p: &mut Pins) -> bool {
    combo(
        ui,
        "Pins",
        p,
        &[
            (Pins::Ends, "Ends (bridge)"),
            (Pins::Left, "Left"),
            (Pins::Right, "Right"),
            (Pins::Corners, "Corners"),
            (Pins::Top, "Top (curtain)"),
            (Pins::Home, "Home (floating slab)"),
            (Pins::None, "None (falls)"),
        ],
    )
}

fn rope_style_ui(ui: &mut egui::Ui, s: &mut RopeStyle) -> bool {
    combo(ui, "Style", s, &[(RopeStyle::Vine, "Vine"), (RopeStyle::Rope, "Rope"), (RopeStyle::Chain, "Chain"), (RopeStyle::Slinky, "Slinky")])
}

fn role_ui(ui: &mut egui::Ui, r: &mut NpcRole) -> bool {
    combo(
        ui,
        "Role",
        r,
        &[
            (NpcRole::Huddle, "Huddle"),
            (NpcRole::Trapped, "Trapped"),
            (NpcRole::Follower, "Follower"),
            (NpcRole::Wanderer, "Wanderer"),
            (NpcRole::Glimmer, "Glimmer"),
            (NpcRole::Granny, "Granny"),
            (NpcRole::Reg, "Reg"),
        ],
    )
}

fn decor_ui(ui: &mut egui::Ui, k: &mut String) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        ui.label("Kind");
        egui::ComboBox::from_id_salt("decor_kind").selected_text(k.as_str()).show_ui(ui, |ui| {
            for d in tools::DECOR_KINDS {
                if ui.selectable_label(k == d, d).clicked() {
                    *k = d.to_string();
                    changed = true;
                }
            }
        });
        changed |= ui.text_edit_singleline(k).changed();
    });
    changed
}

fn color_ui(ui: &mut egui::Ui, hex: &mut String) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        ui.label("Colour");
        let mut rgb = bb_sim::parse_color(hex).map(|c| [(c >> 16) as u8, (c >> 8) as u8, c as u8]).unwrap_or([200, 200, 200]);
        if ui.color_edit_button_srgb(&mut rgb).changed() {
            *hex = format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]);
            changed = true;
        }
        changed |= ui.add(egui::TextEdit::singleline(hex).desired_width(80.0)).changed();
        if ui.small_button("theme").on_hover_text("Use the theme colour").clicked() {
            hex.clear();
            changed = true;
        }
    });
    changed
}

fn shape_ui(ui: &mut egui::Ui, s: &mut Shape) -> bool {
    match s {
        Shape::Rect { center, size, angle: a } => {
            let mut c = vec2(ui, "Centre", center, 1.0);
            c |= vec2(ui, "Size", size, 1.0);
            *size = size.max(Vec2::splat(1.0));
            c | angle(ui, "Angle", a)
        }
        Shape::Circle { center, radius } => vec2(ui, "Centre", center, 1.0) | num(ui, "Radius", radius, 1.0, 1.0..=5000.0),
        Shape::Poly { points } => {
            let mut c = Shape::Poly { points: points.clone() }.center();
            let old = c;
            ui.label(format!("Polygon, {} points (drag the squares; double-click an edge to add)", points.len()));
            let ch = vec2(ui, "Centre", &mut c, 1.0);
            if ch {
                for p in points.iter_mut() {
                    *p += c - old;
                }
            }
            ch
        }
    }
}

fn zone_kind_ui(ui: &mut egui::Ui, k: &mut ZoneKind) -> bool {
    let cur = match k {
        ZoneKind::Wind { .. } => ZonePreset::Wind,
        ZoneKind::Water { .. } => ZonePreset::Water,
        ZoneKind::Kill => ZonePreset::Kill,
        ZoneKind::Conveyor { .. } => ZonePreset::Conveyor,
        ZoneKind::Gravity { .. } => ZonePreset::Gravity,
        ZoneKind::Goo { .. } => ZonePreset::Goo,
    };
    let mut sel = cur;
    let opts: Vec<(ZonePreset, &str)> = ZonePreset::ALL.iter().map(|z| (*z, z.name())).collect();
    let mut changed = combo(ui, "Kind", &mut sel, &opts);
    if changed {
        *k = sel.kind();
    }
    changed |= match k {
        ZoneKind::Wind { accel } => vec2(ui, "Accel", accel, 10.0),
        ZoneKind::Water { buoyancy, drag, current } => {
            num(ui, "Buoyancy", buoyancy, 10.0, 0.0..=20000.0) | num(ui, "Drag", drag, 0.05, 0.0..=50.0) | vec2(ui, "Current", current, 5.0)
        }
        ZoneKind::Kill => false,
        ZoneKind::Conveyor { speed } => num(ui, "Speed", speed, 5.0, -3000.0..=3000.0),
        ZoneKind::Gravity { gravity } => vec2(ui, "Gravity", gravity, 10.0),
        ZoneKind::Goo { drag } => num(ui, "Drag", drag, 0.1, 0.0..=100.0),
    };
    changed
}

fn rope_end_ui(ui: &mut egui::Ui, label: &str, end: &mut RopeEnd, fallback: Vec2) -> bool {
    let kind = match end {
        RopeEnd::World { .. } => 0,
        RopeEnd::Body { .. } => 1,
        RopeEnd::Free { .. } => 2,
    };
    let mut k = kind;
    let mut changed = combo(ui, label, &mut k, &[(0, "Fixed point"), (1, "Body id"), (2, "Free end")]);
    if changed {
        *end = match k {
            0 => RopeEnd::World { at: fallback },
            1 => RopeEnd::Body { id: String::new() },
            _ => RopeEnd::Free { at: fallback },
        };
    }
    changed |= match end {
        RopeEnd::World { at } | RopeEnd::Free { at } => vec2(ui, "  at", at, 1.0),
        RopeEnd::Body { id } => text(ui, "  id", id),
    };
    changed
}

/// Properties of one element. Returns (changed, action).
fn properties(ui: &mut egui::Ui, l: &mut Level, e: Elem, vertex: Option<usize>) -> (bool, Option<Act>) {
    let mut c = false;
    let mut act = None;
    let rope_fallback = |l: &Level, end: &RopeEnd| model::rope_end_pos(l, end).unwrap_or(Vec2::ZERO);
    match e {
        Elem::Spawn => {
            c |= vec2(ui, "Position", &mut l.spawn, 1.0);
        }
        Elem::Goal => {
            if let Some(g) = l.goal.as_mut() {
                c |= shape_ui(ui, g);
            }
        }
        Elem::Hill(i) => c |= shape_ui(ui, &mut l.hills[i]),
        Elem::Terrain(i) => {
            let t = &mut l.terrain[i];
            c |= shape_ui(ui, &mut t.shape);
            c |= material_ui(ui, &mut t.material);
            c |= ui.checkbox(&mut t.one_way, "One-way").changed();
        }
        Elem::Jelly(i) => {
            let t = &mut l.jelly[i];
            c |= shape_ui(ui, &mut t.shape);
            c |= material_ui(ui, &mut t.material);
            c |= num(ui, "Wobble", &mut t.wobble, 0.01, 0.0..=1.0);
        }
        Elem::Platform(i) => {
            let p = &mut l.platforms[i];
            c |= text(ui, "Id", &mut p.id);
            c |= vec2(ui, "Centre", &mut p.center, 1.0);
            c |= vec2(ui, "Size", &mut p.size, 1.0);
            p.size = p.size.max(Vec2::splat(4.0));
            c |= angle(ui, "Angle", &mut p.angle);
            c |= pins_ui(ui, &mut p.pins);
            c |= num(ui, "Stiffness", &mut p.stiffness, 0.01, 0.0..=1.0);
            c |= material_ui(ui, &mut p.material);
        }
        Elem::Prop(i) => {
            let p = &mut l.props[i];
            c |= text(ui, "Id", &mut p.id);
            let mut k: u8 = match p.kind {
                PropKind::Block => 0,
                PropKind::Ball => 1,
                PropKind::Star => 2,
                PropKind::Custom { .. } => 3,
            };
            if combo(ui, "Kind", &mut k, &[(0, "Block"), (1, "Ball"), (2, "Star"), (3, "Custom")]) {
                p.kind = match k {
                    0 => PropKind::Block,
                    1 => PropKind::Ball,
                    2 => PropKind::Star,
                    _ => PropKind::Custom { outline: Shape::rect_at(Vec2::ZERO, p.size, 0.0).outline() },
                };
                c = true;
            }
            c |= vec2(ui, "Centre", &mut p.center, 1.0);
            c |= vec2(ui, "Size", &mut p.size, 1.0);
            p.size = p.size.max(Vec2::splat(4.0));
            c |= angle(ui, "Angle", &mut p.angle);
            c |= num(ui, "Mass", &mut p.mass, 0.05, 0.05..=100.0);
            c |= material_ui(ui, &mut p.material);
            c |= color_ui(ui, &mut p.color);
            c |= ui.checkbox(&mut p.pinned, "Pinned (anchored home)").changed();
        }
        Elem::Mover(i) => {
            let m = &mut l.movers[i];
            c |= text(ui, "Id", &mut m.id);
            c |= shape_ui(ui, &mut m.shape);
            let mut k: u8 = match m.motion {
                MoverMotion::Loop => 0,
                MoverMotion::PingPong => 1,
                MoverMotion::Crusher { .. } => 2,
                MoverMotion::Spin { .. } => 3,
                MoverMotion::Lift { .. } => 4,
            };
            if combo(ui, "Motion", &mut k, &[(0, "Loop"), (1, "Ping-pong"), (2, "Crusher"), (3, "Spin"), (4, "Lift (pauses)")]) {
                m.motion = match k {
                    0 => MoverMotion::Loop,
                    1 => MoverMotion::PingPong,
                    2 => MoverMotion::Crusher { slam: 0.25, hold: 0.4, rise: 1.2, wait: 1.0 },
                    4 => MoverMotion::Lift { hold: 1.2 },
                    _ => MoverMotion::Spin { speed: 1.5 },
                };
                c = true;
            }
            match &mut m.motion {
                MoverMotion::Crusher { slam, hold, rise, wait } => {
                    c |= num(ui, "Slam s", slam, 0.01, 0.01..=10.0);
                    c |= num(ui, "Hold s", hold, 0.01, 0.0..=10.0);
                    c |= num(ui, "Rise s", rise, 0.01, 0.01..=10.0);
                    c |= num(ui, "Wait s", wait, 0.01, 0.0..=10.0);
                }
                MoverMotion::Spin { speed } => c |= num(ui, "Speed rad/s", speed, 0.05, -20.0..=20.0),
                MoverMotion::Lift { hold } => {
                    c |= num(ui, "Hold s", hold, 0.05, 0.0..=10.0);
                    c |= num(ui, "Travel s", &mut m.period, 0.05, 0.1..=60.0);
                }
                _ => {
                    c |= num(ui, "Period s", &mut m.period, 0.05, 0.05..=120.0);
                }
            }
            c |= num(ui, "Phase", &mut m.phase, 0.01, 0.0..=1.0);
            c |= material_ui(ui, &mut m.material);
            c |= text(ui, "Trigger", &mut m.trigger);
            ui.label(egui::RichText::new("Plate ids: a|b any, a&b all; #toggle / #once. Empty = always moving.").weak().small());
            ui.label(format!("Path: {} waypoints (drag the diamonds)", m.path.len()));
            if ui.button("Add waypoint").clicked() {
                act = Some(Act::AddWaypoint);
            }
        }
        Elem::Rope(i) => {
            let (fa, fb) = (rope_fallback(l, &l.ropes[i].from), rope_fallback(l, &l.ropes[i].to));
            let r = &mut l.ropes[i];
            c |= text(ui, "Id", &mut r.id);
            c |= rope_end_ui(ui, "From", &mut r.from, fa);
            c |= rope_end_ui(ui, "To", &mut r.to, fb);
            c |= num(ui, "Length (0 = span)", &mut r.length, 1.0, 0.0..=10000.0);
            c |= rope_style_ui(ui, &mut r.style);
            c |= ui.checkbox(&mut r.grabbable, "Grabbable").changed();
        }
        Elem::Zone(i) => {
            let z = &mut l.zones[i];
            c |= text(ui, "Id", &mut z.id);
            c |= shape_ui(ui, &mut z.shape);
            c |= zone_kind_ui(ui, &mut z.kind);
        }
        Elem::Spring(i) => {
            let s = &mut l.springs[i];
            c |= vec2(ui, "Position", &mut s.pos, 1.0);
            c |= angle(ui, "Launch dir", &mut s.angle);
            c |= num(ui, "Width", &mut s.width, 1.0, 20.0..=600.0);
            c |= num(ui, "Power px/s", &mut s.power, 10.0, 100.0..=6000.0);
            ui.horizontal(|ui| {
                for (n, w) in [("S", 60.0), ("M", 90.0), ("L", 130.0)] {
                    if ui.button(n).on_hover_text("Size preset (S / Shift+S)").clicked() {
                        s.width = w;
                        c = true;
                    }
                }
            });
        }
        Elem::Spikes(i) => {
            let s = &mut l.spikes[i];
            c |= vec2(ui, "A", &mut s.a, 1.0);
            c |= vec2(ui, "B", &mut s.b, 1.0);
            ui.label(egui::RichText::new("Teeth point to the left of A→B.").weak().small());
            if ui.button("Flip").clicked() {
                std::mem::swap(&mut s.a, &mut s.b);
                c = true;
            }
        }
        Elem::Checkpoint(i) => c |= vec2(ui, "Position", &mut l.checkpoints[i].pos, 1.0),
        Elem::Pickup(i) => c |= vec2(ui, "Position", &mut l.pickups[i], 1.0),
        Elem::Npc(i) => {
            let n = &mut l.npcs[i];
            c |= text(ui, "Id", &mut n.id);
            c |= vec2(ui, "Position", &mut n.pos, 1.0);
            c |= role_ui(ui, &mut n.role);
            c |= num(ui, "Radius", &mut n.radius, 0.5, 10.0..=200.0);
            c |= color_ui(ui, &mut n.color);
        }
        Elem::Story(i) => {
            let s = &mut l.story[i];
            c |= shape_ui(ui, &mut s.shape);
            c |= text(ui, "Script", &mut s.script);
            c |= ui.checkbox(&mut s.once, "Once").changed();
            ui.label(egui::RichText::new("Script `plate:<id>` makes a pressure plate for movers.").weak().small());
        }
        Elem::Decor(i) => {
            let d = &mut l.decor[i];
            c |= decor_ui(ui, &mut d.kind);
            c |= vec2(ui, "Position", &mut d.pos, 1.0);
            c |= num(ui, "Scale", &mut d.scale, 0.01, 0.05..=20.0);
            c |= angle(ui, "Angle", &mut d.angle);
            c |= num(ui, "Depth (−back / +front)", &mut d.depth, 0.1, -10.0..=10.0);
        }
    }
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        if e != Elem::Spawn {
            if ui.button("Duplicate").clicked() {
                act = Some(Act::Duplicate);
            }
            if ui.button("Delete").clicked() {
                act = Some(Act::Delete);
            }
        }
        if matches!(model::shape(l, e), Some(Shape::Rect { .. } | Shape::Circle { .. })) && ui.button("To polygon").clicked() {
            act = Some(Act::ToPoly);
        }
    });
    if let Some(v) = vertex {
        let pts = model::points(l, e);
        if let Some((p, k)) = pts.get(v).copied() {
            ui.separator();
            ui.label(format!("{} #{v}", if k == PtKind::Path { "Waypoint" } else { "Vertex" }));
            let mut q = p;
            if vec2(ui, "Point", &mut q, 1.0) {
                model::set_point(l, e, v, q);
                c = true;
            }
            if k != PtKind::End && ui.button("Delete point (Del)").clicked() {
                act = Some(Act::DeleteVertex);
            }
        }
    }
    (c, act)
}

fn level_settings(ui: &mut egui::Ui, ed: &mut Editor) -> bool {
    let mut c = false;
    ui.heading("Level");
    let l = &mut ed.level;
    c |= text(ui, "Name", &mut l.name);
    c |= text(ui, "Id", &mut l.id);
    let themes = [
        (Theme::Hollow, "Hollow"),
        (Theme::Drip, "Drip"),
        (Theme::Fungus, "Fungus"),
        (Theme::Vines, "Vines"),
        (Theme::Stoneworks, "Stoneworks"),
        (Theme::Lake, "Lake"),
        (Theme::Chimney, "Chimney"),
        (Theme::Toys, "Toys"),
        (Theme::CaveIn, "Cave-in"),
        (Theme::Well, "Well"),
        (Theme::Playroom, "Playroom"),
        (Theme::Kids, "Kids"),
        (Theme::Party, "Party"),
    ];
    c |= combo(ui, "Theme", &mut l.theme, &themes);
    ui.horizontal_wrapped(|ui| {
        ui.label("Modes");
        for (m, n) in [(Mode::Story, "Story"), (Mode::Race, "Race"), (Mode::Koth, "KOTH"), (Mode::Kids, "Kids"), (Mode::Sandbox, "Sandbox")] {
            let mut on = l.modes.contains(&m);
            if ui.checkbox(&mut on, n).changed() {
                if on {
                    l.modes.push(m);
                } else if l.modes.len() > 1 {
                    l.modes.retain(|x| *x != m);
                }
                c = true;
            }
        }
    });
    let warn = |ui: &mut egui::Ui, s: &str| ui.colored_label(Color32::from_rgb(255, 170, 80), format!("⚠ {s}"));
    if l.modes.contains(&Mode::Race) && l.goal.is_none() {
        warn(ui, "Race needs a goal");
    }
    if l.modes.contains(&Mode::Koth) && l.hills.is_empty() {
        warn(ui, "KOTH needs a hill");
    }
    c |= vec2(ui, "Spawn", &mut l.spawn, 1.0);
    ui.horizontal(|ui| {
        ui.label("Kill y");
        c |= ui.add(egui::DragValue::new(&mut l.kill_y).speed(5.0)).changed();
        if ui.button("Auto").on_hover_text("Lowest geometry − 200").clicked() {
            l.kill_y = l.bounds().0.y - 200.0;
            c = true;
        }
    });
    let mut has_g = l.gravity.is_some();
    if ui.checkbox(&mut has_g, "Custom gravity").changed() {
        l.gravity = has_g.then_some(Vec2::new(0.0, -1800.0));
        c = true;
    }
    if let Some(g) = l.gravity.as_mut() {
        c |= vec2(ui, "  gravity", g, 10.0);
    }
    c |= text(ui, "Intro cutscene", &mut l.intro);
    c |= text(ui, "Outro cutscene", &mut l.outro);
    ui.label(format!(
        "{} terrain · {} jelly · {} platforms · {} props · {} movers · {} ropes · {} zones",
        l.terrain.len(),
        l.jelly.len(),
        l.platforms.len(),
        l.props.len(),
        l.movers.len(),
        l.ropes.len(),
        l.zones.len()
    ));
    ui.label(egui::RichText::new(format!("Maps folder: {}", storage::location())).weak().small());
    if !ed.notes.is_empty() {
        egui::CollapsingHeader::new(format!("Import notes ({})", ed.notes.len())).show(ui, |ui| {
            for n in &ed.notes {
                ui.label(egui::RichText::new(format!("• {n}")).small());
            }
        });
    }
    ui.separator();
    ui.label(egui::RichText::new(SHORTCUTS).weak().small());
    c
}

const SHORTCUTS: &str = "Tools: 1 select, 2 block, Q poly, F ground, J jelly, R soft platform, P prop, E mover, C rope, G zone (gravity), D kill zone, 5 spring, 6 spikes, K checkpoint, 9 pickup, 4 NPC, 7 goal, 8 hill, W story, T decor, 3 spawn.\n\
R / Shift+R rotate 15°. S / Shift+S spring size. Del delete. Ctrl+D duplicate. Ctrl+C / X / V. Ctrl+Z, Ctrl+Shift+Z undo / redo. Arrows nudge. Enter play (or finish a shape). Esc cancel. I labels. B / N / M blob ghost. Home fit. Wheel or pinch zoom; middle, right or Space-drag pans.";

fn outliner(ui: &mut egui::Ui, ed: &mut Editor) {
    egui::CollapsingHeader::new("Outliner").default_open(false).show(ui, |ui| {
        let all = model::all(&ed.level);
        for e in all {
            let id = elem_id(&ed.level, e);
            let label = format!("{} {} {}", e.label(), e.index().map(|i| format!("#{i}")).unwrap_or_default(), id);
            let on = ed.sel.contains(&e);
            if ui.selectable_label(on, label).clicked() {
                ed.sel = vec![e];
                ed.sel_vertex = None;
                ed.pan = model::center(&ed.level, e);
            }
        }
    });
}

fn open_dialog(ctx: &egui::Context, ed: &mut Editor) {
    if !ed.open_dialog {
        return;
    }
    let mut open = true;
    let mut chosen: Option<Box<dyn FnOnce(&mut Editor)>> = None;
    egui::Window::new("Open level").open(&mut open).default_width(460.0).default_height(520.0).show(ctx, |ui| {
        egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
            ui.heading("Your maps");
            let maps = storage::list();
            if maps.is_empty() {
                ui.label(egui::RichText::new("No saved maps yet.").weak());
            }
            for m in maps {
                ui.horizontal(|ui| {
                    if ui.button(format!("{}  ({})", m.name, m.id)).clicked() {
                        let id = m.id.clone();
                        chosen = Some(Box::new(move |ed: &mut Editor| match storage::load(&id) {
                            Ok(l) => {
                                ed.load(l, Some(id.clone()));
                                ed.status = format!("Opened {id}");
                            }
                            Err(e) => ed.status = format!("Open failed: {e}"),
                        }));
                    }
                    if ui.small_button("Delete").on_hover_text("Delete this local map").clicked() {
                        let id = m.id.clone();
                        chosen = Some(Box::new(move |ed: &mut Editor| {
                            ed.status = match storage::delete(&id) {
                                Ok(()) => format!("Deleted {id}"),
                                Err(e) => format!("Delete failed: {e}"),
                            };
                            if ed.map_id.as_deref() == Some(id.as_str()) {
                                ed.map_id = None;
                            }
                            ed.open_dialog = true;
                        }));
                    }
                });
            }
            ui.separator();
            ui.heading("Built-in party levels (opens a copy)");
            ui.horizontal_wrapped(|ui| {
                for b in library::PARTY_LEVELS {
                    let label = if b.hidden { format!("{} (hidden)", b.name) } else { b.name.to_string() };
                    if ui.button(label).clicked() {
                        let id = b.id;
                        chosen = Some(Box::new(move |ed: &mut Editor| {
                            if let Some(mut l) = library::party_level(id) {
                                l.name = format!("{} (Copy)", l.name);
                                ed.load(l, None);
                                ed.unsaved = true;
                                ed.status = format!("Opened a copy of {id}");
                            }
                        }));
                    }
                }
            });
        });
        ui.separator();
        ui.heading("Import");
        ui.label(egui::RichText::new("Drop a .json file (v3 or legacy) on the window, enter a path, or paste JSON (Ctrl/Cmd+V on the canvas also works).").weak());
        ui.horizontal(|ui| {
            ui.label("Path");
            ui.text_edit_singleline(&mut ed.path_text);
            if ui.button("Import").clicked() {
                let p = ed.path_text.clone();
                chosen = Some(Box::new(move |ed: &mut Editor| match storage::read_path(&p) {
                    Ok(t) => ed.import_json(&t, &p),
                    Err(e) => ed.status = format!("Import failed: {e}"),
                }));
            }
        });
        ui.add(egui::TextEdit::multiline(&mut ed.import_text).desired_rows(3).hint_text("…or paste level JSON here"));
        if ui.button("Import pasted JSON").clicked() {
            let t = std::mem::take(&mut ed.import_text);
            chosen = Some(Box::new(move |ed: &mut Editor| ed.import_json(&t, "pasted JSON")));
        }
    });
    ed.open_dialog = open;
    if let Some(f) = chosen {
        ed.open_dialog = false;
        f(ed);
    }
}

// --------------------------------------------------------------- editing

fn duplicate(ed: &mut Editor) {
    let items: Vec<model::Item> =
        ed.sel.iter().filter(|e| **e != Elem::Spawn && **e != Elem::Goal).filter_map(|e| model::copy(&ed.level, *e)).collect();
    if items.is_empty() {
        return;
    }
    let off = Vec2::splat(ed.grid.max(10.0) * 2.0);
    let before = ed.level.clone();
    let mut sel = Vec::new();
    for mut it in items {
        model::translate_item(&mut it, off);
        sel.push(model::add(&mut ed.level, it));
    }
    ed.push_undo(before);
    ed.sel = sel;
    ed.sel_vertex = None;
}

fn delete_selection(ed: &mut Editor) {
    if let (Some(v), [e]) = (ed.sel_vertex, ed.sel.as_slice()) {
        let e = *e;
        let mut l = ed.level.clone();
        if model::delete_vertex(&mut l, e, v) {
            let before = std::mem::replace(&mut ed.level, l);
            ed.push_undo(before);
            ed.sel_vertex = None;
            return;
        }
    }
    let sel = std::mem::take(&mut ed.sel);
    if sel.iter().all(|e| *e == Elem::Spawn) {
        ed.sel = sel;
        return;
    }
    ed.edit(|l| model::delete(l, &sel));
    ed.sel_vertex = None;
}

fn copy_selection(ed: &mut Editor) {
    ed.clipboard = ed.sel.iter().filter(|e| **e != Elem::Spawn).filter_map(|e| model::copy(&ed.level, *e)).collect();
    ed.status = format!("Copied {} element(s)", ed.clipboard.len());
}

fn paste(ed: &mut Editor, text: Option<&str>) {
    if let Some(t) = text {
        let t = t.trim();
        if t.starts_with('{') && (bb_level::legacy::is_legacy(t) || Level::from_json(t).is_ok()) {
            ed.import_json(t, "clipboard");
            return;
        }
    }
    if ed.clipboard.is_empty() {
        return;
    }
    // Centre the group on the cursor.
    let mut tmp = Level::new("tmp", "tmp");
    let es: Vec<Elem> = ed.clipboard.iter().map(|it| model::add(&mut tmp, it.clone())).collect();
    let (mut min, mut max) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
    for e in &es {
        let (a, b) = model::bounds(&tmp, *e);
        min = min.min(a);
        max = max.max(b);
    }
    let d = ed.snap_pt(ed.cursor - (min + max) * 0.5);
    let before = ed.level.clone();
    let mut sel = Vec::new();
    for mut it in ed.clipboard.clone() {
        model::translate_item(&mut it, d);
        sel.push(model::add(&mut ed.level, it));
    }
    ed.push_undo(before);
    ed.sel = sel;
}

fn rotate_selection(ed: &mut Editor, by: f32) -> bool {
    let rot: Vec<Elem> = ed.sel.iter().copied().filter(|e| model::rotatable(&ed.level, *e)).collect();
    if rot.is_empty() {
        return false;
    }
    ed.edit(|l| {
        for e in &rot {
            model::rotate(l, *e, by);
        }
    });
    true
}

fn nudge(ed: &mut Editor, d: Vec2) {
    if ed.sel.is_empty() {
        ed.pan += d * 10.0;
        return;
    }
    let sel = ed.sel.clone();
    ed.edit(|l| {
        for e in &sel {
            model::translate(l, *e, d);
        }
    });
}

fn finish_draft(ed: &mut Editor) {
    let mut pts: Vec<Vec2> = Vec::new();
    for p in std::mem::take(&mut ed.draft) {
        if pts.last().is_none_or(|q: &Vec2| q.distance(p) > 2.0) {
            pts.push(p);
        }
    }
    if let Placement::Polyline { closed, min } = ed.tool.placement() {
        if closed && pts.len() > 3 && pts[0].distance(pts[pts.len() - 1]) < 2.0 {
            pts.pop();
        }
        if pts.len() >= min {
            place(ed, &pts);
        } else {
            ed.status = format!("Need at least {min} points");
        }
    }
}

fn place(ed: &mut Editor, pts: &[Vec2]) {
    let before = ed.level.clone();
    let made = tools::create(&mut ed.level, ed.tool, &ed.opts, pts);
    if made.is_empty() {
        return;
    }
    ed.push_undo(before);
    ed.status = format!("Added {}", made[0].label());
    ed.sel = made;
    ed.sel_vertex = None;
    if !ed.opts.keep_tool {
        ed.tool = Tool::Select;
    }
}

fn shortcuts(ctx: &egui::Context, ed: &mut Editor, full: egui::Rect) {
    if ctx.egui_wants_keyboard_input() {
        return;
    }
    let (events, mods) = ctx.input(|i| (i.events.clone(), i.modifiers));
    let cmd = mods.command;
    for ev in &events {
        match ev {
            egui::Event::Copy => copy_selection(ed),
            egui::Event::Cut => {
                copy_selection(ed);
                delete_selection(ed);
            }
            egui::Event::Paste(t) => paste(ed, Some(t)),
            egui::Event::Key { key, pressed: true, modifiers, repeat, .. } => {
                let shift = modifiers.shift;
                use egui::Key as K;
                if modifiers.command {
                    match key {
                        K::Z if shift => ed.redo(),
                        K::Z => ed.undo(),
                        K::Y => ed.redo(),
                        K::D => duplicate(ed),
                        K::S => ed.save(),
                        K::A => ed.sel = model::all(&ed.level).into_iter().filter(|e| *e != Elem::Spawn).collect(),
                        _ => {}
                    }
                    continue;
                }
                let step = if shift { ed.grid.max(1.0) * 5.0 } else if modifiers.alt { 1.0 } else { ed.grid.max(1.0) };
                match key {
                    K::ArrowLeft => nudge(ed, Vec2::new(-step, 0.0)),
                    K::ArrowRight => nudge(ed, Vec2::new(step, 0.0)),
                    K::ArrowUp => nudge(ed, Vec2::new(0.0, step)),
                    K::ArrowDown => nudge(ed, Vec2::new(0.0, -step)),
                    _ if *repeat => {}
                    K::Escape => {
                        if !ed.draft.is_empty() {
                            ed.draft.clear();
                        } else if let Some(d) = ed.drag.take() {
                            match d {
                                Drag::Move { orig, .. } | Drag::Resize { orig, .. } | Drag::Rotate { orig, .. } | Drag::Vertex { orig, .. } => {
                                    ed.level = orig
                                }
                                _ => {}
                            }
                        } else {
                            ed.sel.clear();
                            ed.sel_vertex = None;
                            ed.tool = Tool::Select;
                        }
                    }
                    K::Enter => {
                        if !ed.draft.is_empty() {
                            finish_draft(ed);
                        } else {
                            ed.request_play = true;
                        }
                    }
                    K::Delete | K::Backspace => delete_selection(ed),
                    K::C if !ed.draft.is_empty() => finish_draft(ed),
                    K::R if !ed.sel.is_empty() && rotate_selection(ed, if shift { -15f32 } else { 15f32 }.to_radians()) => {}
                    K::S if ed.sel.iter().any(|e| matches!(e, Elem::Spring(_))) => {
                        let presets = [60.0, 90.0, 130.0];
                        let sel = ed.sel.clone();
                        ed.edit(|l| {
                            for e in &sel {
                                if let Elem::Spring(i) = e {
                                    let w = l.springs[*i].width;
                                    let k = presets.iter().position(|p| (p - w).abs() < 1.0).unwrap_or(1);
                                    let n = if shift { (k + 2) % 3 } else { (k + 1) % 3 };
                                    l.springs[*i].width = presets[n];
                                }
                            }
                        });
                    }
                    K::I => ed.show_ids = !ed.show_ids,
                    K::B => ed.ghost = if ed.ghost == Some(32.0) { None } else { Some(32.0) },
                    K::N => ed.ghost = if ed.ghost == Some(41.0) { None } else { Some(41.0) },
                    K::M => ed.ghost = if ed.ghost == Some(24.0) { None } else { Some(24.0) },
                    K::Home | K::Num0 => {
                        ed.fit(Vec2::new(full.width(), full.height()));
                    }
                    K::D => {
                        set_tool(ed, Tool::Zone);
                        ed.opts.zone = ZonePreset::Kill;
                    }
                    K::G => {
                        set_tool(ed, Tool::Zone);
                        ed.opts.zone = ZonePreset::Gravity;
                    }
                    other => {
                        let name = other.name();
                        if let Some(t) = Tool::ALL.into_iter().find(|t| t.hotkey() == Some(name)) {
                            set_tool(ed, t);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let _ = cmd;
}

// ---------------------------------------------------------------- canvas

/// Handle under the cursor for the (single) selection.
enum HandleHit {
    Vertex(usize),
    Resize(IVec2),
    Rotate,
}

fn handle_positions(f: &model::Frame, view: &View) -> (Vec<(IVec2, Vec2)>, Vec2) {
    let h = f.size * 0.5;
    let mut v = Vec::new();
    for sx in -1..=1 {
        for sy in -1..=1 {
            if sx == 0 && sy == 0 {
                continue;
            }
            v.push((IVec2::new(sx, sy), f.to_world(Vec2::new(sx as f32 * h.x, sy as f32 * h.y))));
        }
    }
    let rot = f.to_world(Vec2::new(0.0, h.y + 28.0 / view.ppu));
    (v, rot)
}

fn handle_at(ed: &Editor, view: &View, p: Pos2) -> Option<HandleHit> {
    let [e] = ed.sel.as_slice() else { return None };
    let e = *e;
    let near = |w: Vec2, r: f32| view.s(w).distance(p) < r;
    for (i, (q, _)) in model::points(&ed.level, e).iter().enumerate() {
        if near(*q, 9.0) {
            return Some(HandleHit::Vertex(i));
        }
    }
    if let Some(f) = model::frame(&ed.level, e) {
        let (hs, rot) = handle_positions(&f, view);
        if model::rotatable(&ed.level, e) && near(rot, 9.0) {
            return Some(HandleHit::Rotate);
        }
        if model::resizable(e) {
            for (s, w) in hs {
                if near(w, 8.0) {
                    return Some(HandleHit::Resize(s));
                }
            }
        }
    }
    None
}

fn canvas(ui: &mut egui::Ui, ed: &mut Editor, full: egui::Rect) {
    let rect = ui.max_rect();
    let resp = ui.allocate_rect(rect, egui::Sense::click_and_drag());
    let ctx = ui.ctx().clone();
    let mut view = View::new(full, ed);

    let (pointer, pressed, released, down, mods, scroll, zoom_delta, sec_down, mid_down, space) = ctx.input(|i| {
        (
            i.pointer.latest_pos(),
            i.pointer.primary_pressed(),
            i.pointer.primary_released(),
            i.pointer.primary_down(),
            i.modifiers,
            i.smooth_scroll_delta,
            i.zoom_delta(),
            i.pointer.secondary_down(),
            i.pointer.middle_down(),
            i.key_down(egui::Key::Space),
        )
    });
    let hovered = resp.hovered() || resp.dragged();
    if let Some(p) = pointer {
        if hovered {
            ed.cursor = view.w(p);
        }
    }

    // --- zoom & pan (wheel, pinch, two-finger touch, middle/right/space drag)
    let zoom_at = |ed: &mut Editor, view: &View, anchor: Pos2, factor: f32| {
        let wp = view.w(anchor);
        let nz = (ed.zoom / factor).clamp(0.08, 20.0);
        ed.pan = wp - (wp - ed.pan) * (nz / ed.zoom);
        ed.zoom = nz;
    };
    if let Some(mt) = ctx.multi_touch() {
        // Two fingers: pan + pinch. Abandon any one-finger interaction.
        if let Some(Drag::Move { orig, .. } | Drag::Resize { orig, .. } | Drag::Rotate { orig, .. } | Drag::Vertex { orig, .. }) =
            ed.drag.take()
        {
            ed.level = orig;
        }
        ed.drag = None;
        ed.pan -= Vec2::new(mt.translation_delta.x, -mt.translation_delta.y) / view.ppu;
        view = View::new(full, ed);
        zoom_at(ed, &view, mt.center_pos, mt.zoom_delta);
        view = View::new(full, ed);
    } else if hovered {
        let mut f = zoom_delta;
        if scroll.y != 0.0 && !mods.command {
            f *= (scroll.y * 0.0015).exp();
        }
        if (f - 1.0).abs() > 1e-4 {
            if let Some(p) = pointer {
                zoom_at(ed, &view, p, f);
                view = View::new(full, ed);
            }
        }
    }
    let pan_button = sec_down || mid_down || (space && down);
    if pan_button && hovered {
        if let Some(p) = pointer {
            match &mut ed.drag {
                Some(Drag::Pan { last }) => {
                    let d = p - *last;
                    ed.pan -= Vec2::new(d.x, -d.y) / view.ppu;
                    *last = p;
                    view = View::new(full, ed);
                }
                None => ed.drag = Some(Drag::Pan { last: p }),
                _ => {}
            }
        }
    } else if matches!(ed.drag, Some(Drag::Pan { .. })) {
        ed.drag = None;
    }

    // --- primary button
    if let Some(pos) = pointer {
        let world = view.w(pos);
        let snapped = ed.snap_pt(world);
        if pressed && resp.hovered() && !pan_button {
            on_press(ed, &view, pos, world, snapped, mods);
        }
        if down && !pressed {
            on_drag(ed, world, snapped, mods);
        }
        if released {
            on_release(ed, world, snapped);
        }
        if resp.double_clicked() {
            on_double_click(ed, &view, world);
        }
    }

    draw(ui, ed, &view, rect, pointer.filter(|_| hovered));
}

fn on_press(ed: &mut Editor, view: &View, pos: Pos2, world: Vec2, snapped: Vec2, mods: egui::Modifiers) {
    ed.status.clear();
    ed.armed = true;
    match ed.tool.placement() {
        Placement::None => {
            if let Some(h) = handle_at(ed, view, pos) {
                let e = ed.sel[0];
                let orig = ed.level.clone();
                ed.drag = Some(match h {
                    HandleHit::Vertex(i) => {
                        ed.sel_vertex = Some(i);
                        Drag::Vertex { elem: e, idx: i, orig, moved: false }
                    }
                    HandleHit::Resize(s) => Drag::Resize { elem: e, handle: s, frame: model::frame(&ed.level, e).unwrap(), orig },
                    HandleHit::Rotate => {
                        let f = model::frame(&ed.level, e).unwrap();
                        let d = world - f.center;
                        Drag::Rotate { elem: e, frame: f, start_angle: d.y.atan2(d.x), orig }
                    }
                });
                return;
            }
            let hits = model::hits_at(&ed.level, world, 6.0 / view.ppu);
            ed.sel_vertex = None;
            if hits.is_empty() {
                if !mods.shift {
                    ed.sel.clear();
                }
                ed.drag = Some(Drag::BoxSelect { start: world, cur: world, add: mods.shift });
                return;
            }
            if mods.shift {
                let h = hits[0];
                if let Some(k) = ed.sel.iter().position(|e| *e == h) {
                    ed.sel.remove(k);
                } else {
                    ed.sel.push(h);
                }
                return;
            }
            let cycle_to = if let Some(k) = hits.iter().position(|h| ed.sel.contains(h)) {
                (ed.sel.len() == 1 && hits.len() > 1).then(|| hits[(k + 1) % hits.len()])
            } else {
                ed.sel = vec![hits[0]];
                None
            };
            ed.drag = Some(Drag::Move { start: world, orig: ed.level.clone(), moved: false, cycle_to });
        }
        Placement::Rect | Placement::Line => ed.drag = Some(Drag::Place { start: snapped, cur: snapped }),
        Placement::Click => {}
        Placement::Polyline { closed, min } => {
            let mut p = snapped;
            if mods.shift {
                if let Some(last) = ed.draft.last() {
                    p = model::snap_angle(*last, world);
                }
            }
            if closed && ed.draft.len() >= min && view.s(ed.draft[0]).distance(pos) < 12.0 {
                finish_draft(ed);
                return;
            }
            ed.draft.push(p);
        }
    }
}

fn on_drag(ed: &mut Editor, world: Vec2, snapped: Vec2, mods: egui::Modifiers) {
    let grid = if ed.snap { ed.grid } else { 0.0 };
    let snap_on = ed.snap;
    let Some(drag) = ed.drag.as_mut() else { return };
    match drag {
        Drag::Move { start, orig, moved, .. } => {
            let d = model::snap(world - *start, grid);
            if d.length() > 0.0 || *moved {
                *moved = true;
                let mut l = orig.clone();
                for e in &ed.sel {
                    model::translate(&mut l, *e, d);
                }
                ed.level = l;
            }
        }
        Drag::Vertex { elem, idx, orig, moved } => {
            *moved = true;
            let mut l = orig.clone();
            model::set_point(&mut l, *elem, *idx, snapped);
            ed.level = l;
        }
        Drag::Resize { elem, handle, frame, orig } => {
            let f = *frame;
            let q = f.to_local(if f.angle == 0.0 { snapped } else { world });
            let h = f.size * 0.5;
            let s = handle.as_vec2();
            let anchor = -s * h;
            let mut half = h;
            let mut c = Vec2::ZERO;
            for ax in 0..2 {
                if s[ax] != 0.0 {
                    half[ax] = ((q[ax] - anchor[ax]).abs() * 0.5).max(4.0);
                    c[ax] = (q[ax] + anchor[ax]) * 0.5;
                }
            }
            if mods.shift && s.x != 0.0 && s.y != 0.0 {
                // Keep aspect.
                let k = (half.x / h.x.max(1e-3)).max(half.y / h.y.max(1e-3));
                half = h * k;
                c = anchor + s * half;
            }
            let new = model::Frame { center: f.to_world(c), size: half * 2.0, angle: f.angle };
            let mut l = orig.clone();
            model::set_frame(&mut l, *elem, f, new);
            ed.level = l;
        }
        Drag::Rotate { elem, frame, start_angle, orig } => {
            let d = world - frame.center;
            let mut a = d.y.atan2(d.x) - *start_angle;
            if snap_on != mods.shift {
                let step = 15f32.to_radians();
                a = (a / step).round() * step;
            }
            let mut new = *frame;
            new.angle = frame.angle + a;
            let mut l = orig.clone();
            model::set_frame(&mut l, *elem, *frame, new);
            ed.level = l;
        }
        Drag::Place { cur, .. } => *cur = snapped,
        Drag::BoxSelect { cur, .. } => *cur = world,
        Drag::Pan { .. } => {}
    }
}

fn on_release(ed: &mut Editor, _world: Vec2, snapped: Vec2) {
    // Ignore releases of presses that started on a panel / toolbar.
    if !std::mem::take(&mut ed.armed) {
        if !matches!(ed.drag, Some(Drag::Pan { .. })) {
            ed.drag = None;
        }
        return;
    }
    if ed.tool.placement() == Placement::Click && ed.drag.is_none() {
        place(ed, &[snapped]);
        return;
    }
    let Some(drag) = ed.drag.take() else { return };
    match drag {
        Drag::Move { orig, moved, cycle_to, .. } => {
            if moved {
                ed.push_undo(orig);
            } else if let Some(c) = cycle_to {
                ed.sel = vec![c];
            }
        }
        Drag::Vertex { orig, moved, .. } => {
            if moved {
                ed.push_undo(orig);
            }
        }
        Drag::Resize { orig, .. } | Drag::Rotate { orig, .. } => ed.push_undo(orig),
        Drag::Place { start, cur } => place(ed, &[start, cur]),
        Drag::BoxSelect { start, cur, add } => {
            let (min, max) = (start.min(cur), start.max(cur));
            if (max - min).length() > 1.0 {
                let inside: Vec<Elem> = model::all(&ed.level)
                    .into_iter()
                    .filter(|e| {
                        let c = model::center(&ed.level, *e);
                        c.cmpge(min).all() && c.cmple(max).all()
                    })
                    .collect();
                if !add {
                    ed.sel.clear();
                }
                for e in inside {
                    if !ed.sel.contains(&e) {
                        ed.sel.push(e);
                    }
                }
            }
        }
        Drag::Pan { .. } => {}
    }
}

fn on_double_click(ed: &mut Editor, view: &View, world: Vec2) {
    if let Placement::Polyline { .. } = ed.tool.placement() {
        finish_draft(ed);
        return;
    }
    // Insert a vertex on the nearest edge of the selected polygon.
    let [e] = ed.sel.as_slice() else { return };
    let e = *e;
    if let Some(Shape::Poly { points }) = model::shape(&ed.level, e) {
        let n = points.len();
        let best = (0..n)
            .map(|k| (k, model::seg_dist(world, points[k], points[(k + 1) % n])))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((k, d)) = best {
            if d * view.ppu < 10.0 {
                let p = ed.snap_pt(world);
                ed.edit(|l| {
                    model::insert_vertex(l, e, k, p);
                });
                ed.sel_vertex = Some(k + 1);
            }
        }
    }
}

// ------------------------------------------------------------------ draw

fn draw(ui: &mut egui::Ui, ed: &Editor, view: &View, rect: egui::Rect, pointer: Option<Pos2>) {
    let painter = ui.painter_at(rect);
    let font = egui::FontId::proportional(12.0);
    let small = egui::FontId::proportional(11.0);

    // Grid.
    if ed.show_grid && ed.grid > 0.0 {
        let mut step = ed.grid;
        while step * view.ppu < 10.0 {
            step *= 5.0;
        }
        let tl = view.w(rect.left_top());
        let br = view.w(rect.right_bottom());
        let mut x = (tl.x / step).floor() * step;
        while x <= br.x {
            let major = ((x / step).round() as i64) % 5 == 0;
            let a = if x.abs() < 1e-3 { 70 } else if major { 26 } else { 12 };
            let sx = view.s(Vec2::new(x, 0.0)).x;
            painter.line_segment([Pos2::new(sx, rect.top()), Pos2::new(sx, rect.bottom())], Stroke::new(1.0, faded(Color32::WHITE, a)));
            x += step;
        }
        let mut y = (br.y / step).floor() * step;
        while y <= tl.y {
            let major = ((y / step).round() as i64) % 5 == 0;
            let a = if y.abs() < 1e-3 { 70 } else if major { 26 } else { 12 };
            let sy = view.s(Vec2::new(0.0, y)).y;
            painter.line_segment([Pos2::new(rect.left(), sy), Pos2::new(rect.right(), sy)], Stroke::new(1.0, faded(Color32::WHITE, a)));
            y += step;
        }
    }

    let l = &ed.level;
    // Kill line.
    let ky = view.s(Vec2::new(0.0, l.kill_y)).y;
    if ky > rect.top() && ky < rect.bottom() {
        let red = Color32::from_rgb(255, 80, 90);
        let mut x = rect.left();
        while x < rect.right() {
            painter.line_segment([Pos2::new(x, ky), Pos2::new((x + 10.0).min(rect.right()), ky)], Stroke::new(1.5, red));
            x += 18.0;
        }
        painter.text(Pos2::new(rect.left() + 6.0, ky - 2.0), egui::Align2::LEFT_BOTTOM, "kill y", small.clone(), red);
    }

    let hover = if ed.tool == Tool::Select && ed.drag.is_none() {
        pointer.and_then(|p| model::hits_at(l, view.w(p), 6.0 / view.ppu).into_iter().next())
    } else {
        None
    };

    // Elements, back to front.
    let mut elems = model::all(l);
    elems.reverse();
    for e in elems {
        let (o, closed) = model::outline(l, e);
        if o.is_empty() {
            continue;
        }
        let col = elem_color(l, e);
        let pts: Vec<Pos2> = o.iter().map(|p| view.s(*p)).collect();
        let region = matches!(e, Elem::Zone(_) | Elem::Goal | Elem::Hill(_) | Elem::Story(_));
        if region {
            if pts.len() >= 3 {
                let poly_fill = faded(col, 22);
                // egui convex fill only; triangulate for concave regions.
                let tris = bb_physics::geom::triangulate(&o);
                let mut mesh = egui::Mesh::default();
                for p in &pts {
                    mesh.colored_vertex(*p, poly_fill);
                }
                for t in tris {
                    mesh.add_triangle(t[0], t[1], t[2]);
                }
                painter.add(egui::Shape::mesh(mesh));
            }
            painter.add(egui::Shape::closed_line(pts.clone(), Stroke::new(1.5, faded(col, 200))));
            if let Some(t) = region_label(l, e) {
                let (min, max) = model::bounds(l, e);
                let (at, align) = match model::shape(l, e) {
                    Some(Shape::Poly { points }) => {
                        (view.s(points.iter().copied().sum::<Vec2>() / points.len() as f32), egui::Align2::CENTER_CENTER)
                    }
                    _ => (view.s(Vec2::new((min.x + max.x) * 0.5, max.y)) + egui::vec2(0.0, 3.0), egui::Align2::CENTER_TOP),
                };
                painter.text(at, align, t, font.clone(), col);
            }
        } else {
            let w = match e {
                Elem::Terrain(_) | Elem::Jelly(_) => 1.0,
                _ => 1.5,
            };
            let a = match e {
                Elem::Terrain(_) | Elem::Jelly(_) => 70,
                _ => 170,
            };
            if closed {
                painter.add(egui::Shape::closed_line(pts.clone(), Stroke::new(w, faded(col, a))));
            } else {
                painter.add(egui::Shape::line(pts.clone(), Stroke::new(2.0, faded(col, 200))));
            }
        }
        // Element-specific glyphs.
        match e {
            Elem::Spawn => {
                let c = view.s(l.spawn);
                painter.circle_filled(c, 5.0, col);
                painter.text(c + egui::vec2(0.0, -34.0 * view.ppu - 4.0), egui::Align2::CENTER_BOTTOM, "SPAWN", font.clone(), col);
            }
            Elem::Spring(i) => {
                let s = &l.springs[i];
                let a = view.s(s.pos);
                let b = view.s(s.pos + Vec2::from_angle(s.angle) * 80.0);
                painter.arrow(a, b - a, Stroke::new(2.0, faded(col, 220)));
            }
            Elem::Mover(i) => {
                let m = &l.movers[i];
                let c = m.shape.center();
                if m.path.len() >= 2 {
                    let path: Vec<Pos2> = m.path.iter().map(|o| view.s(c + *o)).collect();
                    let mut p = path.clone();
                    if matches!(m.motion, MoverMotion::Loop) {
                        p.push(path[0]);
                    }
                    painter.add(egui::Shape::dashed_line(&p, Stroke::new(1.5, faded(col, 200)), 6.0, 4.0));
                    let end = *m.path.last().unwrap();
                    let ghost: Vec<Pos2> = m.shape.outline().iter().map(|q| view.s(*q + end)).collect();
                    painter.add(egui::Shape::closed_line(ghost, Stroke::new(1.0, faded(col, 90))));
                }
                if let MoverMotion::Spin { .. } = m.motion {
                    painter.circle_stroke(view.s(c), 10.0, Stroke::new(1.5, col));
                }
                // Plate links.
                if !m.trigger.is_empty() {
                    let ids: Vec<&str> = m.trigger.split('#').next().unwrap_or("").split(['|', '&']).map(|s| s.trim()).collect();
                    for st in &l.story {
                        if let Some(id) = st.script.strip_prefix("plate:") {
                            if ids.contains(&id) {
                                painter.add(egui::Shape::dashed_line(
                                    &[view.s(st.shape.center()), view.s(c)],
                                    Stroke::new(1.0, Color32::from_rgb(255, 150, 60)),
                                    4.0,
                                    4.0,
                                ));
                            }
                        }
                    }
                }
            }
            Elem::Checkpoint(i) => {
                let p = view.s(l.checkpoints[i].pos);
                painter.text(p + egui::vec2(0.0, 4.0), egui::Align2::CENTER_TOP, "CP", small.clone(), col);
            }
            Elem::Npc(i) if ed.show_ids && view.ppu > 0.6 => {
                let n = &l.npcs[i];
                painter.text(view.s(n.pos + Vec2::new(0.0, n.radius)), egui::Align2::CENTER_BOTTOM, format!("{:?}", n.role), small.clone(), col);
            }
            _ => {}
        }
        if ed.show_ids && !region {
            let id = elem_id(l, e);
            if !id.is_empty() && view.ppu > 0.25 {
                let (min, max) = model::bounds(l, e);
                painter.text(view.s(Vec2::new((min.x + max.x) * 0.5, max.y)), egui::Align2::CENTER_BOTTOM, id, small.clone(), faded(col, 200));
            }
        }
    }

    // Hover + selection.
    if let Some(h) = hover {
        if !ed.sel.contains(&h) {
            outline_elem(&painter, l, h, view, Stroke::new(2.0, HOVER));
        }
    }
    for e in &ed.sel {
        if model::exists(l, *e) {
            outline_elem(&painter, l, *e, view, Stroke::new(2.5, SEL));
        }
    }
    if let [e] = ed.sel.as_slice() {
        let e = *e;
        if model::exists(l, e) {
            if let Some(f) = model::frame(l, e) {
                let corners: Vec<Pos2> = f.corners().iter().map(|p| view.s(*p)).collect();
                painter.add(egui::Shape::dashed_line(&[corners.clone(), vec![corners[0]]].concat(), Stroke::new(1.0, faded(SEL, 160)), 5.0, 4.0));
                let (hs, rot) = handle_positions(&f, view);
                if model::resizable(e) {
                    for (_, w) in hs {
                        let p = view.s(w);
                        painter.rect_filled(egui::Rect::from_center_size(p, egui::vec2(8.0, 8.0)), 1.0, HANDLE);
                        painter.rect_stroke(egui::Rect::from_center_size(p, egui::vec2(8.0, 8.0)), 1.0, Stroke::new(1.0, Color32::BLACK), egui::StrokeKind::Outside);
                    }
                }
                if model::rotatable(l, e) {
                    let top = f.to_world(Vec2::new(0.0, f.size.y * 0.5));
                    painter.line_segment([view.s(top), view.s(rot)], Stroke::new(1.0, SEL));
                    painter.circle(view.s(rot), 5.5, SEL, Stroke::new(1.0, Color32::BLACK));
                }
            }
            for (i, (p, k)) in model::points(l, e).iter().enumerate() {
                let s = view.s(*p);
                let selected = ed.sel_vertex == Some(i);
                let fill = if selected { SEL } else { Color32::from_rgb(120, 200, 255) };
                match k {
                    PtKind::Path => {
                        let d = 6.0;
                        painter.add(egui::Shape::convex_polygon(
                            vec![s + egui::vec2(0.0, -d), s + egui::vec2(d, 0.0), s + egui::vec2(0.0, d), s + egui::vec2(-d, 0.0)],
                            fill,
                            Stroke::new(1.0, Color32::BLACK),
                        ));
                    }
                    _ => {
                        let r = egui::Rect::from_center_size(s, egui::vec2(9.0, 9.0));
                        painter.rect_filled(r, 0.0, fill);
                        painter.rect_stroke(r, 0.0, Stroke::new(1.0, Color32::BLACK), egui::StrokeKind::Outside);
                    }
                }
            }
        }
    }

    // In-progress interactions.
    match &ed.drag {
        Some(Drag::Place { start, cur }) => {
            let col = Color32::from_rgb(120, 255, 160);
            match ed.tool.placement() {
                Placement::Line => {
                    painter.line_segment([view.s(*start), view.s(*cur)], Stroke::new(2.0, col));
                }
                _ => {
                    let r = egui::Rect::from_two_pos(view.s(*start), view.s(*cur));
                    painter.rect_stroke(r, 0.0, Stroke::new(2.0, col), egui::StrokeKind::Middle);
                    painter.rect_filled(r, 0.0, faded(col, 25));
                    let d = (*cur - *start).abs();
                    painter.text(r.right_bottom() + egui::vec2(4.0, 4.0), egui::Align2::LEFT_TOP, format!("{:.0} × {:.0}", d.x, d.y), small.clone(), col);
                }
            }
        }
        Some(Drag::BoxSelect { start, cur, .. }) => {
            let r = egui::Rect::from_two_pos(view.s(*start), view.s(*cur));
            painter.rect_filled(r, 0.0, faded(Color32::from_rgb(120, 180, 255), 30));
            painter.rect_stroke(r, 0.0, Stroke::new(1.0, Color32::from_rgb(120, 180, 255)), egui::StrokeKind::Middle);
        }
        _ => {}
    }
    if !ed.draft.is_empty() {
        let col = Color32::from_rgb(120, 255, 160);
        let mut pts: Vec<Pos2> = ed.draft.iter().map(|p| view.s(*p)).collect();
        if let Some(p) = pointer {
            pts.push(p);
        }
        painter.add(egui::Shape::line(pts.clone(), Stroke::new(2.0, col)));
        for p in &pts[..ed.draft.len()] {
            painter.circle_filled(*p, 4.0, col);
        }
        if ed.tool == Tool::Ground && ed.draft.len() >= 1 {
            // Preview the solid depth under the run.
            let low = ed.draft.iter().map(|p| p.y).fold(f32::MAX, f32::min) - ed.opts.ground_depth;
            let a = view.s(Vec2::new(ed.draft[0].x, low));
            let b = view.s(Vec2::new(ed.draft[ed.draft.len() - 1].x, low));
            painter.add(egui::Shape::dashed_line(&[pts[0], a, b, pts[ed.draft.len() - 1]], Stroke::new(1.0, faded(col, 140)), 6.0, 4.0));
        }
    }

    // Blob ghost.
    if let (Some(r), Some(p)) = (ed.ghost, pointer) {
        painter.circle_stroke(p, r * view.ppu, Stroke::new(1.5, faded(Color32::from_rgb(255, 93, 115), 220)));
        let h = bb_level::metrics::JUMP_H * view.ppu;
        painter.add(egui::Shape::dashed_line(&[p, p - egui::vec2(0.0, h)], Stroke::new(1.0, faded(Color32::WHITE, 120)), 4.0, 4.0));
        painter.text(p - egui::vec2(0.0, h), egui::Align2::CENTER_BOTTOM, "jump", small, faded(Color32::WHITE, 160));
    }
}

fn outline_elem(painter: &egui::Painter, l: &Level, e: Elem, view: &View, stroke: Stroke) {
    let (o, closed) = model::outline(l, e);
    let pts: Vec<Pos2> = o.iter().map(|p| view.s(*p)).collect();
    if closed {
        painter.add(egui::Shape::closed_line(pts, stroke));
    } else {
        painter.add(egui::Shape::line(pts, stroke));
    }
}

#[cfg(test)]
mod tests {
    //! Canvas interaction logic driven without a window: press / drag /
    //! release in world coordinates through the same code paths as the mouse.
    use super::*;
    use bb_level::v;

    fn setup() -> (Editor, View) {
        let mut ed = Editor::default();
        ed.load(tools::starter_level(), None);
        ed.pan = Vec2::ZERO;
        ed.zoom = 1.0;
        let full = egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(1500.0, 860.0));
        let view = View::new(full, &ed);
        (ed, view)
    }

    fn gesture(ed: &mut Editor, view: &View, from: Vec2, to: Vec2, mods: egui::Modifiers) {
        let s = ed.snap_pt(from);
        on_press(ed, view, view.s(from), from, s, mods);
        for k in 1..=4 {
            let p = from.lerp(to, k as f32 / 4.0);
            on_drag(ed, p, ed.snap_pt(p), mods);
        }
        on_release(ed, to, ed.snap_pt(to));
    }

    #[test]
    fn view_roundtrip() {
        let (_, view) = setup();
        let p = v(123.0, -45.0);
        assert!((view.w(view.s(p)) - p).length() < 1e-3);
        // y up on screen = smaller screen y.
        assert!(view.s(v(0.0, 100.0)).y < view.s(v(0.0, 0.0)).y);
    }

    #[test]
    fn place_select_move_undo() {
        let (mut ed, view) = setup();
        let none = egui::Modifiers::NONE;
        ed.tool = Tool::TerrainRect;
        gesture(&mut ed, &view, v(100.0, 200.0), v(300.0, 260.0), none);
        assert_eq!(ed.tool, Tool::Select, "tool reverts after placing");
        let e = ed.sel[0];
        assert!(matches!(e, Elem::Terrain(_)));
        let f = model::frame(&ed.level, e).unwrap();
        assert_eq!(f.size, v(200.0, 60.0));
        // Drag it by (40, 20).
        gesture(&mut ed, &view, v(200.0, 230.0), v(240.0, 250.0), none);
        assert_eq!(model::frame(&ed.level, e).unwrap().center, f.center + v(40.0, 20.0));
        ed.undo();
        assert_eq!(model::frame(&ed.level, e).unwrap().center, f.center);
        ed.undo();
        assert!(!model::exists(&ed.level, e) || !matches!(model::frame(&ed.level, e), Some(ff) if ff.size == v(200.0, 60.0)));
        ed.redo();
        ed.redo();
        assert_eq!(model::frame(&ed.level, e).unwrap().center, f.center + v(40.0, 20.0));
    }

    #[test]
    fn resize_and_rotate_handles() {
        let (mut ed, view) = setup();
        let none = egui::Modifiers::NONE;
        ed.tool = Tool::TerrainRect;
        gesture(&mut ed, &view, v(0.0, 200.0), v(200.0, 260.0), none);
        let e = ed.sel[0];
        // Right edge handle at (200, 230): drag to 300.
        gesture(&mut ed, &view, v(200.0, 230.0), v(300.0, 230.0), none);
        let f = model::frame(&ed.level, e).unwrap();
        assert_eq!(f.size.x, 300.0);
        assert_eq!(f.center.x, 150.0, "left edge stays put");
        // Rotation handle sits above the top edge.
        let (_, rot) = handle_positions(&f, &view);
        gesture(&mut ed, &view, rot, f.center + v(-200.0, 0.0), none);
        let a = model::frame(&ed.level, e).unwrap().angle;
        assert!((a - std::f32::consts::FRAC_PI_2).abs() < 0.01, "rotated 90°: {a}");
    }

    #[test]
    fn ground_polyline_and_vertices() {
        let (mut ed, view) = setup();
        ed.tool = Tool::Ground;
        for p in [v(-200.0, 300.0), v(0.0, 300.0), v(200.0, 360.0)] {
            on_press(&mut ed, &view, view.s(p), p, p, egui::Modifiers::NONE);
            on_release(&mut ed, p, p);
        }
        finish_draft(&mut ed);
        assert!(ed.sel.iter().any(|e| matches!(e, Elem::Terrain(_))));
        assert!(ed.sel.iter().filter(|e| matches!(e, Elem::Jelly(_))).count() >= 2, "jelly skin tiles");

        // Terrain poly closes by clicking the first point.
        ed.sel.clear();
        ed.tool = Tool::TerrainPoly;
        for p in [v(-400.0, 500.0), v(-200.0, 500.0), v(-300.0, 600.0), v(-400.0, 500.0)] {
            on_press(&mut ed, &view, view.s(p), p, p, egui::Modifiers::NONE);
            on_release(&mut ed, p, p);
        }
        let [e] = ed.sel.as_slice() else { panic!("poly selected: {:?}", ed.sel) };
        let e = *e;
        assert_eq!(model::points(&ed.level, e).len(), 3);
        // Drag vertex 2.
        let p2 = model::points(&ed.level, e)[2].0;
        gesture(&mut ed, &view, p2, p2 + v(0.0, 100.0), egui::Modifiers::NONE);
        assert_eq!(model::points(&ed.level, e)[2].0, p2 + v(0.0, 100.0));
        assert_eq!(ed.sel_vertex, Some(2));
        // Double-click an edge inserts a vertex.
        on_double_click(&mut ed, &view, v(-300.0, 500.0));
        assert_eq!(model::points(&ed.level, e).len(), 4);
        delete_selection(&mut ed);
        assert_eq!(model::points(&ed.level, e).len(), 3, "Del removes the selected vertex");
    }

    #[test]
    fn box_select_copy_paste_delete() {
        let (mut ed, view) = setup();
        for p in [v(100.0, 300.0), v(200.0, 300.0), v(300.0, 300.0)] {
            ed.tool = Tool::Pickup;
            on_press(&mut ed, &view, view.s(p), p, p, egui::Modifiers::NONE);
            on_release(&mut ed, p, p);
        }
        assert_eq!(ed.level.pickups.len(), 3);
        ed.sel.clear();
        gesture(&mut ed, &view, v(50.0, 250.0), v(350.0, 350.0), egui::Modifiers::NONE);
        assert_eq!(ed.sel.len(), 3);
        copy_selection(&mut ed);
        ed.cursor = v(1000.0, 1000.0);
        paste(&mut ed, None);
        assert_eq!(ed.level.pickups.len(), 6);
        assert!(ed.level.pickups[3..].iter().all(|p| p.y == 1000.0));
        delete_selection(&mut ed);
        assert_eq!(ed.level.pickups.len(), 3);
        duplicate(&mut ed);
        assert_eq!(ed.level.pickups.len(), 3, "nothing selected after delete");
    }

    #[test]
    fn click_cycles_overlapping() {
        let (mut ed, view) = setup();
        let p = v(0.0, 400.0);
        for t in [Tool::Zone, Tool::Checkpoint] {
            ed.tool = t;
            on_press(&mut ed, &view, view.s(p), p, p, egui::Modifiers::NONE);
            on_release(&mut ed, p, p);
        }
        ed.sel.clear();
        let click = |ed: &mut Editor| {
            on_press(ed, &view, view.s(p), p, p, egui::Modifiers::NONE);
            on_release(ed, p, p);
        };
        click(&mut ed);
        assert!(matches!(ed.sel[0], Elem::Checkpoint(_)));
        click(&mut ed);
        assert!(matches!(ed.sel[0], Elem::Zone(_)), "second click selects what's underneath");
    }
}

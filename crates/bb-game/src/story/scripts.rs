//! The words. Every cutscene of "Up & Out" (see docs/Story.md).

use bb_level::{LevelBuilder, NpcRole, PropKind, Theme, v};
use bb_sim::Vec2 as PVec2;

use super::cutscene::{Beat, Cutscene, EyeState};
use crate::render::Mood;

fn say(who: &str, text: &str) -> Beat {
    Beat::Say { who: who.into(), text: text.into() }
}
fn walk(who: &str, x: f32) -> Beat {
    Beat::Walk { who: who.into(), x }
}
fn stroll(who: &str, x: f32) -> Beat {
    Beat::Stroll { who: who.into(), x }
}
fn hop(who: &str) -> Beat {
    Beat::Hop { who: who.into(), hold: 0.12 }
}
fn jump(who: &str) -> Beat {
    Beat::Hop { who: who.into(), hold: 0.4 }
}
fn puff(who: &str, scale: f32, secs: f32) -> Beat {
    Beat::Puff { who: who.into(), scale, secs }
}
fn push(who: &str, x: f32, y: f32) -> Beat {
    Beat::Push { who: who.into(), vel: PVec2::new(x, y) }
}
fn word(who: &str, text: &str) -> Beat {
    Beat::Word { who: who.into(), text: text.into() }
}
fn follow(who: &str, zoom: f32) -> Beat {
    Beat::Follow { who: who.into(), zoom }
}
fn wait(s: f32) -> Beat {
    Beat::Wait(s)
}
fn title(n: u8, name: &str) -> Beat {
    Beat::Title { title: name.into(), sub: format!("Chapter {n}") }
}
fn fade_in() -> Beat {
    Beat::Fade { to: 0.0, secs: 0.8 }
}
fn fade_out() -> Beat {
    Beat::Fade { to: 1.0, secs: 0.9 }
}

struct Actor {
    id: &'static str,
    role: NpcRole,
    color: u32,
    x: f32,
    r: f32,
}

fn a(id: &'static str, role: NpcRole, x: f32) -> Actor {
    Actor { id, role, color: 0, x, r: 30.0 }
}

/// A flat little theatre for a cutscene.
fn stage(id: &str, theme: Theme, pip_color: u32, actors: &[Actor], decor: &[(&str, f32, f32, f32)]) -> bb_level::Level {
    let mut b = LevelBuilder::new(id, id, theme);
    b.spawn(v(0.0, 60.0))
        .ground(&[v(-1600.0, 0.0), v(1600.0, 0.0)], 400.0)
        .block(v(-1700.0, -400.0), v(-1600.0, 1400.0))
        .block(v(1600.0, -400.0), v(1700.0, 1400.0))
        .kill_y(-1000.0);
    b.npc("pip", v(actors.iter().find(|x| x.id == "pip").map_or(-400.0, |x| x.x), 60.0), NpcRole::Huddle, &format!("#{pip_color:06x}"), 32.0);
    for act in actors.iter().filter(|x| x.id != "pip") {
        let color = if act.color == 0 { String::new() } else { format!("#{:06x}", act.color) };
        let y = if act.role == NpcRole::Glimmer { 260.0 } else { 40.0 + act.r };
        b.npc(act.id, v(act.x, y), act.role.clone(), &color, act.r);
    }
    for (kind, x, y, s) in decor {
        b.decor(kind, v(*x, *y), *s, -1.0);
    }
    b.build()
}

fn eyes(who: &str, state: EyeState) -> Beat {
    Beat::Eyes { who: who.into(), state }
}
fn gaze(who: &str, x: f32, y: f32) -> Beat {
    Beat::Gaze { who: who.into(), dir: Some(PVec2::new(x, y)) }
}
fn ungaze(who: &str) -> Beat {
    Beat::Gaze { who: who.into(), dir: None }
}
fn mood(who: &str, m: Mood) -> Beat {
    Beat::Mood { who: who.into(), mood: Some(m) }
}
fn unmood(who: &str) -> Beat {
    Beat::Mood { who: who.into(), mood: None }
}
fn slow_cam(x: f32, y: f32, zoom: f32, ease: f32) -> Beat {
    Beat::Cam { at: PVec2::new(x, y), zoom, ease }
}

/// A gang of same-coloured critters.
fn gang(prefix: &'static [&'static str], color: u32, start_x: f32, step: f32, r: f32) -> Vec<Actor> {
    prefix.iter().enumerate().map(|(i, id)| Actor { id, role: NpcRole::Huddle, color, x: start_x + i as f32 * step, r }).collect()
}

pub fn cutscene(id: &str, pip: u32) -> Option<Cutscene> {
    let (stage_level, beats) = match id {
        // ----------------------------------------------------------- ch1
        "ch01_intro" => {
            let st = stage(id, Theme::Hollow, pip, &[a("pip", NpcRole::Huddle, 0.0)], &[("drip", 40.0, 520.0, 1.0), ("crystal", -700.0, 0.0, 1.1), ("crystal", 760.0, 0.0, 0.8), ("sun", 0.0, 2600.0, 0.5)]);
            (st, vec![
                // Pip starts with no eyes at all; they draw themselves in
                // (a pen tracing each outline), then open.
                eyes("pip", EyeState::None),
                Beat::Fade { to: 0.0, secs: 3.0 },
                slow_cam(0.0, 70.0, 0.45, 0.2),
                wait(2.2),
                word("pip", "plip"),
                push("pip", 0.0, -120.0),
                wait(1.2),
                puff("pip", 1.08, 0.6),
                wait(0.8),
                eyes("pip", EyeState::Draw),
                wait(super::cutscene::EYE_DRAW_SECS + 0.6),
                eyes("pip", EyeState::Roll),
                wait(1.6),
                eyes("pip", EyeState::Open),
                wait(0.5),
                word("pip", "?"),
                wait(0.8),
                gaze("pip", -1.0, 0.0),
                wait(0.9),
                gaze("pip", 1.0, 0.0),
                wait(0.9),
                ungaze("pip"),
                hop("pip"),
                wait(0.6),
                mood("pip", Mood::Puff),
                say("pip", "...!"),
                unmood("pip"),
                say("pip", "Hello?"),
                slow_cam(0.0, 260.0, 1.5, 2.0),
                // (No floating echo text here: speech is always a bubble.)
                wait(2.0),
                say("pip", "Is anybody... like me?"),
                wait(1.2),
                gaze("pip", 0.0, 1.0),
                slow_cam(0.0, 1500.0, 1.8, 3.0),
                wait(3.0),
                follow("pip", 0.6),
                wait(1.0),
                say("pip", "Maybe somebody's up there."),
                ungaze("pip"),
                hop("pip"),
                title(1, "Awake"),
                fade_out(),
            ])
        }
        "ch01_outro" => {
            let st = stage(
                id,
                Theme::Hollow,
                pip,
                &[a("pip", NpcRole::Huddle, -300.0), a("glimmer", NpcRole::Glimmer, -380.0)],
                &[("drip", 320.0, 760.0, 1.0), ("sun", 0.0, 2200.0, 0.8)],
            );
            (st, vec![
                fade_in(),
                follow("pip", 0.7),
                walk("pip", 0.0),
                stroll("glimmer", 330.0),
                gaze("pip", 0.0, 1.0),
                slow_cam(0.0, 800.0, 1.4, 2.0),
                wait(2.2),
                follow("pip", 0.7),
                say("pip", "It's still so far."),
                say("glimmer", "Yep. Very far. Very up."),
                ungaze("pip"),
                gaze("pip", -1.0, 0.3),
                say("pip", "Will you come with me?"),
                say("glimmer", "ME? Ha! No. Lesson's over, blob."),
                stroll("glimmer", 1300.0),
                wait(0.8),
                say("glimmer", "And don't follow me!"),
                gaze("pip", 1.0, 0.3),
                wait(1.2),
                mood("pip", Mood::Squash),
                say("pip", "...bye, Glimmer."),
                unmood("pip"),
                ungaze("pip"),
                wait(0.4),
                say("pip", "That's okay. I'm bouncy."),
                jump("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch2
        "ch02_intro" => {
            let st = stage(id, Theme::Drip, pip, &[a("pip", NpcRole::Huddle, -500.0), a("glimmer", NpcRole::Glimmer, 260.0)], &[("drip", -200.0, 700.0, 1.2), ("drip", 420.0, 760.0, 0.9), ("glowworm", 560.0, 620.0, 1.0)]);
            (st, vec![
                fade_in(),
                title(2, "The Drip"),
                follow("pip", 0.8),
                walk("pip", -60.0),
                gaze("pip", 1.0, 0.4),
                mood("pip", Mood::Puff),
                say("pip", "Glimmer! There you are!"),
                unmood("pip"),
                slow_cam(200.0, 230.0, 0.8, 0.8),
                say("glimmer", "Shh! I'm hiding. From YOU."),
                follow("pip", 0.8),
                say("pip", "You glow. You're really easy to find."),
                slow_cam(200.0, 230.0, 0.8, 0.6),
                wait(0.5),
                say("glimmer", "...Ugh."),
                follow("pip", 0.8),
                ungaze("pip"),
                walk("pip", 120.0),
                fade_out(),
            ])
        }
        "ch02_outro" => {
            let st = stage(id, Theme::Drip, pip, &[a("pip", NpcRole::Huddle, -100.0), a("glimmer", NpcRole::Glimmer, -230.0)], &[("mushroom", 500.0, 0.0, 2.0)]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("pip", "Nobody down here wants to share a light."),
                say("glimmer", "...I'm sharing mine. Technically."),
                mood("pip", Mood::Puff),
                hop("pip"),
                say("pip", "Glimmer!"),
                unmood("pip"),
                say("glimmer", "Don't make it weird."),
                wait(0.5),
                gaze("pip", 1.0, 0.0),
                say("pip", "...ooh. What's that pink glow?"),
                hop("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch3
        "ch03_intro" => {
            let mut actors = gang(&["cap1", "cap2", "cap3"], 0xff6fa8, 120.0, 90.0, 26.0);
            actors.push(a("pip", NpcRole::Huddle, -500.0));
            let mut b = LevelBuilder { level: stage(id, Theme::Fungus, pip, &actors, &[("mushroom", -800.0, 0.0, 2.5), ("mushroom", 900.0, 0.0, 1.8)]) };
            b.mushroom(v(-180.0, 0.0), 120.0, 220.0);
            (b.build(), vec![
                fade_in(),
                title(3, "Mushroom Bounce"),
                follow("pip", 0.85),
                walk("pip", -320.0),
                say("pip", "Hello, mushroom people! I'm Pip!"),
                slow_cam(200.0, 200.0, 0.85, 0.7),
                say("cap2", "No blobs in the Puff Patch!"),
                say("cap1", "Hee hee! Bounce him out!"),
                stroll("cap1", -260.0),
                stroll("cap2", -240.0),
                stroll("cap3", -220.0),
                wait(0.8),
                push("pip", -500.0, 700.0),
                follow("pip", 0.9),
                word("pip", "BOING!"),
                wait(1.4),
                mood("pip", Mood::Puff),
                say("pip", "WHEE... wait. That was FUN."),
                unmood("pip"),
                fade_out(),
            ])
        }
        "ch03_outro" => {
            let st = stage(id, Theme::Fungus, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, -130.0)], &[("mushroom", 300.0, 0.0, 1.5)]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("pip", "They didn't want me..."),
                say("glimmer", "Their loss. ...Don't quote me."),
                wait(0.4),
                say("pip", "...but bouncing is how you go UP!"),
                jump("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch4
        "ch04_intro" => {
            let mut actors = gang(&["tangle1", "tangle2"], 0x6fd36a, 140.0, 300.0, 24.0);
            actors.push(a("pip", NpcRole::Huddle, -400.0));
            let mut b = LevelBuilder { level: stage(id, Theme::Vines, pip, &actors, &[]) };
            b.vine(v(150.0, 700.0), 400.0).vine(v(450.0, 700.0), 380.0);
            (b.build(), vec![
                fade_in(),
                title(4, "Vine Gardens"),
                follow("pip", 0.85),
                walk("pip", -120.0),
                say("pip", "Ooh, dangly things!"),
                slow_cam(300.0, 260.0, 0.9, 0.7),
                say("tangle1", "OUR dangly things."),
                say("tangle2", "Find your own dangly thing!"),
                follow("pip", 0.85),
                mood("pip", Mood::Squash),
                say("pip", "Could we share the dangly things?"),
                say("tangle1", "No sharesies."),
                unmood("pip"),
                wait(0.5),
                say("pip", "Fine. I'll find my own dangly thing."),
                fade_out(),
            ])
        }
        "ch04_outro" => {
            let st = stage(id, Theme::Vines, pip, &[a("pip", NpcRole::Huddle, 0.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("pip", "I swung SO high, all by myself."),
                Beat::Shake(0.5),
                word("pip", "CLONK"),
                wait(0.8),
                gaze("pip", 1.0, 0.0),
                say("pip", "...what was that?"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch5
        "ch05_intro" => {
            let st = stage(id, Theme::Stoneworks, pip, &[a("pip", NpcRole::Huddle, -420.0), Actor { id: "clonk", role: NpcRole::Granny, color: 0x7d7a74, x: 260.0, r: 76.0 }], &[]);
            (st, vec![
                fade_in(),
                title(5, "The Crusher Hall"),
                slow_cam(0.0, 240.0, 1.0, 0.8),
                wait(1.2),
                follow("pip", 0.85),
                walk("pip", 40.0),
                say("pip", "Hi! You're big. Want to be friends?"),
                slow_cam(260.0, 260.0, 0.8, 0.6),
                wait(0.8),
                say("clonk", "CLONK."),
                follow("pip", 0.8),
                say("pip", "Is that a yes-clonk or a no-clonk?"),
                slow_cam(260.0, 260.0, 0.8, 0.6),
                wait(0.8),
                say("clonk", "...CLONK."),
                Beat::Shake(0.7),
                follow("pip", 0.8),
                mood("pip", Mood::Squash),
                say("pip", "No-clonk. Got it."),
                unmood("pip"),
                fade_out(),
            ])
        }
        "ch05_outro" => {
            let st = stage(id, Theme::Stoneworks, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, -130.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.65),
                mood("pip", Mood::Squash),
                puff("pip", 0.85, 1.6),
                say("pip", "I popped so many times."),
                say("glimmer", "Pop, come back. That's the trick."),
                wait(0.6),
                unmood("pip"),
                puff("pip", 1.25, 0.6),
                say("pip", "...but I'm still me. Still looking."),
                jump("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch6
        "ch06_intro" => {
            let mut b = LevelBuilder {
                level: stage(id, Theme::Lake, pip, &[a("pip", NpcRole::Huddle, -500.0), Actor { id: "reg", role: NpcRole::Reg, color: 0, x: 300.0, r: 36.0 }], &[]),
            };
            b.prop("teacup", PropKind::Custom { outline: vec![v(-70.0, 30.0), v(70.0, 30.0), v(50.0, -30.0), v(-50.0, -30.0)] }, v(300.0, 32.0), v(140.0, 60.0), 3.0, "#fff1f6");
            (b.build(), vec![
                fade_in(),
                title(6, "Puddle Lake"),
                slow_cam(0.0, 220.0, 1.0, 0.8),
                say("reg", "HALT! No commoners near the ROYAL teacup!"),
                follow("pip", 0.85),
                say("pip", "Hi! I'm Pip. Are you a... sock?"),
                slow_cam(300.0, 220.0, 0.8, 0.6),
                say("reg", "I am His Royal Softness, KING Reginald Sock the First!"),
                say("reg", "I do not make friends. I make DECREES."),
                follow("pip", 0.8),
                mood("pip", Mood::Squash),
                say("pip", "Oh."),
                unmood("pip"),
                slow_cam(300.0, 220.0, 0.8, 0.6),
                say("reg", "...I fell from the SURFACE, you know. A GIRL lost me up there."),
                say("reg", "She loves bouncy things. Not that YOU would know anything about that."),
                follow("pip", 0.8),
                mood("pip", Mood::Puff),
                say("pip", "I'm VERY bouncy!"),
                unmood("pip"),
                say("reg", "Then go bother HER. Shoo!"),
                fade_out(),
            ])
        }
        "ch06_outro" => {
            let st = stage(id, Theme::Lake, pip, &[a("pip", NpcRole::Huddle, 0.0)], &[("sun", 0.0, 1800.0, 0.6)]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                gaze("pip", 0.0, 1.0),
                say("pip", "A girl who loves bouncy things."),
                wait(0.6),
                ungaze("pip"),
                say("pip", "I'm going UP."),
                jump("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch7
        "ch07_intro" => {
            let mut actors = gang(&["gust1", "gust2"], 0xbfe8ff, 120.0, 180.0, 20.0);
            actors.push(a("pip", NpcRole::Huddle, -300.0));
            let st = stage(id, Theme::Chimney, pip, &actors, &[("sun", 0.0, 1700.0, 1.0)]);
            (st, vec![
                fade_in(),
                title(7, "Windy Chimneys"),
                follow("pip", 0.85),
                say("pip", "Hello, breezy friends?"),
                say("gust1", "Hee! Friends? We're WIND!"),
                push("pip", 500.0, 700.0),
                word("pip", "WHOOSH"),
                wait(1.2),
                say("gust2", "Again! Again!"),
                push("pip", -600.0, 600.0),
                wait(1.4),
                mood("pip", Mood::Worried),
                say("pip", "Please stop blowing me!"),
                unmood("pip"),
                wait(0.8),
                Beat::Say { who: "lulu".into(), text: "hee hee!".into() },
                gaze("pip", 0.0, 1.0),
                word("pip", "!?"),
                say("pip", "Did you hear that? From way up top!"),
                ungaze("pip"),
                fade_out(),
            ])
        }
        "ch07_outro" => {
            let st = stage(id, Theme::Chimney, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, -130.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.75),
                gaze("pip", 0.0, 1.0),
                say("pip", "A giggle. A nice one. A squishy one."),
                say("glimmer", "...The Glow is real."),
                ungaze("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch8
        "ch08_intro" => {
            let st = stage(id, Theme::Toys, pip, &[a("pip", NpcRole::Huddle, -400.0), Actor { id: "button", role: NpcRole::Granny, color: 0xb07a4f, x: 260.0, r: 46.0 }], &[("crayon", 80.0, 30.0, 1.6), ("block_letters", 520.0, 0.0, 1.2)]);
            (st, vec![
                fade_in(),
                title(8, "The Toy Pile"),
                follow("pip", 0.85),
                walk("pip", 40.0),
                say("pip", "A bear! Hi bear! Want to be friends?"),
                slow_cam(260.0, 200.0, 0.8, 0.7),
                say("button", "Name's Button. And no."),
                say("button", "Kids love you till they don't. Then you end up down here."),
                follow("pip", 0.8),
                mood("pip", Mood::Squash),
                say("pip", "Oh..."),
                unmood("pip"),
                slow_cam(260.0, 200.0, 0.8, 0.6),
                say("button", "...That crayon thing fell too. Read it if you like. I don't care."),
                follow("pip", 0.8),
                walk("pip", 80.0),
                say("pip", "L... U... L... U... loves... BOUNCY THINGS!"),
                mood("pip", Mood::Puff),
                jump("pip"),
                say("pip", "That's ME! I'm a bouncy thing!"),
                unmood("pip"),
                fade_out(),
            ])
        }
        "ch08_outro" => {
            let st = stage(id, Theme::Toys, pip, &[a("pip", NpcRole::Huddle, 0.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                Beat::Shake(1.2),
                word("pip", "RUMBLE"),
                wait(1.0),
                mood("pip", Mood::Worried),
                say("pip", "Uh oh. That came from below me."),
                unmood("pip"),
                fade_out(),
            ])
        }
        // ----------------------------------------------------------- ch9
        "ch09_intro" => {
            let mut actors = gang(&["g1", "g2", "g3"], 0x8a8f86, 80.0, 90.0, 26.0);
            actors.push(a("pip", NpcRole::Huddle, -500.0));
            let st = stage(id, Theme::CaveIn, pip, &actors, &[]);
            (st, vec![
                fade_in(),
                title(9, "The Cave-In"),
                follow("pip", 0.85),
                walk("pip", -60.0),
                say("g2", "Ugh. Rocks. On us. Typical."),
                say("pip", "Are you stuck? I'll get you out!"),
                say("g1", "We don't need help. We're Grumbles."),
                say("g3", "...we're very stuck though."),
                say("pip", "Hold on. I'm coming!"),
                fade_out(),
            ])
        }
        "ch09_outro" => {
            let mut actors = gang(&["g1", "g2", "g3", "g4"], 0x8a8f86, -200.0, 80.0, 26.0);
            actors.push(a("pip", NpcRole::Huddle, 250.0));
            let st = stage(id, Theme::CaveIn, pip, &actors, &[]);
            (st, vec![
                fade_in(),
                slow_cam(0.0, 220.0, 1.0, 0.8),
                say("g1", "...Thanks."),
                say("g2", "Now shoo."),
                follow("pip", 0.8),
                wait(0.6),
                say("pip", "You're welcome! Bye, Grumbles!"),
                stroll("g1", -800.0),
                stroll("g2", -800.0),
                stroll("g3", -800.0),
                stroll("g4", -800.0),
                wait(1.2),
                gaze("pip", 0.0, 1.0),
                say("pip", "Up it is. Still looking."),
                fade_out(),
            ])
        }
        // ---------------------------------------------------------- ch10
        "ch10_intro" => {
            let st = stage(id, Theme::Well, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, -130.0)], &[("sun", 0.0, 1800.0, 2.2)]);
            (st, vec![
                fade_in(),
                title(10, "The Light Well"),
                slow_cam(0.0, 1000.0, 1.7, 2.5),
                wait(2.2),
                follow("pip", 0.8),
                gaze("pip", 0.0, 1.0),
                say("pip", "There it is. The light."),
                wait(0.5),
                say("pip", "Okay, Pip. One more climb."),
                say("glimmer", "Go on. Bounce. I'll light the way."),
                ungaze("pip"),
                jump("pip"),
                fade_out(),
            ])
        }
        "ch10_outro" => {
            // The top of the climb: the cave opens onto daylight, and Lulu is
            // sitting just inside the mouth (drawn: see story/lulu.rs).
            let st = stage(
                id,
                Theme::Hollow,
                pip,
                &[a("pip", NpcRole::Huddle, -560.0)],
                &[(super::lulu::DAYLIGHT, 700.0, 0.0, 1.0), (super::lulu::DECOR, 540.0, 0.0, 0.9), ("glowworm", -500.0, 620.0, 1.0)],
            );
            (st, vec![
                Beat::Fade { to: 0.0, secs: 2.5 },
                slow_cam(260.0, 330.0, 1.0, 0.1),
                walk("pip", -260.0),
                gaze("pip", 1.0, 0.3),
                wait(0.8),
                say("lulu", "Ohhh! Look at you!"),
                word("pip", "!?"),
                say("lulu", "You're SO SQUISHY!"),
                say("pip", "...she likes squishy."),
                walk("pip", 220.0),
                gaze("pip", 1.0, 0.6),
                say("lulu", "And you BOUNCE! Do you want to come home with me? And play forever?"),
                wait(0.8),
                mood("pip", Mood::Puff),
                say("pip", "...Yes. YES!"),
                jump("pip"),
                push("pip", 260.0, 200.0),
                wait(1.0),
                say("lulu", "Hee hee! My bouncy friend!"),
                unmood("pip"),
                slow_cam(420.0, 330.0, 0.9, 2.5),
                wait(2.0),
            ])
        }
        _ => return None,
    };
    Some(Cutscene { id: id.into(), stage: stage_level, beats })
}

/// Lines spoken during a level when a story trigger fires, in order.
/// Speakers: "pip" (the player), "glimmer", "reg", "critter" (a nearby NPC),
/// "lulu" (off-screen), "tip" (a gameplay hint: Glimmer says it when she's
/// around, else a plain tip bubble; muted by the "Glimmer's hints" setting).
pub fn level_lines(id: &str) -> Vec<(&'static str, &'static str)> {
    let l: &[(&str, &str)] = match id {
        "ch02_hello" => &[("glimmer", "You AGAIN? Stop following my light."), ("pip", "I'm not following! I'm going UP!"), ("glimmer", "...Up is this way. Keep up.")],
        "ch03_hello" => &[("cap2", "Ooh, a blob! A wobbly one!"), ("cap1", "Bet it can't bounce like US!"), ("pip", "Watch me!")],
        "ch04_hello" => &[("tangle1", "Don't touch the vines."), ("tangle2", "Ever. EVER."), ("pip", "...noted!")],
        "ch05_hello" => &[("clonk", "CLONK."), ("pip", "Hi Clonk! Still a no-clonk?"), ("clonk", "...CLONK.")],
        "ch06_hello" => &[("reg", "Commoner! The lake is THAT way. Go AWAY that way."), ("pip", "Thanks, Your Softness!")],
        "ch07_hello" => &[("gust1", "Wheee! The blob's back!"), ("gust2", "Blow it! Blow it!"), ("pip", "Please don't blow it.")],
        "ch08_hello" => &[("button", "You again. Still looking for friends?"), ("pip", "Yep!"), ("button", "...Hmph. Good luck, kid.")],
        "ch09_hello" => &[("grumble", "Don't go in there. It's all rocks."), ("pip", "Is anybody stuck?"), ("grumble", "...maybe. Ugh. Fine. YES.")],
        "ch04_pods" => &[("tip", "Seed pod! Roll in, {jump} to fire."), ("pip", "Ptoo!")],
        "ch05_gears" => &[("tip", "Gears fling you. {Hold} to fly far!")],
        "ch07_balloon" => &[("tip", "{Hold} to float. Let go to sink."), ("glimmer", "Don't pop it. Anything sharp pops it.")],
        "ch07_needles" => &[("glimmer", "Needles everywhere. Stay central."), ("pip", "Middle. Got it. Gulp.")],
        "ch08_claw" => &[("pip", "A claw machine! I'm the prize!"), ("tip", "Sit under the claw. Free ride!")],
        "ch08_claw_chute" => &[("tip", "{Hold} as it drops. Be BIG!")],
        "ch01_goodbye" => &[("pip", "Hello? Anybody?"), ("pip", "...just me, then.")],
        "ch01_meet_glimmer" => &[
            ("glimmer", "EEK!"),
            ("glimmer", "...Oh. Ugh. A blob."),
            ("pip", "Hi! I'm Pip! You glow!"),
            ("glimmer", "I'm Glimmer. Watch and learn."),
        ],
        "ch01_first_hop" => &[("tip", "Lesson one: {jump} for a little hop."), ("tip", "{Hold} to swell up big and jump higher!")],
        "ch01_flower" => &[("tip", "Flowers remember you. Pop? Back here."), ("glimmer", "Not that I'd miss you.")],
        "ch01_pointy" => &[("pip", "Pointy."), ("tip", "Spikes pop. {Jump} over them!")],
        "ch01_jelly_stones" => &[("tip", "Jelly stones. Keep hopping!")],
        "ch01_squish" => &[("tip", "Low ceiling. {Down} to squish!"), ("pip", "Squish... squish... heh. SQUISH."), ("glimmer", "Ha! ...I mean. Hmph.")],
        "ch01_big_slope" => &[("pip", "Ooooooh."), ("tip", "Roll down fast, then {jump}!")],
        "ch01_not_bad" => &[("glimmer", "...Okay. That was actually pretty good."), ("pip", "You think I'm good?"), ("glimmer", "I think you're LOUD. ...And a bit good.")],
        "ch01_look_up" => &[
            ("pip", "That light again. It's all the way up there."),
            ("glimmer", "The Glow. Nobody ever goes."),
            ("pip", "I'm going!"),
            ("glimmer", "...Of course you are."),
        ],
        "ch02_drips" => &[("pip", "Plip... plop..."), ("tip", "Drips fall in a rhythm. Time your roll!")],
        "ch02_first_light" => &[("glimmer", "Another flower. You know the drill.")],
        "ch02_bridge_wobble" => &[("pip", "Wobbly... but it holds!"), ("glimmer", "Wobbly isn't broken. It's thinking.")],
        "ch02_membranes" => &[("tip", "Jelly doors: jump UP through.")],
        "ch02_up_feeling" => &[("pip", "Up up up!")],
        "ch02_push" => &[("pip", "Too wide to jump..."), ("tip", "So don't. Push the ball in. Cross on it!")],
        "ch02_mushroom_glow" => &[("pip", "Ooh, pink light. Maybe someone nice lives there?"), ("glimmer", "Doubt it.")],
        "ch03_fungus" => &[("critter", "Hee! A blob! Bounce it!")],
        "ch03_first_trampoline" => &[("tip", "Caps launch you. {Hold} as you land!")],
        "ch03_spring" => &[("tip", "Spring! {Hold} as you hit it!"), ("pip", "WHEEEEE!")],
        "ch03_chain" => &[("pip", "One bounce... two bounce... THREE!"), ("tip", "Steer in the air with {move}!")],
        "ch03_angled" => &[("pip", "*gulp*... okay. OKAY!")],
        "ch03_cavern" => &[("critter", "Up you go! Out you go! Hee hee!")],
        "ch03_bouncing_up" => &[("pip", "Bouncing is how you go UP!")],
        "ch04_vines" => &[("tip", "Grab a vine. {Jump} to let go!")],
        "ch04_swing_chain" => &[("tip", "Let go at the top of the swing.")],
        "ch04_climb" => &[("tip", "Climb with {updown}."), ("pip", "Hup... hup... hup!")],
        "ch04_traverse" => &[("critter", "Hey! That's OUR vine!"), ("pip", "Sorry! Just borrowing!")],
        "ch04_well" => &[("pip", "That's a long way up."), ("pip", "...good. Up is where I'm going.")],
        "ch04_remix" => &[("pip", "Vines, drips, wobbly bridges... all at once!")],
        "ch04_friends" => &[("pip", "I swung like I was born upside down!")],
        "ch05_thump" => &[("tip", "Go while the pistons rise!")],
        "ch05_crusher" => &[("critter", "CLONK."), ("pip", "...eep.")],
        "ch05_popped" => &[("pip", "Still me? Still me.")],
        "ch05_ferry" => &[("tip", "Hop on the ferry. Hold still.")],
        "ch05_rush" => &[("pip", "The floor is MOVING!")],
        "ch05_whole_trick" => &[("pip", "Pop. Reform. Keep going. That's the whole trick!")],
        "ch05_light" => &[("reg", "HALT! Who approaches the Royal Lake?!")],
        "ch06_lake" => &[("pip", "That's... a LOT of water."), ("tip", "Jelly floats! {Hold} to bob up.")],
        "ch06_float" => &[("tip", "{Jump} to kick. Push a bank to climb out.")],
        "ch06_reg_hail" => &[("reg", "HALT! You approach the court of HIS ROYAL SOFTNESS!")],
        "ch06_reg_tale" => &[("reg", "The SURFACE has a girl. She lost me. Probably on purpose."), ("reg", "Not that it's ANY of your business, commoner.")],
        "ch06_current" => &[("pip", "Wheeee!")],
        "ch06_against" => &[("tip", "Current too strong? Use the lily pads.")],
        "ch06_fountain" => &[("tip", "Float up the fountain!"), ("reg", "...AND MIND THE FOUNTAIN!")],
        "ch06_true_softness" => &[("pip", "A girl who loves bouncy things...")],
        "ch07_draft" => &[("critter", "Wheee! Blow the blob!")],
        "ch07_puff" => &[("tip", "{Hold} to float. Let go to sink."), ("pip", "Pfffff!")],
        "ch07_gust" => &[("critter", "Sideways! Hee hee!")],
        "ch07_fans" => &[("tip", "Float up and steer around the blades!")],
        "ch07_geysers" => &[("pip", "Hop, float, hop, float...")],
        "ch07_sticky" => &[("tip", "Sticky walls! {Jump} to wall-jump.")],
        "ch07_giggle" => &[("lulu", "hee hee!"), ("pip", "...!!"), ("pip", "Somebody's UP there!")],
        "ch08_midden" => &[("pip", "Boing! Hee! Boing!")],
        "ch08_ball_bridge" => &[("tip", "Push the ball in. Cross on top!")],
        "ch08_seesaw" => &[("pip", "Wheee-oh-no-wheee!")],
        "ch08_car" => &[("tip", "Ride the car's roof across!")],
        "ch08_slinky" => &[("pip", "Slinky... vines? Slinkies!")],
        "ch08_blocks" => &[("pip", "Wobbly... but they hold!")],
        "ch08_toybox" => &[("pip", "Boing! Up we go!")],
        "ch08_two_balls" => &[("pip", "That gap is ENORMOUS."), ("tip", "Fill the gap with balls. Cross!")],
        "ch08_lulu_drawing" => &[("pip", "L... U... L... U... loves... BOUNCY THINGS!"), ("pip", "That's ME!")],
        "ch09_rumble" => &[("critter", "help... help... ugh, fine, HELP."), ("pip", "Coming!")],
        "ch09_first_rescue" => &[("tip", "Touch a trapped Grumble to free it."), ("critter", "...Hmph. Thanks.")],
        "ch09_too_quiet" => &[("critter", "Why are you helping us? We're Grumbles."), ("pip", "Because you're stuck!")],
        "ch09_rubble" => &[("tip", "Wait for the rubble to rise, then GO.")],
        "ch09_flooded" => &[("pip", "Float, kick, paddle! You can do it!"), ("critter", "Grumble grumble *glub*")],
        "ch09_climb" => &[("critter", "...boing. Hmph. That's actually fun.")],
        "ch09_granny" => &[("critter", "The big one's stuck too. Old Grumbletop."), ("pip", "I've got you!")],
        "ch09_boulder" => &[("critter", "The floor fell in! We're stuck!"), ("pip", "Not stuck. Just... round about. Watch!"), ("tip", "Roll the boulder into the hole.")],
        "ch09_all_together" => &[("critter", "...You're alright, blob. Now shoo."), ("pip", "Bye, Grumbles!")],
        "ch10_well" => &[("pip", "Just me and the light now.")],
        "ch10_huddle" => &[("tip", "Jump up through the boards.")],
        "ch10_halfway" => &[("pip", "Halfway! Don't look down. ...I looked down.")],
        "ch10_giggle" => &[("lulu", "hmm hmm hmmm~ hee hee!"), ("pip", "Closer... closer!")],
        "ch10_daylight" => &[("pip", "...it's warm."), ("tip", "{Hold} to swell up into the light!")],
        "ch10_lulu" => &[("lulu", "OH! You're SO SQUISHY!")],
        _ => &[],
    };
    l.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_campaign_beat_has_words() {
        let mut missing = Vec::new();
        for level in bb_level::campaign::campaign() {
            for t in &level.story {
                if level_lines(&t.script).is_empty() {
                    missing.push(t.script.clone());
                }
            }
            for id in [&level.intro, &level.outro] {
                if !id.is_empty() && cutscene(id, 0xff5d73).is_none() {
                    missing.push(id.clone());
                }
            }
        }
        assert!(missing.is_empty(), "no script for: {missing:?}");
    }

    /// Chapter 1 is where Pip meets Glimmer, and she teaches every lesson.
    #[test]
    fn ch01_has_the_glimmer_meeting_and_her_lessons() {
        let ch01 = bb_level::campaign::chapter(1);
        let glimmer = ch01.npcs.iter().find(|n| n.id == bb_sim::npc::COMPANION).expect("no Glimmer companion in ch01");
        assert_eq!(glimmer.role, NpcRole::Glimmer);
        let at = |id: &str| ch01.story.iter().find(|t| t.script == id).unwrap_or_else(|| panic!("no {id} trigger in ch01"));
        // She's met early, near where she waits, before the first lesson.
        let meet = at("ch01_meet_glimmer");
        let (min, max) = meet.shape.bounds();
        assert!((glimmer.pos.x - (min.x + max.x) * 0.5).abs() < bb_sim::npc::COMPANION_MEET, "Glimmer waits too far from her meeting");
        let meet_lines = level_lines("ch01_meet_glimmer");
        assert_eq!(meet_lines[0].0, "glimmer");
        assert!(meet_lines.iter().any(|l| l.1.contains("Watch and learn")));
        let lessons = ["ch01_first_hop", "ch01_flower", "ch01_pointy", "ch01_jelly_stones", "ch01_squish", "ch01_big_slope"];
        for id in lessons {
            assert!(at(id).shape.bounds().0.x > max.x, "{id} comes before the meeting");
            // Lessons are hints (Glimmer says them) with live control names.
            assert!(level_lines(id).iter().any(|(who, _)| *who == "tip"), "{id} has no lesson");
        }
        let placeholders = lessons.iter().flat_map(|id| level_lines(id)).filter(|(_, t)| t.contains('{')).count();
        assert!(placeholders >= 4, "lessons lost their control placeholders");
        // No Glimmer in the intro (she hasn't been met yet); she leaves in the outro.
        let intro = cutscene("ch01_intro", 0xff5d73).unwrap();
        assert!(!intro.stage.npcs.iter().any(|n| n.role == NpcRole::Glimmer));
        let outro = cutscene("ch01_outro", 0xff5d73).unwrap();
        assert!(outro.stage.npcs.iter().any(|n| n.role == NpcRole::Glimmer));
        // And chapter 2 opens with her found again.
        assert!(bb_level::campaign::chapter(2).npcs.iter().any(|n| n.id == bb_sim::npc::COMPANION));
        assert_eq!(level_lines("ch02_hello")[0], ("glimmer", "You AGAIN? Stop following my light."));
    }

    /// Later chapters get Glimmer added at the start (not in cutscenes).
    #[test]
    fn glimmer_joins_every_later_chapter_once() {
        for n in 2..=super::super::CHAPTERS {
            let level = super::super::chapter_level(n);
            let count = level.npcs.iter().filter(|x| x.id == bb_sim::npc::COMPANION).count();
            assert_eq!(count, 1, "chapter {n}");
        }
    }
}

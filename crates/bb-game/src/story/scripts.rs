//! The words. Every cutscene of "Up & Out" (see docs/Story.md).

use bb_level::{LevelBuilder, NpcRole, PropKind, Theme, v};
use bb_sim::Vec2 as PVec2;

use super::Voice;
use super::cutscene::{Beat, Cutscene};

fn say(who: &str, text: &str) -> Beat {
    Beat::Say { who: who.into(), text: text.into() }
}
fn aside(who: &str, text: &str) -> Beat {
    Beat::Aside { who: who.into(), text: text.into() }
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
fn cam(x: f32, y: f32, zoom: f32) -> Beat {
    Beat::Cam { at: PVec2::new(x, y), zoom, ease: 0.8 }
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

/// The pile of Huddle blobs for chapter 1 / 9 / 10.
fn huddle(start_x: f32, n: usize) -> Vec<Actor> {
    const IDS: [&str; 8] = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"];
    (0..n.min(8)).map(|i| Actor { id: IDS[i], role: NpcRole::Huddle, color: 0, x: start_x + i as f32 * 66.0, r: 28.0 }).collect()
}

pub fn cutscene(id: &str, pip: u32) -> Option<Cutscene> {
    let (stage_level, beats) = match id {
        "ch01_intro" => {
            let mut actors = huddle(-120.0, 6);
            actors.push(Actor { id: "granny", role: NpcRole::Granny, color: 0, x: -380.0, r: 76.0 });
            actors.push(a("pip", NpcRole::Huddle, 360.0));
            let st = stage(id, Theme::Hollow, pip, &actors, &[("crystal", -900.0, 0.0, 1.2), ("glowworm", 300.0, 520.0, 1.5), ("crystal", 800.0, 0.0, 0.8)]);
            (st, vec![
                fade_in(),
                title(1, "Too Bouncy"),
                cam(0.0, 160.0, 1.0),
                say("granny", "Shhh. Everyone, squish together. It's time for the Great Stillness."),
                say("h3", "Mmmmm. Stillness."),
                aside("h5", "So still. So squish."),
                wait(0.6),
                follow("pip", 0.75),
                say("pip", "I'm still! I'm SO still! Look how still I am!"),
                puff("pip", 1.12, 0.4),
                wait(0.5),
                say("pip", "...a-a-aaah..."),
                Beat::SpeedLines(true),
                puff("pip", 1.45, 0.5),
                say("pip", "AH-CHOO!!"),
                jump("pip"),
                push("pip", -900.0, 500.0),
                Beat::Shake(1.0),
                word("pip", "BOING!"),
                Beat::Scatter { prefix: "h".into(), from: "pip".into(), speed: 900.0 },
                Beat::SpeedLines(false),
                cam(0.0, 200.0, 1.1),
                wait(1.8),
                say("granny", "...Pip."),
                follow("pip", 0.8),
                say("pip", "Sorry! Sorry! It was a HAPPY sneeze!"),
                cam(-200.0, 180.0, 0.9),
                say("granny", "The Huddle is for holding still, little one. And you are not a still sort of blob."),
                say("granny", "Go bounce somewhere else."),
                follow("pip", 0.8),
                wait(0.4),
                say("pip", "...okay."),
                walk("pip", 1300.0),
                fade_out(),
            ])
        }
        "ch01_outro" => {
            let st = stage(id, Theme::Hollow, pip, &[a("pip", NpcRole::Huddle, -200.0)], &[("sun", 0.0, 1500.0, 1.4), ("drip", 300.0, 900.0, 1.0)]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                walk("pip", 0.0),
                cam(0.0, 600.0, 1.3),
                word("pip", "!?"),
                wait(0.6),
                say("pip", "Whoa. What's all the way up there?"),
                say("pip", "Granny used to say the Glow is up there. Where True Softness lives."),
                follow("pip", 0.7),
                say("pip", "Maybe somebody up there likes bouncing."),
                hop("pip"),
                wait(0.4),
                hop("pip"),
                say("pip", "Okay. UP it is!"),
                fade_out(),
            ])
        }
        "ch02_intro" => {
            let st = stage(id, Theme::Drip, pip, &[a("pip", NpcRole::Huddle, -500.0), a("glimmer", NpcRole::Glimmer, 300.0)], &[("drip", -200.0, 700.0, 1.2), ("drip", 400.0, 760.0, 0.9), ("glowworm", 600.0, 600.0, 1.0)]);
            (st, vec![
                fade_in(),
                title(2, "The Drip"),
                follow("pip", 0.8),
                stroll("pip", -100.0),
                say("pip", "Hello? Is anybody down here?"),
                wait(0.4),
                word("pip", "plip!"),
                Beat::Shake(0.2),
                say("pip", "EEP!"),
                cam(80.0, 220.0, 0.9),
                say("glimmer", "Hiya! Don't mind the drips. I'm Glimmer! I light the mushrooms."),
                say("pip", "I'm Pip. I got kicked out for bouncing."),
                say("glimmer", "Kicked out? For BOUNCING? That's the best thing a blob can do!"),
                say("pip", "I'm going UP. To find True Softness."),
                say("glimmer", "Ooh, a quest! Up is a direction AND a feeling! Follow the glow drops, little wobble."),
                fade_out(),
            ])
        }
        "ch02_outro" => {
            let st = stage(id, Theme::Drip, pip, &[a("pip", NpcRole::Huddle, -100.0), a("glimmer", NpcRole::Glimmer, 150.0)], &[("mushroom", 500.0, 0.0, 2.0)]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("glimmer", "You bounce funny, you know."),
                say("pip", "...Is that bad?"),
                say("glimmer", "It's the BEST. The mushrooms ahead bounce back. They're gonna love you."),
                jump("pip"),
                word("pip", "yay!"),
                fade_out(),
            ])
        }
        "ch03_intro" => {
            let mut st = stage(id, Theme::Fungus, pip, &[a("pip", NpcRole::Huddle, -500.0), a("glimmer", NpcRole::Glimmer, -200.0)], &[("mushroom", -800.0, 0.0, 2.5), ("mushroom", 900.0, 0.0, 1.8)]);
            let mut b = LevelBuilder { level: st };
            b.mushroom(v(0.0, 0.0), 120.0, 220.0);
            st = b.build();
            (st, vec![
                fade_in(),
                title(3, "Mushroom Bounce"),
                follow("pip", 0.85),
                walk("pip", -40.0),
                say("pip", "This mushroom looks... springy."),
                jump("pip"),
                wait(0.9),
                word("pip", "BOING!"),
                say("pip", "Wheeee! It bounced ME!"),
                say("glimmer", "Everything down here was waiting for someone bouncy enough."),
                fade_out(),
            ])
        }
        "ch03_outro" => {
            let st = stage(id, Theme::Fungus, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, 200.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("pip", "Glimmer! Glimmer! Bouncing is how you go UP!"),
                say("glimmer", "Told ya."),
                hop("pip"),
                fade_out(),
            ])
        }
        "ch04_intro" => {
            let mut b = LevelBuilder { level: stage(id, Theme::Vines, pip, &[a("pip", NpcRole::Huddle, -300.0), a("glimmer", NpcRole::Glimmer, 100.0)], &[]) };
            b.vine(v(150.0, 700.0), 400.0).vine(v(450.0, 700.0), 380.0);
            (b.build(), vec![
                fade_in(),
                title(4, "Vine Gardens"),
                follow("pip", 0.85),
                say("glimmer", "These are glowroot vines. Jump and grab on, then swing!"),
                say("pip", "What if I fall?"),
                say("glimmer", "Then you bounce! And try again. Friends are just ropes you choose."),
                say("pip", "...Are you my rope, Glimmer?"),
                say("glimmer", "I'm more of a lamp. But YES."),
                fade_out(),
            ])
        }
        "ch04_outro" => {
            let st = stage(id, Theme::Vines, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, 200.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("pip", "I swung SO high! Did you see?!"),
                Beat::Shake(0.5),
                word("pip", "thoom"),
                wait(0.6),
                say("glimmer", "Hm. That's the Old Stone Works ahead. It's... not very squishy-friendly."),
                fade_out(),
            ])
        }
        "ch05_intro" => {
            let mut b = LevelBuilder { level: stage(id, Theme::Stoneworks, pip, &[a("pip", NpcRole::Huddle, -400.0), a("glimmer", NpcRole::Glimmer, -150.0)], &[]) };
            b.crusher(v(200.0, 520.0), 160.0, 420.0, 0.0);
            (b.build(), vec![
                fade_in(),
                title(5, "The Crusher Hall"),
                cam(0.0, 260.0, 1.0),
                wait(2.0),
                Beat::Shake(0.4),
                follow("pip", 0.8),
                say("pip", "...gulp."),
                say("glimmer", "Those old pistons don't care how soft you are. Watch, wait, then GO."),
                say("pip", "And if I get squished?"),
                say("glimmer", "You pop. Then you come back at the last mushroom. Pops aren't forever."),
                fade_out(),
            ])
        }
        "ch05_outro" => {
            let st = stage(id, Theme::Stoneworks, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, 180.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.7),
                puff("pip", 0.85, 1.6),
                say("pip", "I popped so many times."),
                say("glimmer", "You popped. You came back. That's the whole trick."),
                wait(0.4),
                puff("pip", 1.25, 0.6),
                say("pip", "...Yeah. YEAH!"),
                jump("pip"),
                fade_out(),
            ])
        }
        "ch06_intro" => {
            let mut b = LevelBuilder {
                level: stage(id, Theme::Lake, pip, &[a("pip", NpcRole::Huddle, -500.0), Actor { id: "reg", role: NpcRole::Reg, color: 0, x: 300.0, r: 36.0 }], &[]),
            };
            b.prop("teacup", PropKind::Custom { outline: vec![v(-70.0, 30.0), v(70.0, 30.0), v(50.0, -30.0), v(-50.0, -30.0)] }, v(300.0, 32.0), v(140.0, 60.0), 3.0, "#fff1f6");
            (b.build(), vec![
                fade_in(),
                title(6, "Puddle Lake"),
                cam(0.0, 200.0, 1.0),
                say("reg", "HALT! Who dares paddle in the ROYAL puddle?"),
                follow("pip", 0.85),
                say("pip", "Um. Hi? I'm Pip. Are you... a sock?"),
                cam(300.0, 200.0, 0.8),
                say("reg", "I am His Royal Softness, KING Reginald Sock the First!"),
                hop("reg"),
                say("reg", "And I have SEEN the SURFACE."),
                follow("pip", 0.8),
                word("pip", "!!"),
                say("pip", "You have?! What's up there?"),
                say("reg", "A GIRL. She lost me. Probably on purpose. Probably a ROYAL TEST."),
                say("reg", "She loves bouncy things. She would LOVE you. Not as much as me, obviously."),
                fade_out(),
            ])
        }
        "ch06_outro" => {
            let st = stage(id, Theme::Lake, pip, &[a("pip", NpcRole::Huddle, -100.0), Actor { id: "reg", role: NpcRole::Reg, color: 0, x: 200.0, r: 36.0 }], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                say("reg", "Go, small wobbler! Tell her the King says hello!"),
                say("reg", "And that I am FINE down here. Totally fine. Not lonely at ALL."),
                say("pip", "I'll tell her you miss her."),
                say("reg", "...Fine. Tell her that too."),
                fade_out(),
            ])
        }
        "ch07_intro" => {
            let st = stage(id, Theme::Chimney, pip, &[a("pip", NpcRole::Huddle, -200.0), a("glimmer", NpcRole::Glimmer, 100.0)], &[("sun", 0.0, 1700.0, 1.0)]);
            (st, vec![
                fade_in(),
                title(7, "Windy Chimneys"),
                follow("pip", 0.85),
                Beat::Aside { who: "lulu".into(), text: "hee hee!".into() },
                wait(1.2),
                word("pip", "!?"),
                say("pip", "Did you hear that? Somebody's laughing!"),
                say("glimmer", "It came down the chimney! Puff up big and the wind will carry you up!"),
                puff("pip", 1.3, 1.2),
                fade_out(),
            ])
        }
        "ch07_outro" => {
            let st = stage(id, Theme::Chimney, pip, &[a("pip", NpcRole::Huddle, 0.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.75),
                say("pip", "Somebody up there is laughing. A nice laugh. A squishy laugh."),
                fade_out(),
            ])
        }
        "ch08_intro" => {
            let st = stage(id, Theme::Toys, pip, &[a("pip", NpcRole::Huddle, -300.0), a("glimmer", NpcRole::Glimmer, 0.0)], &[("crayon", 80.0, 30.0, 1.6), ("block_letters", 300.0, 0.0, 1.2)]);
            (st, vec![
                fade_in(),
                title(8, "The Toy Pile"),
                follow("pip", 0.8),
                walk("pip", 60.0),
                say("pip", "There's writing on this block. L... U... L... U..."),
                say("pip", "Lulu loves... BOUNCY THINGS!"),
                word("pip", "!!!"),
                jump("pip"),
                say("pip", "That's ME! I'm a bouncy thing!"),
                say("glimmer", "All of this fell from up there. We must be close!"),
                fade_out(),
            ])
        }
        "ch08_outro" => {
            let st = stage(id, Theme::Toys, pip, &[a("pip", NpcRole::Huddle, 0.0), a("glimmer", NpcRole::Glimmer, 200.0)], &[]);
            (st, vec![
                fade_in(),
                follow("pip", 0.8),
                Beat::Shake(1.2),
                word("pip", "RUMBLE"),
                wait(1.0),
                say("pip", "What was THAT?"),
                say("glimmer", "It came from below. From... the Hollow."),
                say("pip", "The Huddle!"),
                fade_out(),
            ])
        }
        "ch09_intro" => {
            let mut actors = huddle(80.0, 4);
            actors.push(a("pip", NpcRole::Huddle, -500.0));
            let st = stage(id, Theme::CaveIn, pip, &actors, &[]);
            (st, vec![
                fade_in(),
                title(9, "The Cave-In"),
                follow("pip", 0.85),
                stroll("pip", -60.0),
                say("h2", "Pip?! Is that YOU?"),
                say("pip", "What are you all doing way up here?!"),
                say("h3", "We followed you. It was too quiet without you."),
                say("h1", "Then the ceiling fell on us. Quietly."),
                say("pip", "Hold on. I'm coming to get you. ALL of you."),
                fade_out(),
            ])
        }
        "ch09_outro" => {
            let mut actors = huddle(-200.0, 6);
            actors.push(Actor { id: "granny", role: NpcRole::Granny, color: 0, x: 400.0, r: 76.0 });
            actors.push(a("pip", NpcRole::Huddle, 150.0));
            let st = stage(id, Theme::CaveIn, pip, &actors, &[]);
            (st, vec![
                fade_in(),
                cam(150.0, 220.0, 1.0),
                say("granny", "Pip."),
                say("granny", "I was wrong. We were all so scared of how much you bounce."),
                say("granny", "Turns out bouncing is how you get UP."),
                follow("pip", 0.8),
                puff("pip", 1.15, 0.8),
                say("pip", "...Group squish?"),
                say("h4", "GROUP SQUISH!"),
                stroll("h1", 100.0),
                stroll("h2", 110.0),
                stroll("h3", 120.0),
                stroll("h4", 130.0),
                stroll("h5", 190.0),
                stroll("h6", 200.0),
                stroll("granny", 260.0),
                wait(1.6),
                word("pip", "squish!"),
                wait(1.0),
                fade_out(),
            ])
        }
        "ch10_intro" => {
            let mut actors = huddle(-300.0, 6);
            actors.push(Actor { id: "granny", role: NpcRole::Granny, color: 0, x: -520.0, r: 76.0 });
            actors.push(a("pip", NpcRole::Huddle, 200.0));
            actors.push(a("glimmer", NpcRole::Glimmer, 400.0));
            let st = stage(id, Theme::Well, pip, &actors, &[("sun", 0.0, 1800.0, 2.2)]);
            (st, vec![
                fade_in(),
                title(10, "The Light Well"),
                cam(0.0, 900.0, 1.6),
                wait(1.4),
                cam(-100.0, 220.0, 1.0),
                say("granny", "So that's the Glow."),
                follow("pip", 0.85),
                say("pip", "Everybody ready? We go up TOGETHER."),
                say("h2", "Together!"),
                say("h5", "BOUNCE!"),
                jump("pip"),
                jump("h1"),
                jump("h3"),
                jump("h6"),
                fade_out(),
            ])
        }
        "ch10_outro" => {
            let mut actors = huddle(-300.0, 6);
            actors.push(Actor { id: "granny", role: NpcRole::Granny, color: 0, x: -520.0, r: 76.0 });
            actors.push(a("pip", NpcRole::Huddle, 150.0));
            let mut b = LevelBuilder { level: stage(id, Theme::Playroom, pip, &actors, &[("block_letters", 700.0, 0.0, 1.4), ("lantern", -900.0, 700.0, 1.0)]) };
            b.ball(v(600.0, 200.0), 60.0, "#ffafcc").ball(v(-800.0, 300.0), 40.0, "#bde0fe").slab(v(-1100.0, 160.0), v(300.0, 60.0), 0.2);
            (b.build(), vec![
                Beat::Fade { to: 0.0, secs: 2.0 },
                cam(0.0, 260.0, 1.1),
                wait(1.2),
                say("lulu", "Ohhh! Look at you!"),
                follow("pip", 0.85),
                word("pip", "!?"),
                say("lulu", "You're SO SQUISHY!"),
                say("pip", "...She likes squishy."),
                say("lulu", "And you BOUNCE! Do you want to come play with me? Forever and ever?"),
                cam(-200.0, 240.0, 1.0),
                say("granny", "Forever is a very long time to hold still."),
                follow("pip", 0.8),
                say("pip", "Then let's NEVER hold still!"),
                jump("pip"),
                jump("h1"),
                jump("h2"),
                jump("h3"),
                jump("h4"),
                jump("granny"),
                wait(1.0),
                say("lulu", "Hee hee! BOUNCY!"),
                Beat::Title { title: "The End".into(), sub: "...of the beginning".into() },
                wait(1.0),
                fade_out(),
            ])
        }
        _ => return None,
    };
    Some(Cutscene { id: id.into(), stage: stage_level, beats })
}

/// Short lines spoken during a level when a story trigger fires.
/// Unknown ids are silently ignored so levels can be authored ahead of
/// the script.
pub fn level_lines(id: &str) -> Vec<(&'static str, Voice, &'static str)> {
    let lines: &[(&str, Voice, &str)] = match id {
        _ if id.contains("glimmer_bounce") => &[("glimmer", Voice::Glimmer, "Boing! See? The mushroom WANTS you to bounce.")],
        _ if id.contains("glimmer_vine") => &[("glimmer", Voice::Glimmer, "Grab on in the air! Push the stick to swing, tap to let go!")],
        _ if id.contains("glimmer_crusher") => &[("glimmer", Voice::Glimmer, "Wait for the thump... then GO!")],
        _ if id.contains("glimmer_wind") => &[("glimmer", Voice::Glimmer, "Hold the button to puff up! Big blobs float!")],
        _ if id.contains("glimmer_water") => &[("glimmer", Voice::Glimmer, "Puff up to float, let go to sink!")],
        _ if id.contains("glimmer") => &[("glimmer", Voice::Glimmer, "You're doing great, little wobble!")],
        _ if id.contains("reg") => &[("reg", Voice::Reg, "ONWARD, subject! Er. Friend. Subject-friend!")],
        _ if id.contains("granny") => &[("granny", Voice::Granny, "Careful now. ...But not TOO careful.")],
        _ if id.contains("huddle") || id.contains("trapped") => &[("player", Voice::Huddle, "Help! Over here! Come squish us free!")],
        _ if id.contains("lulu") || id.contains("giggle") => &[("lulu", Voice::Lulu, "hee hee!")],
        _ if id.contains("squeeze") => &[("player", Voice::Pip, "Squish... squish... SQUEEZE!")],
        _ => &[],
    };
    lines.to_vec()
}

//! The words. Every cutscene of "Up & Out" (see docs/Story.md).

use bb_level::{LevelBuilder, NpcRole, PropKind, Theme, v};
use bb_sim::Vec2 as PVec2;

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

/// Lines spoken during a level when a story trigger fires, in order.
/// Speakers: "pip" (the player who triggered it), "glimmer", "granny",
/// "reg", "huddle" (a nearby Huddle blob), "lulu" (off-screen), "tip".
pub fn level_lines(id: &str) -> Vec<(&'static str, &'static str)> {
    let l: &[(&str, &str)] = match id {
        "ch01_goodbye" => &[("granny", "...and mind the pointy bits."), ("pip", "*sniff* ...boing.")],
        "ch01_first_hop" => &[("tip", "Tap the button for a hop. Hold it to puff up and BOING!"), ("pip", "...hee.")],
        "ch01_pointy" => &[("pip", "Pointy."), ("tip", "Run and jump over the spikes!")],
        "ch01_squish" => &[("pip", "Squish... squish... heh. SQUISH.")],
        "ch01_big_slope" => &[("pip", "Ooooooh."), ("tip", "Roll down fast and jump at the bottom!")],
        "ch01_look_up" => &[("pip", "Is that... light? All the way up there?")],
        "ch02_drips" => &[("pip", "Plip... plop..."), ("tip", "Drips fall in a rhythm. Time your roll!")],
        "ch02_meet_glimmer" => &[("glimmer", "Ooh! A bouncy one!"), ("glimmer", "A wobble is just a hug that hasn't found its person yet!"), ("glimmer", "I'm Glimmer. I'm coming with you. That's decided.")],
        "ch02_first_light" => &[("glimmer", "Mushrooms remember you. Pop all you like!")],
        "ch02_bridge_wobble" => &[("glimmer", "Wobbly isn't broken. Wobbly is just thinking.")],
        "ch02_membranes" => &[("glimmer", "Jelly doors only open one way... UP!"), ("tip", "Jump up through the membranes.")],
        "ch02_up_feeling" => &[("glimmer", "Up is a direction AND a feeling!"), ("pip", "WHEEE!")],
        "ch02_mushroom_glow" => &[("glimmer", "Smell that? Mushrooms. Bouncy ones.")],
        "ch03_fungus" => &[("pip", "Boing? ...BOING! *squeal*")],
        "ch03_first_trampoline" => &[("tip", "Land on a mushroom cap to get launched!"), ("glimmer", "Some floors push back. Those are the good ones.")],
        "ch03_spring" => &[("tip", "Roll onto the spring pad!"), ("pip", "WHEEEEEE!")],
        "ch03_chain" => &[("glimmer", "One bounce leads to another. That's called momentum. Or friendship."), ("tip", "Steer in the air!")],
        "ch03_angled" => &[("pip", "*gulp*"), ("pip", "...okay. OKAY!")],
        "ch03_cavern" => &[("glimmer", "Up, up, UP!")],
        "ch03_bouncing_up" => &[("pip", "Bouncing is how you go UP!"), ("glimmer", "Told you.")],
        "ch04_vines" => &[("tip", "Jump into a vine to grab it. Stick to swing. Button to let go!")],
        "ch04_swing_chain" => &[("glimmer", "Let go at the top of the swing. Trust the swing.")],
        "ch04_climb" => &[("tip", "Stick up and down to climb."), ("pip", "Hup... hup... hup!")],
        "ch04_traverse" => &[("glimmer", "Friends are just ropes you choose.")],
        "ch04_well" => &[("pip", "That's a long way up."), ("pip", "...up is a feeling. Up is a FEELING!")],
        "ch04_remix" => &[("glimmer", "Everything you learned, all at once! That's called LIFE.")],
        "ch04_friends" => &[("glimmer", "You swing like you were born upside down!")],
        "ch05_thump" => &[("pip", "*flinch*"), ("tip", "Pistons slam, wait, then rise. Go while they rise!")],
        "ch05_crusher" => &[("pip", "...eep.")],
        "ch05_popped" => &[("glimmer", "Still you? Still you.")],
        "ch05_ferry" => &[("tip", "Wait for the ferry, hop on, and hold still.")],
        "ch05_rush" => &[("glimmer", "Sometimes the floor decides for you. Bounce anyway.")],
        "ch05_whole_trick" => &[("pip", "Hee... heehee... HAHA!"), ("glimmer", "You popped. You came back. That's the whole trick.")],
        "ch05_light" => &[("reg", "HALT! Who approaches the Royal Lake?!")],
        "ch06_lake" => &[("pip", "That's... a LOT of water."), ("glimmer", "Jelly floats, silly. You're basically a boat.")],
        "ch06_float" => &[("tip", "You float in water. Hold the button to puff up and bob higher!")],
        "ch06_reg_hail" => &[("reg", "HALT! You approach the court of HIS ROYAL SOFTNESS, KING REGINALD SOCK THE FIRST!"), ("glimmer", "That's Reg.")],
        "ch06_reg_tale" => &[("reg", "I fell from the SURFACE, you know. Years ago. On purpose. Probably."), ("reg", "Up there is the Glow. And a GIRL who loves bouncy things."), ("reg", "She'd love you. Not as much as me, obviously.")],
        "ch06_current" => &[("pip", "Wheeeee!")],
        "ch06_against" => &[("glimmer", "When the water says no, hop on the lily pads and say yes.")],
        "ch06_fountain" => &[("tip", "Float up the fountain!"), ("reg", "...AND MIND THE FOUNTAIN!")],
        "ch06_true_softness" => &[("pip", "True Softness..."), ("glimmer", "Every legend starts with someone silly enough to believe it.")],
        "ch07_draft" => &[("glimmer", "Hop in! The air wants to carry you.")],
        "ch07_puff" => &[("tip", "Hold the button to puff up and float. Let go to sink."), ("pip", "Pfffff!")],
        "ch07_gust" => &[("glimmer", "Lean into it. Or rather... let it lean into you.")],
        "ch07_fans" => &[("tip", "Float up and steer around the blades!")],
        "ch07_geysers" => &[("glimmer", "Hop, float, hop, float. Like a cloud with places to be.")],
        "ch07_sticky" => &[("tip", "Touch a sticky wall in the air to cling. Press the button to wall-jump!")],
        "ch07_giggle" => &[("lulu", "hee hee!"), ("pip", "...!!"), ("pip", "Somebody's UP there!")],
        "ch08_midden" => &[("pip", "Boing! Hee! Boing!")],
        "ch08_ball_bridge" => &[("tip", "Push the big ball into the pit, then hop across on top!")],
        "ch08_seesaw" => &[("pip", "Wheee-oh-no-wheee!")],
        "ch08_car" => &[("tip", "Hop on the car's roof and ride it across!")],
        "ch08_slinky" => &[("glimmer", "Same as vines, just more... slinky.")],
        "ch08_blocks" => &[("pip", "Wobbly... but they hold!")],
        "ch08_toybox" => &[("pip", "Boing! Up we go!")],
        "ch08_lulu_drawing" => &[("pip", "L... U... L... U... loves... BOUNCY THINGS!"), ("pip", "That's ME! I'm a bouncy thing!"), ("glimmer", "We must be close.")],
        "ch09_rumble" => &[("huddle", "help... help..."), ("pip", "That sounds like... the Huddle!")],
        "ch09_first_rescue" => &[("tip", "Touch a trapped blob to free it. It'll follow you!"), ("huddle", "We... followed you.")],
        "ch09_too_quiet" => &[("huddle", "It was too quiet without you."), ("huddle", "Nobody sneezed for DAYS.")],
        "ch09_rubble" => &[("glimmer", "Same trick as the pistons. Wait for the rise.")],
        "ch09_flooded" => &[("pip", "Float, puff, paddle! Like this!"), ("huddle", "Like... this? *glub*")],
        "ch09_climb" => &[("huddle", "Boing... boing... BOING!")],
        "ch09_granny" => &[("granny", "We were scared of how much you bounce, Pip."), ("granny", "Turns out bouncing is how you get UP.")],
        "ch09_all_together" => &[("granny", "Lead the way, little one.")],
        "ch10_well" => &[("huddle", "Conga line! Hee hee!")],
        "ch10_huddle" => &[("huddle", "Yaaay! ...quietly. Yay."), ("tip", "Jump up through the old boards. A slip only drops you one floor.")],
        "ch10_halfway" => &[("granny", "In my day we never went higher than a TOE.")],
        "ch10_giggle" => &[("lulu", "hmm hmm hmmm~ hee hee!"), ("glimmer", "I've never glowed this bright!")],
        "ch10_daylight" => &[("pip", "...it's warm."), ("tip", "Puff up into the light!")],
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
}

# Campaign script ids

Every cutscene / story-trigger id used by the campaign levels, with what it
should say or show. Intro/outro scripts play before/after a level (story
mode); the rest fire once when a player rolls into the trigger band
(`StoryTrigger`, a tall rectangle across the path). Mid-level beats should be
short (a bubble or two, 3–6 s, never blocking control for long). The words
live in `bb-game/src/story/scripts.rs` (`level_lines`).

Every chapter begins beside a sealed **entry cave** (the way back, plugged by
a rock-fall, glowing with the previous chapter's colour) and ends when Pip
rolls into the **exit cave** (glowing with the next chapter's colour); the
goal is inside that tunnel, so outros start with Pip in the glow.

Cast voices: Pip (high, squeaky), Granny Gloop (low, wobbly), Glimmer
(chimes, grumpy fortune-cookie wisdom), Reg (pompous), Huddle blobs (soft
murmurs), Lulu (only in ch10).

**Glimmer is Pip's tutor** (think Link's fairy). Pip meets her early in
chapter 1; from then on she is the *companion* (level NPC id
`glimmer_companion`, `bb_sim::npc::COMPANION`): a small weightless light
hovering at Pip's shoulder, behind and above, lagging a little. She passes
through everything, never pops, and pops back beside Pip after a respawn.
Chapter 1 places her at the meeting spot (she waits until Pip rolls within
320 px); from chapter 2 on, story mode adds her beside the spawn
(`story::glimmer::join`). She is never in a cutscene unless its cast lists
her.

Hints: every `tip` line (the lessons, with `{jump}`/`{hold}`/`{move}`/
`{down}`/`{updown}` filled in for the device in hand) is spoken by Glimmer
as her own bubble when she's in the level; without her it falls back to the
green tip bubble. Before she speaks after a quiet spell (8 s) she glows and
chimes for a moment, then talks. The pause menu's **Glimmer's Hints: On/Off**
(saved as `story.hints`) mutes the `tip` lines; her story lines still play.
Hints sit only where the old tips were: she doesn't nag.

## Chapter 1 — Too Bouncy (Huddle Hollow)

| id | what happens |
|---|---|
| `ch01_intro` | The Great Stillness: the Huddle squishes into one quiet blob-pile. Pip holds it… holds it… sneezes, *BOING*, cascade, the whole Huddle wobbles for an hour. Granny Gloop rolls Pip out of the Back Drip: "Go bounce somewhere else, little one." |
| `ch01_goodbye` | Alone by the Bottom Puddle. Pip: "Hello? Anybody?" … "…just me, then." |
| `ch01_meet_glimmer` | **Pip meets Glimmer**, dozing over the far end of the puddle (she waits at (1250, 200)). Glimmer: "EEK!" … "…Oh. Ugh. A blob." Pip: "Hi! I'm Pip! You glow!" Glimmer: "I'm Glimmer. And you look hopeless. Fine. Watch and learn." She tags along from here. |
| `ch01_first_hop` | Glimmer (hint): "Lesson one: {jump} for a little hop." / "{Hold} to swell up big and jump higher!" |
| `ch01_flower` | First checkpoint flower. Glimmer (hint): "Glowing flowers remember you. If you pop, you'll wobble back here." Then: "Not that I'd miss you." |
| `ch01_pointy` | Pip peers into the first spike pit. "Pointy." Glimmer (hint): "Spikes pop blobs. Roll with {move}, then {jump} right over them!" |
| `ch01_jelly_stones` | Wobbly jelly stepping stones over spikes. Glimmer (hint): "Wobbly jelly stones. Hop from one to the next, and don't stop!" |
| `ch01_squish` | The crawlspace. Glimmer (hint): "Low ceiling. {Down} to squish flat and squeeze through." Pip: "Squish… squish… heh. SQUISH." Glimmer: "Ha! …I mean. Hmph." (the first crack in the grump) |
| `ch01_big_slope` | Top of the ridge, a huge jelly slope below. Pip: "Ooooooh." Glimmer (hint): "Roll down fast, then {jump} off the bump at the bottom. Big one!" |
| `ch01_not_bad` | After the kicker leap. Glimmer: "…Okay. That was actually pretty good." Pip: "You think I'm good?" Glimmer: "I think you're LOUD. …And a bit good." |
| `ch01_look_up` | The tall shaft; far above, a pinprick of light. Pip: "That light again…" Glimmer: "The Glow. Everyone dreams about it. Nobody goes." Pip: "I'm going!" Glimmer: "…Of course you are." |
| `ch01_outro` | Pip stares up at the light. Glimmer: "Yep. Very far. Very up." Pip: "Will you come with me?" Glimmer: "ME? Ha! No. Lesson's over, blob." She flits off: "And don't follow me!" Pip: "…bye, Glimmer." … "That's okay. I'm bouncy." |

## Chapter 2 — The Drip (Drip Tunnels)

| id | what happens |
|---|---|
| `ch02_intro` | Pip finds Glimmer again, "hiding" by a glowworm. Pip: "Glimmer! There you are!" Glimmer: "Shh! I'm hiding. From YOU." Pip: "You glow. You're really easy to find." Glimmer: "…Ugh." |
| `ch02_hello` | At the spawn, Glimmer right beside Pip (the companion again): "You AGAIN? Stop following my light." Pip: "I'm not following! I'm going UP!" Glimmer: "…Up is this way. Keep up." |
| `ch02_drips` | Plip… plop. Hint: drips fall in a rhythm; time your roll. |
| `ch02_first_light` | The first checkpoint flower. Glimmer: "Another glowing flower. You know the drill." |
| `ch02_bridge_wobble` | First soft bridge sags under Pip. Pip: "Wobbly… but it holds!" Glimmer: "Wobbly isn't broken. Wobbly is just thinking." |
| `ch02_membranes` | The membrane shaft. Glimmer: "Jelly doors only open one way… up!" Hint: jump up through membranes. |
| `ch02_up_feeling` | At the top of the shaft. Glimmer: "Up is a direction AND a feeling!" Pip bounces higher than before. |
| `ch02_push` | A trench far too wide to jump, spikes at the bottom, a huge jelly ball beside it. Pip: "Too wide to jump..." Hint: push the ball in, roll across on top. (First push puzzle.) |
| `ch02_mushroom_glow` | Warm light ahead: the Fungus Caverns. Pip: "Maybe someone nice lives there?" Glimmer: "Doubt it." |
| `ch02_outro` | Pip: "Nobody down here wants to share a light." Glimmer: "…I'm sharing mine. Technically." Pip: "Glimmer!" Glimmer: "Don't make it weird." Then the pink glow ahead. |

## Chapter 3 — Mushroom Bounce (Fungus Caverns)

| id | what happens |
|---|---|
| `ch03_hello` | The Puffcaps tease you at the start. |
| `ch03_intro` | The Fungus Caverns glow orange and pink; giant caps wobble. Pip's eyes go huge (sparkle eyes). Glimmer: "Go on. Bounce. Nobody here minds." |
| `ch03_fungus` | Pip bounces once, cautiously, then again, bigger. A tiny squeal. |
| `ch03_first_trampoline` | Hint: land on a mushroom cap to get **launched**. Glimmer: "Some floors push back. Those are the good ones." |
| `ch03_spring` | A spring pad. Hint: roll onto it. Pip, mid-air: "WHEEEE!" |
| `ch03_chain` | A row of caps over a spiky pit. Glimmer: "One bounce leads to another. That's called momentum. Or friendship." Hint: steer in the air. |
| `ch03_angled` | A tilted spring aimed across a big gap. Pip gulps, then grins. |
| `ch03_cavern` | Bottom of a tall cavern ringed with caps. Glimmer: "Up, up, up!" |
| `ch03_bouncing_up` | Top of the climb. Pip realises: bouncing is how you go *up*. Pure joy, little speed lines. Glimmer: "Told you." |
| `ch03_outro` | Pip: "They didn't want me…" Glimmer: "Their loss. …Don't tell anyone I said that." Pip bounces: bouncing is how you go UP. |

## Chapter 4 — Vine Gardens (Glowroot Grotto)

| id | what happens |
|---|---|
| `ch04_hello` | The Tangles warn you off their vines. |
| `ch04_intro` | Glowing roots and dangling vines sway like they're listening. Glimmer swings on one, giggling. "Grab on! Vines love a hug." |
| `ch04_vines` | Hint: jump into a vine to **grab** it; stick to swing; button to **let go** (with a big fling). A soft basin waits below the first one. |
| `ch04_swing_chain` | Two vines over spikes. Glimmer: "Let go at the top of the swing. Trust the swing." |
| `ch04_climb` | A tall vine up a cliff. Hint: stick up/down to **climb**. Pip, climbing: "Hup… hup… hup!" |
| `ch04_traverse` | A long run of vines climbing over a spiky gulf. Glimmer: "Friends are just ropes you choose." (Bounce-Buddies in co-op: hold hands = grab each other.) |
| `ch04_well` | A well of vines. Pip looks up; it's a long way. Then grins: up is a feeling. |
| `ch04_remix` | Rope bridge over goo, with drips. Glimmer: "Everything you learned, all at once! That's called *life*." |
| `ch04_friends` | Pip lands the big fling; Glimmer applauds (chimes). "You swing like you were born upside down." |
| `ch04_outro` | Beyond the vines, a rhythmic THUMP… THUMP… of old stone machines. Pip's bounce falters. |

## Chapter 5 — The Crusher Hall (Old Stone Works)

| id | what happens |
|---|---|
| `ch05_hello` | Clonk: "CLONK." |
| `ch05_intro` | The Old Stone Works: huge, cold, rhythmic. THUMP. THUMP. Pip's bounce gets small. Glimmer's light flickers nervously. |
| `ch05_thump` | Pip flinches at every thump. Hint: pistons slam, wait, then rise; go when they're rising. |
| `ch05_crusher` | A piston squashes a crate flat (it wobbles back, offended). Pip: "…eep." |
| `ch05_popped` | (After the first crusher run, usually after a pop or two.) Pip reforms at the mushroom, dizzy. Glimmer, gently: "Still you? Still you." |
| `ch05_ferry` | A rickety stone ferry slides over spikes. Hint: wait for it, ride it, stand still. |
| `ch05_rush` | A conveyor rushes toward three pistons. Glimmer: "Sometimes the floor decides for you. Bounce anyway." |
| `ch05_whole_trick` | The low point turns. Pip, after yet another pop, reforms and *laughs*. Glimmer: "You popped. You came back. That's the whole trick." Pip bounces at full size again. |
| `ch05_light` | Out of the works; damp air and the shimmer of water ahead. A distant, pompous voice echoes: "HALT! Who approaches the Royal Lake?!" |
| `ch05_outro` | Pip: "I popped so many times." Glimmer: "You popped. You came back. That's the whole trick." Pip: "…but I'm still me. Still looking." |

## Chapter 6 — Puddle Lake (Underground Lake)

| id | what happens |
|---|---|
| `ch06_hello` | Reg shoos you toward the lake. |
| `ch06_intro` | A vast, still, glittering lake. Somewhere across it, a teacup on an island, and a sock in the teacup, posing. |
| `ch06_lake` | Pip has never seen so much water. Wobble of nerves. Glimmer: "Jelly floats, silly. You're basically a boat." |
| `ch06_float` | Hint: in water you float; hold the button to puff up and bob higher. Paddle to the far bank. |
| `ch06_reg_hail` | (Approaching the island.) A booming voice: "HALT! You approach the court of HIS ROYAL SOFTNESS, KING REGINALD SOCK THE FIRST!" Glimmer: "That's Reg." |
| `ch06_reg_tale` | **Reg's court.** Reg, lounging in his teacup: he fell down the well years ago from *the surface*. He tells of the Glow, a crack of daylight at the top of the Old Well, and of **the Girl** who lost him, "the warmest, softest thing in the world." True Softness! He gets the details hilariously wrong (the Girl is "approximately the size of a mountain and made entirely of pillows"). Completely unreliable; also completely right. He points the way: "Follow the current, little jelly. Up the fountain. Tell her Reg sends his regards." |
| `ch06_current` | The river grabs Pip and whooshes along; crates bob past. Pip: "Wheee!" |
| `ch06_against` | The current now runs the wrong way. Glimmer: "When the water says no, hop on the lily pads and say yes." |
| `ch06_fountain` | A column of water rising straight up. Hint: float up it. Reg, faintly, from far below: "AND MIND THE FOUNTAIN!" |
| `ch06_true_softness` | Pip, on the terrace, looks up: "True Softness…" Glimmer: "Every legend starts with someone silly enough to believe it." |
| `ch06_outro` | A warm draught blows down from above, ruffling Glimmer. Wind whistles through tall flues. |

## Chapter 7 — Windy Chimneys (Updraft Flues)

| id | what happens |
|---|---|
| `ch07_hello` | The Gusties are back. |
| `ch07_intro` | A warm wind howls up through tall stone flues. Glimmer is blown about like a kite, giggling. |
| `ch07_draft` | A strong updraft. Glimmer: "Hop in! The air wants to carry you." |
| `ch07_puff` | This updraft is gentler. Hint: **hold the button to puff up** and float; let go to sink. Pip puffs into a balloon: "Pfff!" |
| `ch07_gust` | A sideways gust over spikes. Glimmer: "Lean into it. Or rather, let it lean into you." |
| `ch07_fans` | A flue full of slowly spinning fan blades. Hint: float up, steer around the blades. |
| `ch07_geysers` | Puffing geysers over a spiky floor. Glimmer: "Hop, float, hop, float. Like a cloud with places to be." |
| `ch07_sticky` | A chimney lined with sticky moss. Hint: touch a sticky wall in the air to cling; press the button to wall-jump. |
| `ch07_giggle` | At the top of the great updraft, everything goes quiet… then, echoing down the flue from impossibly far above, a little girl's **giggle**. Pip freezes, then bounces so hard it squeaks. Glimmer, softly: "The Glow is real." |
| `ch07_outro` | Pip: "A giggle. A nice one. A squishy one." Glimmer, softly: "…The Glow is real." |

## Chapter 8 — The Toy Pile (Lost-Toy Midden)

| id | what happens |
|---|---|
| `ch08_hello` | Button the teddy, gruff but kind. |
| `ch08_intro` | Mountains of fallen toys, bright and bonkers: blocks, balls, crayons, a wind-up car whirring in circles. Glimmer: "Everything that falls down the well ends up here. Including, apparently, us." |
| `ch08_midden` | Pip boings off a rubber ball, giggles, boings off another. The crazy chapter begins. |
| `ch08_ball_bridge` | A huge bouncy ball and a spiky V-shaped pit too wide to jump. Hint: **push** the ball into the pit, then hop across on top of it. |
| `ch08_seesaw` | A see-saw plank over a ball pit. Pip walks it; it tips; Pip squeaks; it tips back. "Wheee-oh-no-wheee!" |
| `ch08_car` | A wind-up car trundles back and forth over a spiky track. Hint: hop on the roof and ride it across (lean into its motion). |
| `ch08_slinky` | Slinkies dangle from the heap. Glimmer: "Same as vines, just more… slinky." |
| `ch08_blocks` | A staircase of giant toy blocks, each with a letter. They wobble, but they hold. |
| `ch08_toybox` | A big toy box with a spring on top. Pip boings up onto the lid. |
| `ch08_two_balls` | (After the drawing.) The lid ends at an ENORMOUS spiky gap; two big balls on the lid. Hint: push the balls in and hop across their tops. |
| `ch08_lulu_drawing` | On the lid: a crayon drawing, wobbly letters: **LULU ♥ BOUNCY THINGS**, with a stick-figure girl hugging a round, smiling blob. Pip stares. Glimmer, very quietly: "…She likes bouncy things." Pip bounces once, slowly, then very fast. |
| `ch08_outro` | A deep RUMBLE. Dust falls. From far behind and below: the faint, familiar murmur of many blobs. |

## Chapter 9 — The Cave-In (Collapsed Hollow)

| id | what happens |
|---|---|
| `ch09_hello` | A Grumble at the cave-in mouth. |
| `ch09_intro` | (Continues from ch08's rumble.) The tunnels shudder; rocks rain down. Pip races back the way it came, toward the sound of familiar murmurs. |
| `ch09_rumble` | Dust, cracks, a muffled chorus of "help… help…" in soft Huddle voices. Pip's eyes go wide. |
| `ch09_first_rescue` | A Huddle blob wedged in a dip. Hint: **touch** a trapped blob to free it; it follows you. The blob, sheepish: "We… followed you." |
| `ch09_too_quiet` | Freed blobs bunch up behind Pip. One whispers: "It was too quiet without you." Another: "Nobody sneezed for DAYS." |
| `ch09_rubble` | Falling rubble with a blob trapped between drops. Glimmer: "Same trick as the pistons. Wait for the rise." |
| `ch09_flooded` | A flooded hall. The Huddle has never swum. Pip demonstrates: float, puff, paddle. They copy, badly, adorably. |
| `ch09_climb` | The climb to where Granny was last seen. The Huddle chant "boing… boing… BOING" as Pip hops each step. |
| `ch09_granny` | **Granny Gloop**, pinned under a fallen slab, too big to wriggle free. Pip touches her; she pops loose and wobbles, then says, quietly: "We were scared of how much you bounce. Turns out bouncing is how you get UP." A long, squishy hug. |
| `ch09_boulder` | Past Granny: the last collapse left a spiky hole and a round boulder. A Grumble: "We're stuck!" Pip: "Not stuck. Just... round about." Hint: roll the boulder in (the Huddle crosses on top). |
| `ch09_all_together` | The whole Huddle lines up behind Pip. Granny: "Lead the way, little one." Above them: the bottom of an old stone well, and a faint ring of daylight far, far up. |
| `ch09_outro` | Everyone looks up the Old Well. Glimmer: "Well, well, well." (Nobody laughs. Glimmer laughs anyway.) |

## Chapter 10 — The Light Well (The Old Well)

| id | what happens |
|---|---|
| `ch10_intro` | The bottom of the Old Well. A tiny circle of daylight, impossibly far up. Pip: "Okay, Pip. One more climb." Glimmer: "Go on. Bounce. I'll light the way." |
| `ch10_well` | A sagging bridge over goo on the way in; the Huddle crosses it in a wobbly conga line, giggling. |
| `ch10_huddle` | First glow mushroom in the well. The Huddle cheers (softly; old habits). Hint: the well has old one-way boards; jump up through them, and a slip only drops you to the boards below. |
| `ch10_halfway` | Halfway up. Pip looks down: the whole Huddle bouncing up behind. Granny, puffing: "In my day we never went higher than a TOE." |
| `ch10_giggle` | The giggle again, much closer now, and humming. Light is warmer. Glimmer starts to glow brighter than ever. |
| `ch10_daylight` | Warm light spills down the well; everyone squints. Pip puffs up into the final updraft and floats up into the cave at the top. Slow motion, sparkles. |
| `ch10_lulu` | The top cave: at its far (left) end, the mouth opens onto blazing daylight, and **Lulu** is crouched just inside it, eyes huge: "OH! You're SO SQUISHY!" (Lulu stands at about (-1880, 9650), inside the exit tunnel, facing right; the trigger is the band at x -1000..-950; the goal is at x -1890..-1660 on the tunnel floor, y 9650.) |
| `ch10_outro` | **Finale.** Lulu scoops up every blob (Granny last, who protests and then melts) and carries them to her playroom: pillows, blankets, a trampoline bed. True Softness. Play, forever. Reg's sock turns up in the laundry basket. Credits roll in a softbody playroom you can bounce around in. |

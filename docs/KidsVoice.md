# Kids Mode voice pack

Bundled ElevenLabs TTS clips for Kids Mode (no Web Speech on happy path).

## Location

`public/sfx/kids/` — `letter-a.mp3`…`letter-z.mp3`, `color-*.mp3`, `shape-*.mp3`

## Regenerate

```sh
# from bouncy-blobs/
./scripts/generate-kids-voice.sh --force      # all
./scripts/generate-kids-voice.sh letter-a color-red
```

Requires `games/scripts/.env` → `ELEVENLABS_API_KEY` and monorepo venv
`games/scripts/.venv` (or system python with `elevenlabs` + `python-dotenv`).

Default voice: Jessica (`cgSgspJ2msm6clMCkdW9`). Override: `--voice-id` or `KIDS_VOICE_ID`.

### Kids v3 sung clips

- **Spoken text is only the word** (`A!` / `Red!` / `Star!`) — never bracket
  tags or prose like “Singing a clear musical note…” (those were read aloud).
- Phonetic letter-names for ambiguous letters: A→`Ayyy!`, E→`Eeee!` (long
  vowels), H→`Aitch!`, P→`Pee!`, U→`You!`, Y→`Why!`.
- Model: `eleven_multilingual_v2` with expressive `VoiceSettings` (style ~0.7).
- Override: `--model-id` / `KIDS_VOICE_MODEL`, `--voice-id` / `KIDS_VOICE_ID`.

## Runtime

- `src/utils/kidsVoice.ts` — play/stop clips
- Expand edge (Space / pad): Alphabet → `kidsAbc.onExpand()`; Music → Twinkle;
  Shape → `playKidsShape`. **One** lesson voice per edge; **all** blobs puff.
- Color pick / friend pick → `playKidsColor` (or shape in Shape mode)

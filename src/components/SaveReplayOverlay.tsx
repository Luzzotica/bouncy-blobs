// Save Replay — shown during the results phase. Saving requires sign-in
// (anonymous players get the sign-in modal). The recorded replay is held in
// memory until the next match starts.

import { useState } from 'react';
import { CloudContent, encodeReplay, LoginRequiredError } from '../lib/party';
import { roomConfig, GAME_ID } from '../lib/partyConfig';
import { getLastReplay } from '../replay/replayRecorder';
import { SignInModal } from './SignInModal';
import { COLORS, paperPanel, actionBtn } from '../theme/uiTheme';

const cloud = new CloudContent({ baseUrl: roomConfig.baseUrl, apiKey: roomConfig.apiKey, gameId: GAME_ID });

export function SaveReplayOverlay() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'signin'>('idle');
  const [code, setCode] = useState<string | null>(null);
  const rep = getLastReplay();
  if (!rep) return null;

  const save = async () => {
    setState('saving');
    try {
      const { share_code } = await cloud.publish({
        contentType: 'replay',
        name: `Match ${new Date().toLocaleString()}`,
        data: encodeReplay(rep),
        visibility: 'unlisted',
      });
      setCode(share_code);
      setState('saved');
    } catch (err) {
      if (err instanceof LoginRequiredError) setState('signin');
      else setState('idle');
    }
  };

  if (state === 'signin') {
    return <SignInModal cloud={cloud} onClose={() => setState('idle')} onSignedIn={() => void save()} />;
  }

  return (
    <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 50, ...paperPanel, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
      {state === 'saved' ? (
        <span style={{ color: COLORS.green, fontWeight: 700 }}>✓ Replay saved · code {code}</span>
      ) : (
        <button style={actionBtn(COLORS.green)} onClick={() => void save()} disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : '💾 Save Replay'}
        </button>
      )}
    </div>
  );
}

// My Replays — the signed-in player's saved matches. Anonymous players have
// none (saving requires sign-in), so this doubles as a sign-in prompt.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudContent, type CloudItem } from '../lib/party';
import { roomConfig, GAME_ID } from '../lib/partyConfig';
import { SignInModal } from '../components/SignInModal';
import { COLORS, paperPanel, paperBtn, actionBtn } from '../theme/uiTheme';

const cloud = new CloudContent({ baseUrl: roomConfig.baseUrl, apiKey: roomConfig.apiKey, gameId: GAME_ID });

export default function MyReplays() {
  const navigate = useNavigate();
  const [replays, setReplays] = useState<CloudItem[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    const isIn = await cloud.isSignedIn();
    setSignedIn(isIn);
    if (!isIn) { setReplays([]); return; }
    try { setReplays(await cloud.listMine({ contentType: 'replay', limit: 50 })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load replays'); setReplays([]); }
  };
  useEffect(() => { void load(); }, []);
  const remove = async (id: string) => { await cloud.remove(id).catch(() => {}); void load(); };

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderBottom: `1px solid ${COLORS.inkFaint}33` };

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, padding: 24, display: 'flex', justifyContent: 'center' }}>
      <div style={{ ...paperPanel, width: 'min(560px, 92vw)', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <button style={paperBtn} onClick={() => navigate('/')}>◀ Back</button>
          <h1 style={{ margin: 0, color: COLORS.titleInk }}>My Replays</h1>
        </div>
        {signedIn === false && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <p style={{ color: COLORS.inkDim, marginBottom: 14 }}>Sign in to save and rewatch your matches.</p>
            <button style={actionBtn(COLORS.green)} onClick={() => setShowSignIn(true)}>Sign in</button>
          </div>
        )}
        {error && <p style={{ color: COLORS.danger }}>{error}</p>}
        {signedIn && replays && replays.length === 0 && (
          <p style={{ color: COLORS.inkDim, textAlign: 'center', padding: 24 }}>No replays yet — save one from the results screen after a match.</p>
        )}
        {replays && replays.map((r) => (
          <div key={r.id} style={row}>
            <button style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: COLORS.ink, fontSize: 16, cursor: 'pointer' }} onClick={() => navigate(`/replay/${r.id}`)}>▶ {r.name}</button>
            <span style={{ color: COLORS.inkFaint, fontSize: 12 }}>{new Date(r.created_at).toLocaleDateString()}</span>
            <button style={paperBtn} onClick={() => remove(r.id)}>Delete</button>
          </div>
        ))}
      </div>
      {showSignIn && <SignInModal cloud={cloud} onClose={() => setShowSignIn(false)} onSignedIn={() => { setShowSignIn(false); void load(); }} />}
    </div>
  );
}

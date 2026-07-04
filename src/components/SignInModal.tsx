// Sign-in modal — email accounts via the Lobbii hosted flow (CloudContent).
// Publishing (levels, replays) requires a real identity; anonymous device
// players save locally only. Styled from the cream-paper-and-tape uiTheme.

import { useState } from 'react';
import type { CloudContent } from '../lib/party';
import { COLORS, paperPanel, actionBtn, paperBtn } from '../theme/uiTheme';

export function SignInModal({
  cloud,
  onClose,
  onSignedIn,
}: {
  cloud: CloudContent;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'up') await cloud.signUpWithEmail(email.trim(), password);
      else await cloud.signInWithEmail(email.trim(), password);
      onSignedIn();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: '10px 12px',
    borderRadius: 8, border: `2px solid ${COLORS.inkFaint}`, background: COLORS.paperInput,
    color: COLORS.ink, fontSize: 15, fontFamily: 'inherit',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={onClose}>
      <div style={{ ...paperPanel, width: 340, padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', color: COLORS.titleInk }}>{mode === 'in' ? 'Sign in' : 'Create account'}</h3>
        <p style={{ color: COLORS.inkDim, fontSize: 13, margin: '0 0 16px' }}>Sign in to save replays and share your levels.</p>
        <input style={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <input style={input} type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        {msg && <p style={{ color: COLORS.danger, fontSize: 13, margin: '6px 0' }}>{msg}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={actionBtn(COLORS.green)} onClick={() => void submit()} disabled={busy}>
            {busy ? '…' : mode === 'in' ? 'Sign in' : 'Create'}
          </button>
          <button style={paperBtn} onClick={onClose}>Cancel</button>
        </div>
        <button style={{ background: 'none', border: 'none', color: COLORS.blue, fontSize: 12, marginTop: 12, cursor: 'pointer', width: '100%' }}
          onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null); }}>
          {mode === 'in' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}

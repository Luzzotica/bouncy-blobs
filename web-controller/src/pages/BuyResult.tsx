import React from 'react';

// Where Stripe Checkout sends the phone after paying for the full game
// (/paid) or backing out (/cancelled). The game asked partii for the
// checkout with these as success_url / cancel_url (crates/bb-game/src/
// buy_flow.rs, docs/BuyFlow.md). Nobody is signed in on the phone and the
// page needs nothing from the network: the game on the big screen sees the
// purchase by itself within a few seconds.

type Kind = 'paid' | 'cancelled';

const COPY: Record<Kind, { title: string; body: string; hint: string; blob: string }> = {
  paid: {
    title: 'Paid! Look at your screen',
    body: 'Bouncy Blobs is unlocking on your computer right now: all 10 chapters, hosting a Party with phones, and Sandbox.',
    hint: 'You can close this page. Thanks for buying Bouncy Blobs!',
    blob: '#ffc75f',
  },
  cancelled: {
    title: 'No worries',
    body: 'Nothing was charged. The demo is still yours to play, and friends can always join you for free.',
    hint: 'Changed your mind? Scan the code on your screen again.',
    blob: '#c77dff',
  },
};

export default function BuyResult({ kind }: { kind: Kind }) {
  const c = COPY[kind];
  React.useEffect(() => {
    document.title = `Bouncy Blobs · ${c.title}`;
  }, [c.title]);
  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        padding: '40px 24px',
        boxSizing: 'border-box',
        background: '#1b1226',
        color: '#fff',
        textAlign: 'center',
        fontFamily: "'Fredoka', system-ui, -apple-system, sans-serif",
        // This page is read, not played: let it scroll and select like a page.
        overflowY: 'auto',
        touchAction: 'auto',
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
      data-testid={`buy-${kind}`}
    >
      <div
        aria-hidden
        style={{
          width: 96,
          height: 84,
          borderRadius: '50% 50% 46% 46% / 58% 58% 42% 42%',
          background: c.blob,
          border: '5px solid rgba(0,0,0,0.25)',
          boxShadow: 'inset -10px -12px 0 rgba(0,0,0,0.12)',
          position: 'relative',
          animation: 'bb-wobble 1.6s ease-in-out infinite',
        }}
      >
        <span style={{ position: 'absolute', top: 26, left: 26, width: 10, height: 14, borderRadius: 6, background: '#1a0f2e' }} />
        <span style={{ position: 'absolute', top: 26, right: 26, width: 10, height: 14, borderRadius: 6, background: '#1a0f2e' }} />
        <span
          style={{
            position: 'absolute',
            top: 46,
            left: '50%',
            width: kind === 'paid' ? 30 : 22,
            height: kind === 'paid' ? 14 : 6,
            transform: 'translateX(-50%)',
            borderRadius: kind === 'paid' ? '0 0 16px 16px' : 4,
            background: '#1a0f2e',
          }}
        />
      </div>
      <h1 style={{ margin: 0, fontSize: 'clamp(28px, 8vw, 40px)', lineHeight: 1.15, textShadow: '3px 4px 0 rgba(0,0,0,0.45)' }}>{c.title}</h1>
      <p style={{ margin: 0, maxWidth: 420, fontSize: 18, lineHeight: 1.45, color: '#ffeec0' }}>{c.body}</p>
      <p style={{ margin: 0, maxWidth: 420, fontSize: 15, lineHeight: 1.4, color: '#b9a8d6' }}>{c.hint}</p>
      <style>{'@keyframes bb-wobble{0%,100%{transform:scale(1,1)}30%{transform:scale(1.08,0.92)}60%{transform:scale(0.95,1.05)}}'}</style>
    </div>
  );
}

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SignalingService } from '../lib/party';
import { partyConfig } from '../lib/partyConfig';

export default function JoinLobby() {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval>>();

  const signalingRef = useRef(new SignalingService(partyConfig));

  const handleCodeSubmit = useCallback(async () => {
    if (!joinCode.trim()) return;
    setCodeError('');
    setLookingUp(true);

    try {
      const session = await signalingRef.current.lookupByCode(joinCode.trim());
      navigate(`/controller/${session.session_id}`);
    } catch (err: any) {
      setCodeError(err.message?.includes('404') || err.message?.includes('No active')
        ? 'No game found with that code'
        : 'Failed to look up code');
    } finally {
      setLookingUp(false);
    }
  }, [joinCode, navigate]);

  // QR scanner — uses camera + BarcodeDetector API (Chrome/Safari)
  const startScanning = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      setScanning(true);

      // Wait for video element to mount
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      });

      // Use BarcodeDetector if available
      if ('BarcodeDetector' in window) {
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        scanIntervalRef.current = setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const barcodes = await detector.detect(videoRef.current);
            for (const barcode of barcodes) {
              const url = barcode.rawValue as string;
              // Match /controller/<sessionId> in the URL
              const match = url.match(/\/controller\/([a-f0-9-]+)/i);
              if (match) {
                stopScanning();
                navigate(`/controller/${match[1]}`);
                return;
              }
            }
          } catch { /* ignore detection errors */ }
        }, 500);
      }
    } catch (err) {
      console.warn('Camera access denied:', err);
      setCodeError('Camera access denied');
    }
  }, [navigate]);

  const stopScanning = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = undefined;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    return () => { stopScanning(); };
  }, [stopScanning]);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px 16px',
      overflow: 'auto',
      background: '#0f0f1a',
      color: '#fff',
    }}>
      <h1 style={{ color: '#c77dff', margin: '0 0 8px', fontSize: 28 }}>
        Bouncy Blobs
      </h1>
      <p style={{ color: '#888', margin: '0 0 32px', fontSize: 14 }}>
        Join a game
      </p>

      {/* Join by code */}
      <div style={{
        width: '100%',
        maxWidth: 340,
        background: '#1a1a2e',
        borderRadius: 12,
        padding: '20px',
        marginBottom: 20,
      }}>
        <p style={{ color: '#aaa', fontSize: 13, margin: '0 0 12px', textAlign: 'center' }}>
          Enter game code
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="text"
            placeholder="ABC123"
            value={joinCode}
            onChange={e => {
              setJoinCode(e.target.value.toUpperCase());
              setCodeError('');
            }}
            onKeyDown={e => e.key === 'Enter' && handleCodeSubmit()}
            maxLength={8}
            style={{
              width: '100%',
              padding: '14px',
              fontSize: 'clamp(18px, 5vw, 24px)',
              fontWeight: 'bold',
              letterSpacing: 5,
              background: '#0f0f1a',
              border: '2px solid #333',
              borderRadius: 8,
              color: '#fff',
              textAlign: 'center',
              textTransform: 'uppercase',
              boxSizing: 'border-box',
            }}
            autoFocus
          />
          <button
            onClick={handleCodeSubmit}
            disabled={lookingUp || !joinCode.trim()}
            style={{
              width: '100%',
              padding: '14px 22px',
              fontSize: 16,
              fontWeight: 'bold',
              background: joinCode.trim() ? '#c77dff' : '#444',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: joinCode.trim() ? 'pointer' : 'default',
              opacity: lookingUp ? 0.6 : 1,
            }}
          >
            {lookingUp ? '...' : 'Join'}
          </button>
        </div>
        {codeError && (
          <p style={{ color: '#f66', fontSize: 12, margin: '8px 0 0', textAlign: 'center' }}>{codeError}</p>
        )}
      </div>

      {/* Divider */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        maxWidth: 340,
        marginBottom: 20,
      }}>
        <div style={{ flex: 1, height: 1, background: '#333' }} />
        <span style={{ color: '#555', fontSize: 12 }}>or</span>
        <div style={{ flex: 1, height: 1, background: '#333' }} />
      </div>

      {/* QR Scanner */}
      {scanning ? (
        <div style={{
          width: '100%',
          maxWidth: 340,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{
            width: 260,
            height: 260,
            borderRadius: 16,
            overflow: 'hidden',
            border: '3px solid #c77dff',
            position: 'relative',
          }}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {/* Scan overlay corners */}
            <div style={{
              position: 'absolute',
              inset: 0,
              border: '2px solid rgba(199, 125, 255, 0.4)',
              borderRadius: 12,
              pointerEvents: 'none',
            }} />
          </div>
          <p style={{ color: '#888', fontSize: 12 }}>Point at the QR code on the host screen</p>
          <button
            onClick={stopScanning}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              background: 'transparent',
              border: '1px solid #444',
              borderRadius: 6,
              color: '#888',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={startScanning}
          style={{
            width: '100%',
            maxWidth: 340,
            padding: '16px',
            fontSize: 16,
            fontWeight: 'bold',
            background: '#1a1a2e',
            color: '#c77dff',
            border: '2px solid #2a3a5a',
            borderRadius: 12,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 22 }}>&#x1F4F7;</span>
          Scan QR Code
        </button>
      )}
    </div>
  );
}

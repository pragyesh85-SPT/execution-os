import jsQR from 'jsqr';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

// Camera QR scanner (pure JS decoder, works in Chrome, Edge, Electron and the Android WebView).

export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let last = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scan = (t: number) => {
      raf = requestAnimationFrame(scan);
      const v = videoRef.current;
      if (!v || !ctx || v.readyState < 2 || t - last < 120 || done.current) return;
      last = t;
      const w = 480;
      const h = Math.round((v.videoHeight / v.videoWidth) * w) || 480;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code?.data) {
        done.current = true;
        onResult(code.data);
      }
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device/browser does not allow camera access here. Use the backup code.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        raf = requestAnimationFrame(scan);
      } catch (err) {
        const e = err as Error;
        setError(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it, or type the backup code.' : e.message || 'Camera unavailable — type the backup code.');
      }
    })();

    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  if (error) {
    return <p style={{ color: 'var(--bad)', fontSize: 14, margin: 0 }}>{error}</p>;
  }
  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted />
      <div className="frame" />
      <motion.div className="scanline" initial={{ top: '20%' }} animate={{ top: ['20%', '80%', '20%'] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />
    </div>
  );
}

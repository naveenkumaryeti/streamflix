import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

/**
 * Thin wrapper around a <video> element that speaks HLS.
 *
 * Safari (and iOS generally) plays .m3u8 natively, so hls.js is only attached when
 * `Hls.isSupported()` is true — loading it unconditionally would fight the native player.
 */
export default function VideoPlayer({ src, startAt = 0, onTimeUpdate, onEnded, poster }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return undefined;

    let cancelled = false;

    const seekToStart = () => {
      if (startAt > 0 && !cancelled) video.currentTime = startAt;
    };

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, seekToStart);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          // eslint-disable-next-line no-console
          console.error('HLS fatal error', data);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', seekToStart, { once: true });
    }

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <video
      ref={videoRef}
      className="video-player"
      controls
      autoPlay
      playsInline
      poster={poster}
      onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime, e.currentTarget.duration)}
      onEnded={onEnded}
    />
  );
}

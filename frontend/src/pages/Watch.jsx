import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as playbackApi from '../api/playback.js';
import VideoPlayer from '../components/VideoPlayer.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

const PING_INTERVAL_MS = 20000;

export default function Watch() {
  const { titleId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastPositionRef = useRef(0);
  const lastDurationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    playbackApi
      .startPlayback(titleId)
      .then((data) => {
        if (!cancelled) setSession(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [titleId]);

  // Heartbeat: keeps the stream slot alive and saves resume position.
  useEffect(() => {
    if (!session) return undefined;
    const interval = setInterval(() => {
      if (lastPositionRef.current > 0) {
        playbackApi
          .pingProgress(titleId, {
            positionSeconds: lastPositionRef.current,
            durationSeconds: lastDurationRef.current || undefined,
          })
          .catch(() => {});
      }
    }, PING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session, titleId]);

  // Stop the session (releases the stream slot, saves final position) on unmount.
  useEffect(
    () => () => {
      playbackApi
        .stopPlayback(titleId, {
          positionSeconds: lastPositionRef.current || undefined,
          durationSeconds: lastDurationRef.current || undefined,
          sessionId: session?.session?.id,
        })
        .catch(() => {});
    },
    [titleId, session],
  );

  const handleTimeUpdate = (current, duration) => {
    lastPositionRef.current = current;
    if (duration && Number.isFinite(duration)) lastDurationRef.current = duration;
  };

  const handleEnded = () => {
    playbackApi
      .pingProgress(titleId, {
        positionSeconds: lastDurationRef.current || lastPositionRef.current,
        durationSeconds: lastDurationRef.current || undefined,
        completed: true,
      })
      .catch(() => {});
  };

  if (loading) return <Loader full label="Starting playback…" />;

  if (error) {
    const subscriptionRequired = error.code === 'SUBSCRIPTION_REQUIRED' || error.status === 402;
    return (
      <div className="watch-error">
        <ErrorBanner error={error} />
        {subscriptionRequired ? (
          <Link to="/subscription" className="btn btn--primary">
            Choose a plan
          </Link>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={() => navigate(-1)}>
            Go back
          </button>
        )}
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="watch-screen">
      <button type="button" className="watch-screen__back" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <VideoPlayer
        src={session.source.url}
        startAt={session.resumeAt || 0}
        poster={session.title.backdropUrl || session.title.posterUrl}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
      />
      <h1 className="watch-screen__title">{session.title.title}</h1>
    </div>
  );
}

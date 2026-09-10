import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as catalogApi from '../api/catalog.js';
import { useAuth } from '../context/AuthContext.jsx';
import TitleRow from '../components/TitleRow.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

function formatRuntime(seconds) {
  if (!seconds) return null;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return hrs ? `${hrs}h ${mins}m` : `${mins}m`;
}

export default function TitleDetail() {
  const { slug } = useParams();
  const { isAuthenticated, entitlement } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listBusy, setListBusy] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    catalogApi
      .getTitle(slug)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleList = async () => {
    if (!data) return;
    setListBusy(true);
    try {
      if (data.title.inList) await catalogApi.removeFromMyList(data.title.id);
      else await catalogApi.addToMyList(data.title.id);
      setData((d) => ({ ...d, title: { ...d.title, inList: !d.title.inList } }));
    } catch (err) {
      setError(err);
    } finally {
      setListBusy(false);
    }
  };

  if (loading) return <Loader full label="Loading title…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!data) return null;

  const { title, similar, progress } = data;
  const canWatch = title.playable;
  const needsSubscription = isAuthenticated && !entitlement?.active;

  return (
    <div className="title-detail">
      <div className="title-detail__hero" style={{ backgroundImage: `url(${title.backdropUrl || ''})` }}>
        <div className="hero__scrim" />
        <div className="title-detail__content">
          <h1>{title.title}</h1>
          <div className="hero__meta">
            {title.releaseYear && <span>{title.releaseYear}</span>}
            {title.maturityRating && <span className="tag">{title.maturityRating}</span>}
            {formatRuntime(title.runtimeSeconds) && <span>{formatRuntime(title.runtimeSeconds)}</span>}
            {title.averageRating && <span>★ {Number(title.averageRating).toFixed(1)}</span>}
          </div>
          <p className="hero__synopsis">{title.synopsis}</p>

          {title.genres?.length > 0 && (
            <p className="title-detail__line">
              <strong>Genres:</strong> {title.genres.join(', ')}
            </p>
          )}
          {title.cast?.length > 0 && (
            <p className="title-detail__line">
              <strong>Cast:</strong> {title.cast.join(', ')}
            </p>
          )}
          {title.director && (
            <p className="title-detail__line">
              <strong>Director:</strong> {title.director}
            </p>
          )}

          <div className="hero__actions">
            {canWatch ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => (isAuthenticated ? navigate(`/watch/${title.id}`) : navigate('/login'))}
              >
                ▶ {progress?.positionSeconds ? 'Resume' : 'Play'}
              </button>
            ) : (
              <button type="button" className="btn btn--disabled" disabled>
                Processing — check back soon
              </button>
            )}
            {isAuthenticated && (
              <button type="button" className="btn btn--ghost" onClick={toggleList} disabled={listBusy}>
                {title.inList ? '✓ In My List' : '+ My List'}
              </button>
            )}
          </div>

          {needsSubscription && (
            <p className="notice">
              You'll need an active plan to press play. <Link to="/subscription">Choose a plan →</Link>
            </p>
          )}
        </div>
      </div>

      {similar?.length > 0 && (
        <div className="home__rows">
          <TitleRow title="More like this" items={similar} />
        </div>
      )}
    </div>
  );
}

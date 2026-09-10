import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

export default function Hero({ items }) {
  const [index, setIndex] = useState(0);
  const list = items?.filter(Boolean) ?? [];

  useEffect(() => {
    if (list.length < 2) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % list.length), 7000);
    return () => clearInterval(id);
  }, [list.length]);

  if (!list.length) return null;
  const title = list[index % list.length];

  return (
    <section className="hero" style={{ backgroundImage: `url(${title.backdropUrl || title.posterUrl || ''})` }}>
      <div className="hero__scrim" />
      <div className="hero__content">
        <h1>{title.title}</h1>
        {title.synopsis && <p className="hero__synopsis">{title.synopsis}</p>}
        <div className="hero__meta">
          {title.releaseYear && <span>{title.releaseYear}</span>}
          {title.maturityRating && <span className="tag">{title.maturityRating}</span>}
          {(title.genres || []).slice(0, 3).map((g) => (
            <span key={g} className="tag tag--muted">
              {g}
            </span>
          ))}
        </div>
        <div className="hero__actions">
          <Link to={`/watch/${title.id}`} className="btn btn--primary">
            ▶ Play
          </Link>
          <Link to={`/title/${title.slug}`} className="btn btn--ghost">
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}

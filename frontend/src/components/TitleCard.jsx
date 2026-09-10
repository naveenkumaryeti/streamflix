import { Link } from 'react-router-dom';

const FALLBACK_POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="330"><rect width="100%" height="100%" fill="#1c1c22"/><text x="50%" y="50%" fill="#666" font-family="sans-serif" font-size="16" text-anchor="middle">No artwork</text></svg>',
  );

export default function TitleCard({ title, progressPercent }) {
  if (!title) return null;
  return (
    <Link to={`/title/${title.slug}`} className="title-card" title={title.title}>
      <div className="title-card__poster">
        <img src={title.posterUrl || FALLBACK_POSTER} alt={title.title} loading="lazy" />
        {title.inList && <span className="title-card__badge">✓ My List</span>}
        {typeof progressPercent === 'number' && progressPercent > 0 && (
          <div className="title-card__progress">
            <div className="title-card__progress-bar" style={{ width: `${Math.min(100, progressPercent)}%` }} />
          </div>
        )}
      </div>
      <div className="title-card__meta">
        <span className="title-card__title">{title.title}</span>
        <span className="title-card__sub">
          {title.releaseYear || ''} {title.maturityRating ? `· ${title.maturityRating}` : ''}
        </span>
      </div>
    </Link>
  );
}

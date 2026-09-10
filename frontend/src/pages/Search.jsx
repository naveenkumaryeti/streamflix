import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as catalogApi from '../api/catalog.js';
import TitleCard from '../components/TitleCard.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q) {
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    catalogApi
      .search(q)
      .then(setResult)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [q]);

  return (
    <div className="page">
      <h1 className="page__heading">{q ? `Results for "${q}"` : 'Search'}</h1>
      {loading && <Loader label="Searching…" />}
      <ErrorBanner error={error} />
      {result && result.items.length === 0 && !loading && <p className="empty-state">No titles matched your search.</p>}
      {result && result.items.length > 0 && (
        <div className="grid">
          {result.items.map((item) => (
            <TitleCard key={item.id} title={item} />
          ))}
        </div>
      )}
      {!q && <p className="empty-state">Type something in the search bar above to find a title.</p>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import * as catalogApi from '../api/catalog.js';
import TitleCard from '../components/TitleCard.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function MyList() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    catalogApi
      .myList({ limit: 60 })
      .then((data) => setItems(data.items))
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="page">
      <h1 className="page__heading">My List</h1>
      {loading && <Loader label="Loading your list…" />}
      <ErrorBanner error={error} onRetry={load} />
      {items && items.length === 0 && !loading && (
        <p className="empty-state">Nothing here yet — add titles from any title page.</p>
      )}
      {items && items.length > 0 && (
        <div className="grid">
          {items.map((item) => (
            <TitleCard key={item.id} title={item} />
          ))}
        </div>
      )}
    </div>
  );
}

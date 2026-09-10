import { useEffect, useState } from 'react';
import * as catalogApi from '../api/catalog.js';
import Hero from '../components/Hero.jsx';
import TitleRow from '../components/TitleRow.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    catalogApi
      .browse()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <Loader full label="Loading StreamFlix…" />;
  if (error) return <ErrorBanner error={error} onRetry={load} />;
  if (!data) return null;

  return (
    <div className="home">
      <Hero items={data.hero} />
      <div className="home__rows">
        {data.rows.map((row) => (
          <TitleRow key={row.key} title={row.title} items={row.items} />
        ))}
      </div>
    </div>
  );
}

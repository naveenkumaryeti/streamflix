import { useEffect, useState } from 'react';
import * as adminApi from '../../api/admin.js';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

function displayValue(value) {
  if (value === null || value === undefined) return '—';

  if (typeof value === 'object') {
    if ('count' in value) return value.count;
    return JSON.stringify(value);
  }

  return value;
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <div className="stat-card__value">{displayValue(value)}</div>
      <div className="stat-card__label">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);

    adminApi
      .dashboard()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <Loader label="Loading dashboard…" />;
  }

  if (error) {
    return <ErrorBanner error={error} onRetry={load} />;
  }

  if (!data) {
    return null;
  }

  const { catalogue, users, subscriptions, pipeline } = data;

  return (
    <div>
      <h1 className="page__heading">Dashboard</h1>

      {/* Catalogue */}
      <section>
        <h2 className="section-heading">Catalogue</h2>

        <div className="stat-grid">
          <Stat
            label="Total titles"
            value={catalogue?.totalTitles}
          />

          <Stat
            label="Published"
            value={catalogue?.publishedTitles}
          />

          <Stat
            label="Processing"
            value={catalogue?.processingTitles}
          />

          <Stat
            label="Draft"
            value={catalogue?.draftTitles}
          />

          <Stat
            label="Failed"
            value={catalogue?.failedTitles}
          />
        </div>
      </section>

      {/* Users */}
      <section>
        <h2 className="section-heading">Users</h2>

        <div className="stat-grid">
          <Stat
            label="Total users"
            value={users?.total}
          />

          <Stat
            label="New (7 days)"
            value={users?.newLast7Days}
          />

          <Stat
            label="Active (30 days)"
            value={users?.activeLast30Days}
          />

          <Stat
            label="Admins"
            value={users?.admins}
          />
        </div>
      </section>

      {/* Subscriptions */}
      {subscriptions && (
        <section>
          <h2 className="section-heading">Subscriptions by status</h2>

          <div className="stat-grid">
            {Array.isArray(subscriptions)
              ? subscriptions.map(({ status, count }, index) => (
                  <Stat
                    key={`${status}-${index}`}
                    label={status}
                    value={count}
                  />
                ))
              : Object.entries(subscriptions).map(
                  ([status, count]) => (
                    <Stat
                      key={status}
                      label={status}
                      value={count}
                    />
                  )
                )}
          </div>
        </section>
      )}

      {/* Transcode Pipeline */}
      {pipeline?.counts && (
        <section>
          <h2 className="section-heading">Transcode pipeline</h2>

          <div className="stat-grid">
            {Object.entries(pipeline.counts).map(
              ([status, count]) => (
                <Stat
                  key={status}
                  label={status}
                  value={count}
                />
              )
            )}
          </div>
        </section>
      )}
    </div>
  );
}
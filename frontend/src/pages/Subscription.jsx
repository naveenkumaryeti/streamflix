import { useEffect, useState } from 'react';
import * as subsApi from '../api/subscriptions.js';
import { useAuth } from '../context/AuthContext.jsx';
import Loader from '../components/Loader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';

function money(cents, currency) {
  if (cents === undefined || cents === null) return '';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' }).format(cents / 100);
}

function CardForm({ planCode, onSubscribed }) {
  const [card, setCard] = useState({ number: '', name: '', expMonth: '', expYear: '', cvc: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (e) => setCard((c) => ({ ...c, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await subsApi.subscribe({
        planCode,
        card: { ...card, expMonth: Number(card.expMonth), expYear: Number(card.expYear) },
        idempotencyKey: crypto.randomUUID(),
      });
      onSubscribed(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card-form" onSubmit={submit}>
      <ErrorBanner error={error} />
      <label>
        Name on card
        <input required value={card.name} onChange={update('name')} />
      </label>
      <label>
        Card number
        <input required inputMode="numeric" placeholder="4242 4242 4242 4242" value={card.number} onChange={update('number')} />
      </label>
      <div className="card-form__row">
        <label>
          Exp. month
          <input required inputMode="numeric" placeholder="MM" maxLength={2} value={card.expMonth} onChange={update('expMonth')} />
        </label>
        <label>
          Exp. year
          <input required inputMode="numeric" placeholder="YYYY" maxLength={4} value={card.expYear} onChange={update('expYear')} />
        </label>
        <label>
          CVC
          <input required inputMode="numeric" placeholder="123" maxLength={4} value={card.cvc} onChange={update('cvc')} />
        </label>
      </div>
      <p className="field-hint">This is a mock payment provider — any plausible card number works.</p>
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? 'Processing…' : 'Confirm and pay'}
      </button>
    </form>
  );
}

export default function Subscription() {
  const { refreshEntitlement } = useAuth();
  const [plans, setPlans] = useState(null);
  const [current, setCurrent] = useState(null);
  const [payments, setPayments] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const loadAll = () => {
    setLoading(true);
    setError(null);
    Promise.all([subsApi.listPlans(), subsApi.currentSubscription(), subsApi.payments({ limit: 10 })])
      .then(([p, c, pay]) => {
        setPlans(p.items);
        setCurrent(c);
        setPayments(pay.items);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(loadAll, []);

  const onSubscribed = async () => {
    setSelectedPlan(null);
    await refreshEntitlement();
    loadAll();
  };

  const cancel = async (immediate) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await subsApi.cancelSubscription({ immediate });
      await refreshEntitlement();
      loadAll();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(false);
    }
  };

  const resume = async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await subsApi.resumeSubscription();
      await refreshEntitlement();
      loadAll();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) return <Loader full label="Loading plans…" />;
  if (error) return <ErrorBanner error={error} onRetry={loadAll} />;

  const activePlanCode = current?.subscription?.planCode;

  return (
    <div className="page page--narrow">
      <h1 className="page__heading">Subscription</h1>

      {current?.subscription && (
        <section className="panel">
          <h2>Current plan</h2>
          <p>
            <strong>{current.subscription.planName}</strong> · {current.subscription.status}
            {current.subscription.cancelAtPeriodEnd && ' (ends at period close)'}
          </p>
          {current.subscription.currentPeriodEnd && (
            <p className="field-hint">
              Renews / ends: {new Date(current.subscription.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}
          <ErrorBanner error={actionError} />
          <div className="hero__actions">
            {current.subscription.cancelAtPeriodEnd ? (
              <button type="button" className="btn btn--primary" onClick={resume} disabled={actionBusy}>
                Resume subscription
              </button>
            ) : (
              <>
                <button type="button" className="btn btn--ghost" onClick={() => cancel(false)} disabled={actionBusy}>
                  Cancel at period end
                </button>
                <button type="button" className="btn btn--danger" onClick={() => cancel(true)} disabled={actionBusy}>
                  Cancel immediately
                </button>
              </>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Plans</h2>
        <div className="plans-grid">
          {plans.map((plan) => (
            <div key={plan.code} className={`plan-card ${plan.code === activePlanCode ? 'plan-card--active' : ''}`}>
              <h3>{plan.name}</h3>
              <div className="plan-card__price">
                {money(plan.priceCents, plan.currency)}
                <span>/{plan.billingInterval}</span>
              </div>
              <p>{plan.description}</p>
              <ul>
                <li>{plan.maxStreams} simultaneous stream{plan.maxStreams === 1 ? '' : 's'}</li>
                <li>Up to {plan.maxQuality}</li>
                {(plan.features || []).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {plan.code === activePlanCode ? (
                <button type="button" className="btn btn--disabled" disabled>
                  Current plan
                </button>
              ) : (
                <button type="button" className="btn btn--primary btn--block" onClick={() => setSelectedPlan(plan.code)}>
                  {activePlanCode ? 'Switch to this plan' : 'Subscribe'}
                </button>
              )}
              {selectedPlan === plan.code && <CardForm planCode={plan.code} onSubscribed={onSubscribed} />}
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Payment history</h2>
        {payments.length === 0 && <p className="empty-state">No payments yet.</p>}
        {payments.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td>{money(p.amountCents, p.currency)}</td>
                  <td>
                    <span className={`status status--${p.status}`}>{p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as adminApi from '../../api/admin.js';
import Loader from '../../components/Loader.jsx';
import ErrorBanner from '../../components/ErrorBanner.jsx';

const EMPTY_FORM = {
  slug: '',
  title: '',
  synopsis: '',
  type: 'movie',
  releaseYear: '',
  runtimeSeconds: '',
  maturityRating: '',
  language: '',
  country: '',
  director: '',
  cast: '',
  tags: '',
  genres: '',
  posterUrl: '',
  backdropUrl: '',
  trailerUrl: '',
  isFeatured: false,
};

const listToText = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');
const textToList = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function toFormPayload(form) {
  const payload = {
    slug: form.slug.trim(),
    title: form.title.trim(),
    type: form.type,
  };
  if (form.synopsis) payload.synopsis = form.synopsis;
  if (form.releaseYear) payload.releaseYear = Number(form.releaseYear);
  if (form.runtimeSeconds) payload.runtimeSeconds = Number(form.runtimeSeconds);
  if (form.maturityRating) payload.maturityRating = form.maturityRating;
  if (form.language) payload.language = form.language;
  if (form.country) payload.country = form.country;
  if (form.director) payload.director = form.director;
  payload.cast = textToList(form.cast);
  payload.tags = textToList(form.tags);
  payload.genres = textToList(form.genres);
  if (form.posterUrl) payload.posterUrl = form.posterUrl;
  if (form.backdropUrl) payload.backdropUrl = form.backdropUrl;
  if (form.trailerUrl) payload.trailerUrl = form.trailerUrl;
  payload.isFeatured = Boolean(form.isFeatured);
  return payload;
}

const JOB_LABEL = {
  queued: 'Queued',
  submitted: 'Submitted to transcoder',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

export default function TitleEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_FORM);
  const [titleId, setTitleId] = useState(id || null);
  const [status, setStatus] = useState(isNew ? 'draft' : null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [media, setMedia] = useState(null);
  const [file, setFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const posterInputRef = useRef(null);
  const backdropInputRef = useRef(null);
  const [artworkBusy, setArtworkBusy] = useState(null);

  const loadTitle = () => {
    if (isNew) return;
    setLoading(true);
    adminApi
      .getTitle(id)
      .then((t) => {
        setForm({
          slug: t.slug || '',
          title: t.title || '',
          synopsis: t.synopsis || '',
          type: t.type || 'movie',
          releaseYear: t.releaseYear || '',
          runtimeSeconds: t.runtimeSeconds || '',
          maturityRating: t.maturityRating || '',
          language: t.language || '',
          country: t.country || '',
          director: t.director || '',
          cast: listToText(t.cast),
          tags: listToText(t.tags),
          genres: listToText(t.genres),
          posterUrl: t.posterUrl || '',
          backdropUrl: t.backdropUrl || '',
          trailerUrl: t.trailerUrl || '',
          isFeatured: t.isFeatured || false,
        });
        setStatus(t.status);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(loadTitle, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMedia = (currentId) => {
    if (!currentId) return;
    adminApi
      .mediaFor(currentId)
      .then(setMedia)
      .catch(() => {});
  };

  useEffect(() => {
    loadMedia(titleId);
  }, [titleId]);

  // Poll while a transcode job is active, so progress shows up without a manual refresh.
  useEffect(() => {
    if (!titleId) return undefined;
    const active = media?.job && ['queued', 'submitted', 'processing'].includes(media.job.status);
    if (!active) return undefined;
    const interval = setInterval(() => {
      loadMedia(titleId);
      loadTitle();
    }, 4000);
    return () => clearInterval(interval);
  }, [titleId, media]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload = toFormPayload(form);
      if (isNew) {
        const created = await adminApi.createTitle(payload);
        setTitleId(created.id);
        setStatus(created.status);
        navigate(`/admin/titles/${created.id}`, { replace: true });
      } else {
        const updated = await adminApi.updateTitle(titleId, payload);
        setStatus(updated.status);
      }
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const startUpload = async () => {
    if (!file || !titleId) return;
    setUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    try {
      await adminApi.uploadAndTranscode(titleId, file, setUploadProgress);
      setFile(null);
      loadMedia(titleId);
      loadTitle();
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
    }
  };

  const uploadArtwork = async (kind, artworkFile) => {
    if (!artworkFile || !titleId) return;
    setArtworkBusy(kind);
    try {
      const result = await adminApi.uploadArtwork(titleId, kind, artworkFile);
      setForm((f) => ({ ...f, [kind === 'poster' ? 'posterUrl' : 'backdropUrl']: result.url || f[kind === 'poster' ? 'posterUrl' : 'backdropUrl'] }));
      loadTitle();
    } catch (err) {
      setError(err);
    } finally {
      setArtworkBusy(null);
    }
  };

  const publish = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await adminApi.publishTitle(titleId);
      setStatus(result.status);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loader label="Loading title…" />;

  return (
    <div>
      <h1 className="page__heading">{isNew ? 'New title' : `Edit: ${form.title}`}</h1>
      {status && (
        <p>
          Status: <span className={`status status--${status}`}>{status}</span>
        </p>
      )}
      <ErrorBanner error={error} />
      {saved && <p className="notice notice--success">Saved.</p>}

      <form className="panel" onSubmit={save}>
        <h2>Metadata</h2>
        <div className="form-grid">
          <label>
            Slug
            <input required value={form.slug} onChange={update('slug')} placeholder="inception" />
          </label>
          <label>
            Title
            <input required value={form.title} onChange={update('title')} />
          </label>
          <label>
            Type
            <select value={form.type} onChange={update('type')}>
              <option value="movie">Movie</option>
              <option value="series">Series</option>
            </select>
          </label>
          <label>
            Release year
            <input type="number" value={form.releaseYear} onChange={update('releaseYear')} />
          </label>
          <label>
            Runtime (seconds)
            <input type="number" value={form.runtimeSeconds} onChange={update('runtimeSeconds')} />
          </label>
          <label>
            Maturity rating
            <input value={form.maturityRating} onChange={update('maturityRating')} placeholder="UA16" />
          </label>
          <label>
            Language
            <input value={form.language} onChange={update('language')} placeholder="en" />
          </label>
          <label>
            Country
            <input value={form.country} onChange={update('country')} />
          </label>
          <label>
            Director
            <input value={form.director} onChange={update('director')} />
          </label>
        </div>
        <label>
          Synopsis
          <textarea rows={3} value={form.synopsis} onChange={update('synopsis')} />
        </label>
        <div className="form-grid">
          <label>
            Cast (comma separated)
            <input value={form.cast} onChange={update('cast')} />
          </label>
          <label>
            Genres (comma separated)
            <input value={form.genres} onChange={update('genres')} placeholder="Action, Sci-Fi" />
          </label>
          <label>
            Tags (comma separated)
            <input value={form.tags} onChange={update('tags')} />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Poster URL
            <input value={form.posterUrl} onChange={update('posterUrl')} />
          </label>
          <label>
            Backdrop URL
            <input value={form.backdropUrl} onChange={update('backdropUrl')} />
          </label>
          <label>
            Trailer URL
            <input value={form.trailerUrl} onChange={update('trailerUrl')} />
          </label>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.isFeatured} onChange={update('isFeatured')} />
          Featured on the hero banner
        </label>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create title' : 'Save changes'}
        </button>
      </form>

      {!isNew && (
        <>
          <section className="panel">
            <h2>Artwork</h2>
            <div className="artwork-row">
              <div>
                <p>Poster</p>
                {form.posterUrl && <img className="artwork-preview" src={form.posterUrl} alt="Poster" />}
                <input
                  ref={posterInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => uploadArtwork('poster', e.target.files?.[0])}
                  disabled={artworkBusy === 'poster'}
                />
              </div>
              <div>
                <p>Backdrop</p>
                {form.backdropUrl && <img className="artwork-preview artwork-preview--wide" src={form.backdropUrl} alt="Backdrop" />}
                <input
                  ref={backdropInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => uploadArtwork('backdrop', e.target.files?.[0])}
                  disabled={artworkBusy === 'backdrop'}
                />
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Video</h2>
            {media?.source && (
              <p className="field-hint">
                Source on file: {media.source.storageKey} ({Math.round((media.source.sizeBytes || 0) / 1024 / 1024)} MB)
              </p>
            )}
            {media?.job && (
              <p>
                Last transcode job: <strong>{JOB_LABEL[media.job.status] || media.job.status}</strong>
                {typeof media.job.progress === 'number' ? ` — ${media.job.progress}%` : ''}
                {media.job.errorMessage && <span className="notice notice--error"> {media.job.errorMessage}</span>}
              </p>
            )}
            <div className="upload-row">
              <input
                type="file"
                accept="video/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                disabled={uploading}
              />
              <button type="button" className="btn btn--primary" onClick={startUpload} disabled={!file || uploading}>
                {uploading ? `Uploading… ${uploadProgress ?? 0}%` : 'Upload & transcode'}
              </button>
            </div>
            {uploading && uploadProgress !== null && (
              <div className="progress-bar">
                <div className="progress-bar__fill" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}
            <ErrorBanner error={uploadError} />
          </section>

          <section className="panel">
            <h2>Publish</h2>
            <p className="field-hint">
              A title needs a ready, processed video before it can be published to customers.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={publish}
              disabled={saving || !['ready', 'published'].includes(status)}
            >
              {status === 'published' ? 'Re-publish' : 'Publish'}
            </button>
          </section>
        </>
      )}
    </div>
  );
}

export default function Loader({ label = 'Loading…', full = false }) {
  return (
    <div className={full ? 'loader loader--full' : 'loader'}>
      <div className="loader__spinner" />
      <span>{label}</span>
    </div>
  );
}

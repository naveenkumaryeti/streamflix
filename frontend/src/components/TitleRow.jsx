import { useRef } from 'react';
import TitleCard from './TitleCard.jsx';

export default function TitleRow({ title, items }) {
  const trackRef = useRef(null);

  if (!items?.length) return null;

  const scrollBy = (dir) => {
    trackRef.current?.scrollBy({ left: dir * trackRef.current.clientWidth * 0.9, behavior: 'smooth' });
  };

  return (
    <section className="title-row">
      <h2 className="title-row__heading">{title}</h2>
      <div className="title-row__wrap">
        <button type="button" className="title-row__nav title-row__nav--left" onClick={() => scrollBy(-1)} aria-label="Scroll left">
          ‹
        </button>
        <div className="title-row__track" ref={trackRef}>
          {items.map((item) => {
            const progressPercent = item.progress?.positionSeconds && item.runtimeSeconds
              ? (item.progress.positionSeconds / item.runtimeSeconds) * 100
              : undefined;
            return <TitleCard key={item.id} title={item} progressPercent={progressPercent} />;
          })}
        </div>
        <button type="button" className="title-row__nav title-row__nav--right" onClick={() => scrollBy(1)} aria-label="Scroll right">
          ›
        </button>
      </div>
    </section>
  );
}

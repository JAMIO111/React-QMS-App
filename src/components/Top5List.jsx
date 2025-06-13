import { useEffect, useState } from "react";
import { HiMiniEllipsisHorizontal } from "react-icons/hi2";

const Top5List = ({ title, data, isLoading }) => {
  const [animate, setAnimate] = useState(false);
  const topEntities = data?.top_entities || [];

  useEffect(() => {
    setAnimate(false);
    const timeout = setTimeout(() => {
      setAnimate(true);
    }, 300); // brief reset before applying the new animation
    return () => clearTimeout(timeout);
  }, [data]);

  const Skeleton = ({ index }) => (
    <li className="flex items-center justify-between gap-3">
      <div className="w-14 aspect-square rounded-lg shimmer" />
      <div className="flex flex-col w-full justify-center h-full gap-2">
        <div className="flex items-center justify-between">
          <div className="w-1/3 h-4 bg-border-color rounded shimmer" />
          <div className="w-6 h-4 bg-border-color rounded shimmer" />
        </div>
        <div className="w-full bg-primary-bg/90 rounded-full h-1.5">
          <div
            style={{ width: `${100 / (index + 1)}%` }}
            className="bg-border-color h-1.5 rounded-full shimmer"
          />
        </div>
      </div>
    </li>
  );

  return (
    <div className="flex flex-col bg-secondary-bg rounded-3xl h-full p-4 shadow-blur-md">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-primary-text">{title}</h3>
        <button className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-border-color/50 transition-colors cursor-pointer">
          <HiMiniEllipsisHorizontal className="w-6 h-6 text-secondary-text" />
        </button>
      </div>

      <ul className="flex flex-grow flex-col justify-start gap-7 py-3 px-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} index={i} />
          ))
        ) : topEntities.length === 0 ? (
          <li className="text-center text-secondary-text py-8 px-4 border border-dashed border-border-color rounded-lg">
            No Non-Conformances found in the selected period.
          </li>
        ) : (
          topEntities.map((entity, index) => {
            const maxDefects = Math.max(
              ...topEntities.map((ent) => ent.total_defects)
            );
            const percent =
              maxDefects > 0 ? (entity.total_defects / maxDefects) * 100 : 0;

            return (
              <li
                key={entity.entity_id}
                className="flex items-center justify-between gap-3">
                <div className="flex items-center min-w-8 w-8 aspect-square gap-4 border-1 border-border-dark-color rounded-lg overflow-hidden">
                  <img
                    src={
                      entity.entity_logo
                        ? entity.entity_logo
                        : `/icons/fallback-position-${index + 1}.png`
                    }
                    alt={entity.entity_name}
                    className="object-cover w-full h-full"
                  />
                </div>
                <div className="flex flex-col flex-grow overflow-hidden justify-center h-full">
                  <div className="flex items-center gap-2 justify-between">
                    <span className="text-primary-text whitespace-nowrap overflow-hidden text-ellipsis">
                      {entity.entity_name}
                    </span>
                    <span className="text-secondary-text">
                      {entity.total_defects}
                    </span>
                  </div>
                  <div className="w-full bg-primary-bg/90 rounded-full h-1.5">
                    <div
                      className="bg-brand-primary h-1.5 rounded-full transition-all duration-700 ease-out"
                      style={{ width: animate ? `${percent}%` : 0 }}
                    />
                  </div>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
};

export default Top5List;

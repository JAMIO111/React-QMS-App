/**
 * Shimmering placeholders shown while a dashboard's figures load for the first time, laid out like the dashboards themselves (a hero card beside a
 * wide card, a row of stat tiles, two chart cards, three list cards), so the page does not jump when the figures arrive and nothing shows "—" or
 * "None in this period" before it is known. Later loads (a new period) keep the figures on screen and say "updating…" instead.
 *
 *   {isLoading ? <DashboardSkeleton label="Loading the non-conformance dashboard" tiles={4} /> : <>…the dashboard…</>}
 */

/** One shimmering block. */
export const Bone = ({ className = "" }) => <span aria-hidden="true" className={`shimmer block rounded-md ${className}`} />;

const shell = "flex min-w-0 flex-col gap-3 border border-border-color bg-secondary-bg p-4";

/** A card's title and subtitle, then a body by kind. */
export const SkeletonCard = ({ kind = "list", rows = 5, className = "" }) => (
  <div className={`${shell} rounded-2xl ${className}`}>
    <Bone className="h-5 w-40" />
    <Bone className="h-3.5 w-56 max-w-full" />
    {kind === "chart" && (
      <div className="mt-1 flex h-60 items-end gap-2" aria-hidden="true">
        {[40, 65, 50, 80, 55, 70, 45, 90, 60, 75, 50, 68].map((h, i) => (
          <span key={i} className="shimmer block flex-1 rounded-t-md" style={{ height: `${h}%` }} />
        ))}
      </div>
    )}
    {kind === "list" && (
      <div className="mt-1 flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Bone className="h-8 w-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Bone className="h-3.5" />
              <Bone className="h-2.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    )}
    {kind === "steps" && (
      <div className="mt-auto grid grid-cols-3 gap-2 sm:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Bone key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    )}
  </div>
);

/** The big number with a split bar under it. */
const SkeletonHero = ({ className = "" }) => (
  <div className={`${shell} rounded-3xl ${className}`}>
    <div className="flex items-center gap-2">
      <Bone className="h-9 w-9 rounded-xl" />
      <Bone className="h-4 w-28" />
    </div>
    <Bone className="h-12 w-24" />
    <Bone className="h-3.5 w-44" />
    <Bone className="mt-2 h-4 w-24" />
    <Bone className="h-6 w-full rounded-full" />
    <div className="grid grid-cols-2 gap-2">
      <Bone className="h-3.5" />
      <Bone className="h-3.5" />
    </div>
  </div>
);

const SkeletonTile = () => (
  <div className={`${shell} rounded-2xl`}>
    <div className="flex items-center gap-2">
      <Bone className="h-8 w-8 rounded-lg" />
      <Bone className="h-3.5 w-24" />
    </div>
    <Bone className="h-8 w-16" />
    <Bone className="h-3 w-28" />
  </div>
);

const TILE_GRID = {
  3: "grid-cols-1 sm:grid-cols-3",
  4: "grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
};

/** The whole dashboard while its figures load. `label` is read out by screen readers; `tiles` is how many stat tiles the dashboard has. */
const DashboardSkeleton = ({ label = "Loading the dashboard", tiles = 5, lists = 3 }) => (
  <div role="status" aria-label={label} aria-busy="true" className="flex flex-col gap-4" data-testid="dashboard-skeleton">
    <span className="sr-only">{label}…</span>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <SkeletonHero className="xl:col-span-5" />
      <SkeletonCard kind="steps" className="rounded-3xl xl:col-span-7" />
    </div>
    <div className={`grid gap-3 ${TILE_GRID[tiles] ?? TILE_GRID[5]}`}>
      {Array.from({ length: tiles }, (_, i) => (
        <SkeletonTile key={i} />
      ))}
    </div>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SkeletonCard kind="chart" />
      <SkeletonCard kind="chart" />
    </div>
    {lists > 0 && (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: lists }, (_, i) => (
          <SkeletonCard key={i} kind="list" rows={4} />
        ))}
      </div>
    )}
  </div>
);

export default DashboardSkeleton;

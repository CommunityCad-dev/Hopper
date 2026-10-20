/** Grey rows while a tab's list loads, in place of "Reading…" text. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div class="skel-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} class="skel-row" />)}
    </div>
  );
}

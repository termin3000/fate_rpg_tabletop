/**
 * Skeleton-экран на время загрузки корневого сегмента.
 * Показывается пока Next.js готовит page.tsx (или при streaming).
 * Документация: https://nextjs.org/docs/app/api-reference/file-conventions/loading
 */
export default function Loading() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4 p-6"
      style={{ backgroundColor: 'var(--fate-bg)' }}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        {/* Spinning dice */}
        <svg
          className="animate-spin w-7 h-7"
          style={{ color: 'var(--fate-accent)' }}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span
          className="text-sm font-medium"
          style={{ color: 'var(--fate-text-muted)' }}
        >
          Загрузка Fate RPG…
        </span>
      </div>

      <span className="sr-only">Идёт загрузка виртуального стола</span>
    </div>
  );
}

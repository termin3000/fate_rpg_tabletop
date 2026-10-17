'use client';

import { useEffect } from 'react';
import { RotateCcw, AlertTriangle } from 'lucide-react';

/**
 * Глобальный Error Boundary.
 * Перехватывает runtime-ошибки в React-дереве и показывает
 * восстанавливаемый экран вместо белой страницы.
 *
 * Документация: https://nextjs.org/docs/app/api-reference/file-conventions/error
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Логируем в консоль для отладки
    console.error('[GlobalErrorBoundary]', error);
  }, [error]);

  const isDev = process.env.NODE_ENV === 'development';

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: 'var(--fate-bg)' }}
    >
      <div
        className="max-w-md w-full rounded-xl border shadow-xl p-6 space-y-4"
        style={{
          backgroundColor: 'var(--fate-bg-card)',
          borderColor: 'var(--fate-border)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)' }}
          >
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h1
              className="text-lg font-semibold"
              style={{ color: 'var(--fate-text)' }}
            >
              Что-то пошло не так
            </h1>
            <p
              className="text-sm mt-1"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              Произошла непредвиденная ошибка. Попробуйте перезагрузить
              интерфейс — данные сохранены в базе данных и не потеряны.
            </p>
          </div>
        </div>

        {isDev && (
          <div
            className="rounded-lg p-3 text-xs font-mono overflow-x-auto max-h-40 overflow-y-auto"
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.04)',
              color: 'var(--fate-text-muted)',
              border: '1px solid var(--fate-border)',
            }}
          >
            <div className="font-sans font-semibold mb-1">
              {error.name || 'Error'}:
            </div>
            <div className="whitespace-pre-wrap break-words">
              {error.message || 'Неизвестная ошибка'}
            </div>
            {error.digest && (
              <div className="mt-2 text-[10px] opacity-60">
                digest: {error.digest}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={reset}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            style={{
              backgroundColor: 'var(--fate-accent)',
              color: 'var(--fate-accent-text)',
            }}
          >
            <RotateCcw className="w-4 h-4" />
            Попробовать снова
          </button>
          <button
            onClick={() => {
              window.location.href = '/';
            }}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors border"
            style={{
              borderColor: 'var(--fate-border)',
              color: 'var(--fate-text)',
            }}
          >
            На главную
          </button>
        </div>
      </div>
    </div>
  );
}

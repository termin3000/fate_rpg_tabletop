// ============================================================
// Fate RPG Virtual Tabletop — API Helper
// ============================================================

/**
 * Perform a GET request with optional query parameters.
 */
export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  // A public tunnel can briefly lose its upstream during reconnect. Retry
  // safe reads only; mutations below must never be replayed automatically.
  const delays = [300, 900];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url.toString());
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      continue;
    }
    if (!res.ok) {
      if ([502, 503, 504].includes(res.status) && attempt < delays.length) {
        await res.body?.cancel().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        continue;
      }
      const text = await res.text().catch(() => '');
      throw new Error(`API Error ${res.status} (GET ${url.pathname}): ${text || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }
}

/**
 * Perform a POST request with an optional JSON body.
 */
export async function apiPost<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Perform a PUT request with an optional JSON body.
 */
export async function apiPut<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Perform a DELETE request with optional query parameters.
 */
export async function apiDelete<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Perform a PATCH request with an optional JSON body.
 */
export async function apiPatch<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API Error ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

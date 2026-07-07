// Best-effort geolocation. Never rejects; resolves null on denial/timeout so a
// capture is never blocked on a location fix.

export interface Coords {
  lat: number;
  lon: number;
}

export function getCoords(timeoutMs = 5000): Promise<Coords | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v: Coords | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => done({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 300000 }
    );
    setTimeout(() => done(null), timeoutMs + 500);
  });
}

export function currentTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * Layered location capture.
 *
 * There are no reliable street addresses in this district, so location is captured in
 * layers and **any one of them is sufficient** (`docs/00-thesis.md`). A report with only
 * free text is a valid report; a report with nothing at all is still a valid report.
 *
 * The rule that matters for M0-36: **acquisition never blocks the operator.** GPS starts
 * the moment the screen opens and whatever it has by submit time is what gets attached.
 * Waiting for a fix indoors, on an old handset, would blow the fifteen-second budget on
 * its own — and the report matters far more than the coordinates.
 */

export interface Fix {
  readonly lat: number;
  readonly lon: number;
  readonly accuracyMetres: number;
  readonly at: string;
}

export interface Capture {
  /** Present only if a fix arrived in time. */
  readonly gps?: Fix;
  /** Free text typed by whoever reported it. */
  readonly text?: string;
  /**
   * Which layers actually produced something.
   *
   * Recorded so a downstream consumer can tell a GPS fix from an operator's best guess at
   * a landmark, rather than treating every location as equally certain.
   */
  readonly layers: readonly ('gps' | 'text')[];
}

export type LocationListener = (fix: Fix | null, error: string | null) => void;

/**
 * Start watching for a position. Returns a stop function.
 *
 * Deliberately `watchPosition` rather than `getCurrentPosition`: the first fix indoors is
 * often poor, and a better one usually follows within a few seconds. The operator is not
 * kept waiting for either.
 */
export function startLocationWatch(listener: LocationListener): () => void {
  if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
    listener(null, 'This device cannot provide a location.');
    return () => undefined;
  }

  const id = navigator.geolocation.watchPosition(
    (pos) => {
      listener(
        {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyMetres: pos.coords.accuracy,
          at: new Date(pos.timestamp).toISOString(),
        },
        null,
      );
    },
    (err) => {
      listener(
        null,
        err.code === err.PERMISSION_DENIED
          ? 'Location is turned off. You can still report — add the place afterwards.'
          : 'Could not find your location. You can still report — add the place afterwards.',
      );
    },
    // A coarse fix now beats a precise one later. `maximumAge` accepts a recent cached
    // position outright, which on a handset that has just been used is usually instant.
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
  );

  return () => navigator.geolocation.clearWatch(id);
}

/** Human-readable, and honest about accuracy rather than implying false precision. */
export function describeFix(fix: Fix | null): string {
  if (fix === null) return 'No location yet — you can still report.';
  const accuracy = Math.round(fix.accuracyMetres);
  return accuracy > 200
    ? `Approximate location found (within about ${accuracy} m).`
    : `Location found (within about ${accuracy} m).`;
}

export function buildCapture(fix: Fix | null, text: string): Capture {
  const layers: ('gps' | 'text')[] = [];
  if (fix !== null) layers.push('gps');
  if (text.trim().length > 0) layers.push('text');

  return {
    ...(fix !== null ? { gps: fix } : {}),
    ...(text.trim().length > 0 ? { text: text.trim() } : {}),
    layers,
  };
}

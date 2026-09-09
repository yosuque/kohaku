/**
 * Detects an illegal self-navigation of the L2 iframe by counting `load` events.
 *
 * The iframe's `srcdoc` is set once, before it is inserted into the document, so a well-behaved sandbox fires
 * exactly one `load` for the initial document. Anything after that — `location.href` assignment, an `<a href>`
 * click that slips past the guest-side click guard (e.g. via `target=_top` or a form submission), or a
 * `<meta http-equiv=refresh>` — replaces the guest document and fires a second `load`. That second load is the
 * one signal the parent can observe from outside the (now-opaque, now-replaced) frame: the frame could otherwise
 * navigate to any origin and exfiltrate whatever was embedded in the URL, or simply show attacker content in the
 * widget's place, defeating SPEC §4's "no data path other than the bridge" guarantee.
 *
 * Returns a `load` handler to attach to the iframe. `onIllegal` fires exactly once, on the second load; every
 * load after that is ignored (the frame is already being torn down by then).
 */
export function createNavigationGuard(onIllegal: () => void): () => void {
  let loadCount = 0;
  let fired = false;
  return () => {
    loadCount++;
    if (loadCount <= 1) return; // the initial srcdoc document
    if (fired) return;
    fired = true;
    onIllegal();
  };
}

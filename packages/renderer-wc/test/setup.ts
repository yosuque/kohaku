import { afterEach } from "vitest";

// Detach the surface from the document after each test (disconnectedCallback runs controller detach /
// bus & store unsubscribe / sandbox destroy, preventing leaks and async cross-talk between tests).
afterEach(() => {
  document.body.replaceChildren();
});

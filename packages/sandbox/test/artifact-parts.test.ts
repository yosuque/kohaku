import { describe, expect, it } from "vitest";
import { splitArtifact } from "../src/guest/artifact-parts.js";

describe("splitArtifact (extraction of title / styles / scripts / body)", () => {
  it("extracts title, style content, script content, and body in document order", () => {
    const html = [
      "<!DOCTYPE html><html><head><title>Sales trend</title>",
      "<style>body{color:red}</style>",
      "<style>.x{color:blue}</style>",
      "</head><body><div id=app></div>",
      "<script>console.log(1);</script>",
      "<script>console.log(2);</script>",
      "</body></html>",
    ].join("");
    const parts = splitArtifact(html);
    expect(parts.title).toBe("Sales trend");
    expect(parts.styles).toEqual(["body{color:red}", ".x{color:blue}"]);
    expect(parts.scripts).toEqual(["console.log(1);", "console.log(2);"]);
    expect(parts.body).toContain("<div id=app></div>");
    expect(parts.body).not.toContain("<script>");
    expect(parts.body).not.toContain("<style>");
  });

  it("ignores scripts with a src attribute or a non-classic type", () => {
    const html = [
      "<!DOCTYPE html><html><body>",
      '<script src="https://evil.example/x.js"></script>',
      '<script type="module">shouldBeIgnored();</script>',
      '<script type="application/json">{"a":1}</script>',
      "<script>real();</script>",
      "</body></html>",
    ].join("");
    const parts = splitArtifact(html);
    expect(parts.scripts).toEqual(["real();"]);
  });

  it("accepts an explicit text/javascript or application/javascript type as classic", () => {
    const html =
      '<html><body><script type="text/javascript">a();</script><script type="application/javascript">b();</script></body></html>';
    const parts = splitArtifact(html);
    expect(parts.scripts).toEqual(["a();", "b();"]);
  });

  it("falls back to everything after </head> when there is no <body>", () => {
    const html = "<!DOCTYPE html><html><head><title>x</title></head><div>fragment</div></html>";
    const parts = splitArtifact(html);
    expect(parts.body).toBe("<div>fragment</div></html>");
  });

  it("falls back to the whole (script/style-stripped) document when there is no <body> and no <head>", () => {
    const html = "<div>fragment</div>";
    const parts = splitArtifact(html);
    expect(parts.body).toBe("<div>fragment</div>");
  });

  it("title defaults to empty string when absent", () => {
    expect(splitArtifact("<html><body>hi</body></html>").title).toBe("");
  });

  it("collapses whitespace in the title", () => {
    const html = "<html><head><title>  a\n  b  </title></head><body></body></html>";
    expect(splitArtifact(html).title).toBe("a b");
  });

  it("is not comment-aware: a <script> written out inside an HTML comment is still extracted (fail-closed on inclusion)", () => {
    const html = "<html><body><!-- <script>hiddenInComment();</script> --></body></html>";
    const parts = splitArtifact(html);
    expect(parts.scripts).toEqual(["hiddenInComment();"]);
  });
});

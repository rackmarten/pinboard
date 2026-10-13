// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderDescriptionHtml } from "./description-html.js";

describe("renderDescriptionHtml", () => {
  it("renders markdown and #id task links", () => {
    const html = renderDescriptionHtml("**bold** see #42\n\n- item");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="/tasks/42">#42</a>');
    expect(html).toContain("<li>item</li>");
  });

  it("strips scripts, and event handlers", () => {
    const html = renderDescriptionHtml('<script>alert(1)</script><img src=x onerror="alert(1)"> <b onclick="x()">b</b>');
    expect(html).not.toMatch(/<script|onerror|onclick|<img/i);
  });

  it("drops javascript: hrefs from markdown links", () => {
    const html = renderDescriptionHtml("[x](javascript:alert(1))");
    expect(html).toContain(">x</a>");
    expect(html).not.toContain("javascript:");
  });
});

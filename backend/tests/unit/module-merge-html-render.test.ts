import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  injectModuleCss,
  replaceDesignPageContent,
} from "../../src/pipeline/module-merge/html-render.js";

describe("replaceDesignPageContent", () => {
  it("preserves dollar-prefixed text when injecting module sections", () => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head></head>",
      '<body><main class="design-page"><p>old</p></main></body>',
      "</html>",
    ].join("");
    const sections = [
      '<section data-module-id="module-05">',
      '<div class="price">$4.53</div>',
      '<div class="price">$ 3.53</div>',
      '<div class="token">$1 $$ $& $` $\'</div>',
      "</section>",
    ].join("");

    const next = replaceDesignPageContent({ html, sections });

    assert.ok(next.includes('<div class="price">$4.53</div>'));
    assert.ok(next.includes('<div class="price">$ 3.53</div>'));
    assert.ok(next.includes('<div class="token">$1 $$ $& $` $\'</div>'));
    assert.ok(!next.includes("</main>.53"));
  });

  it("preserves dollar-prefixed tokens when injecting generated CSS", () => {
    const html = "<html><head></head><body></body></html>";
    const css = [
      ".price::before { content: '$4.53'; }",
      ".token::before { content: '$1 $$ $&'; }",
    ].join("\n");

    const next = injectModuleCss({ css, html });

    assert.ok(next.includes("content: '$4.53';"));
    assert.ok(next.includes("content: '$1 $$ $&';"));
  });
});

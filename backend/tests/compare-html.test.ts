import assert from "node:assert/strict";
import test from "node:test";

import { optimizeCompareHtml } from "../src/core-service/compare-html.js";

const compareHtml = `<!DOCTYPE html>
<html>
  <head><title>Compare</title></head>
  <body>
    <div class="compare-stage">
      <img src="./High-Fidelity ( Home ).svg?v=123" alt="高保真稿" />
    </div>
    <div class="compare-stage">
      <iframe src="./High-Fidelity ( Home ).html?v=123"></iframe>
    </div>
  </body>
</html>`;

test("compare HTML uses the generated PNG preview with an SVG fallback", () => {
  const optimized = optimizeCompareHtml(compareHtml);

  assert.match(optimized, /src="\.\/artifacts\/svg\.png\?v=123"/);
  assert.match(
    optimized,
    /data-fallback-src="\.\/High-Fidelity \( Home \)\.svg\?v=123"/,
  );
  assert.match(optimized, /高保真稿加载中/);
  assert.match(optimized, /代码还原加载中/);
  assert.match(optimized, /加载失败，请刷新页面重试/);
  assert.equal(optimizeCompareHtml(optimized), optimized);
});

test("unrelated HTML is not modified", () => {
  const html = "<!DOCTYPE html><html><body>render</body></html>";
  assert.equal(optimizeCompareHtml(html), html);
});

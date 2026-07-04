import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectArtisticSpacedText } from "../../src/pipeline/agent-runner/module/module-artistic-text.js";

describe("detectArtisticSpacedText", () => {
  it("flags single-glyph CJK runs that cannot fill the target width without letter spacing", () => {
    const decision = detectArtisticSpacedText({
      bbox: { height: 17.123, width: 393.071, x: 230.203, y: 393.226 },
      lineCount: 1,
      text: "生 成 你 的 专 属 小 电 视 Ｉ Ｐ 设 定",
    });

    assert.ok(decision);
    assert.equal(decision.compactText, "生成你的专属小电视ＩＰ设定");
    assert.ok(decision.estimatedFillRatio < 0.85);
  });

  it("uses the 0.85 threshold for borderline spaced glyph titles", () => {
    const decision = detectArtisticSpacedText({
      bbox: { height: 20, width: 95, x: 0, y: 0 },
      lineCount: 1,
      text: "生 成 你 的",
    });

    assert.ok(decision);
    assert.ok(decision.estimatedFillRatio > 0.78);
    assert.ok(decision.estimatedFillRatio < 0.85);
  });

  it("keeps ordinary compact CJK labels as DOM text", () => {
    const decision = detectArtisticSpacedText({
      bbox: { height: 14.169, width: 28.782, x: 65.32, y: 162.585 },
      lineCount: 1,
      text: "首页",
    });

    assert.equal(decision, null);
  });

  it("keeps phrase-level spacing where characters are not individually tracked out", () => {
    const decision = detectArtisticSpacedText({
      bbox: { height: 17, width: 260, x: 0, y: 0 },
      lineCount: 1,
      text: "生成 你的 专属 小电视 IP 设定",
    });

    assert.equal(decision, null);
  });
});

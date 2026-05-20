import path from "node:path";
import { mkdir } from "node:fs/promises";

import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";

import { getWorkspaceRoot } from "../core/utils.js";
import { sessionStore } from "../session-store.js";

const router = Router();

const getSessionDir = (sessionId: string) =>
  path.join(getWorkspaceRoot(), "sessions", sessionId);

const decodeOriginalName = (value: string) =>
  path.basename(Buffer.from(value, "latin1").toString("utf8"));

const parseUploadScale = (value: unknown) => {
  const parsed = Number(value);
  if (parsed === 2) return 2;
  return 1;
};

const parseUploadOutputFormats = (value: unknown) => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const formats = raw
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item === "html" || item === "react" || item === "vue");
  return [...new Set(["html", ...formats])] as Array<"html" | "react" | "vue">;
};

router.post("/upload", async (req, res) => {
  const sessionId = nanoid(10);
  const sessionDir = getSessionDir(sessionId);
  await mkdir(sessionDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, sessionDir),
      filename: (_req, file, cb) => {
        const name = decodeOriginalName(file.originalname);
        cb(null, name);
      },
    }),
    fileFilter: (_req, file, cb) => {
      const name = decodeOriginalName(file.originalname);
      const designName = path.basename(name, ".svg").trim();
      if (name.endsWith(".svg") && designName) {
        cb(null, true);
      } else {
        cb(new Error("Only named SVG files are accepted"));
      }
    },
    limits: { fileSize: 50 * 1024 * 1024 },
  }).single("svg");

  upload(req, res, (error) => {
    try {
      if (error) {
        res.status(400).json({ error: error.message });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No SVG file provided" });
        return;
      }

      const originalName = decodeOriginalName(file.originalname);
      const designName = path.basename(originalName, ".svg").trim();
      if (!designName) {
        res.status(400).json({ error: "SVG filename cannot be empty" });
        return;
      }

      const svgPath = path.join(sessionDir, originalName);
      const htmlPath = path.join(sessionDir, `${designName}.html`);
      const compareHtmlPath = path.join(
        sessionDir,
        `${designName}.compare.html`,
      );
      const artifactDir = path.join(sessionDir, "artifacts");

      const scale = parseUploadScale(req.body?.scale);
      const outputFormats = parseUploadOutputFormats(req.body?.outputFormats);
      const session = sessionStore.create({
        id: sessionId,
        designName,
        svgPath,
        scale,
        htmlPath,
        artifactDir,
        compareHtmlPath,
        sessionDir,
        outputFormats,
        status: "draft",
        activeStep: null,
        steps: {
          agent: { status: "pending" },
          verify: { status: "pending" },
        },
        result: {
          artifactDir,
          compareHtmlPath,
          htmlPath,
        },
        logs: [],
        messages: [
          {
            id: `system-${sessionId}`,
            role: "system",
            kind: "chat",
            text:
              `已创建 session ${sessionId}，设计文件为 ${originalName}，SVG 渲染缩放为 ${scale}x，输出格式为 ${outputFormats.join(", ")}。` +
              " 上传完成后将直接进入结构解析、模块生成、合并与 verify。可读文本必须保留为真实 DOM，复杂无文本视觉元素可在模块内按需导出为局部资产。",
            createdAt: Date.now(),
          },
        ],
        pendingUserMessages: [],
      });

      res.json({
        designName,
        session,
        sessionId,
        status: session.status,
      });
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      res.status(500).json({ error: message });
    }
  });
});

export default router;

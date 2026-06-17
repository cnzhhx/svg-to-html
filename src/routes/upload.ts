import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";

import {
  getOutputFormatLabel,
  parseOutputFormat,
  resolveOutputTarget,
} from "../core/output-target.js";
import type { OutputFormat } from "../core/output-target.js";
import { getComponentLibrary } from "../core/component-library/index.js";
import type { ComponentLibrarySessionRef } from "../core/component-library/types.js";
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

const parseUploadSessionCount = (value: unknown) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20)
    return Math.floor(parsed);
  return 1;
};

const UPLOAD_FIELD_KEYS = new Set([
  "componentLibraryId",
  "outputFormat",
  "scale",
  "sessionCount",
]);

const findUnsupportedUploadField = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (
    Object.keys(body as Record<string, unknown>).find(
      (key) => !UPLOAD_FIELD_KEYS.has(key),
    ) ?? null
  );
};

router.post("/upload", async (req, res) => {
  let sessionIds: string[] = [];

  const upload = multer({
    storage: multer.memoryStorage(),
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

  upload(req, res, async (error) => {
    const cleanup = async () => {
      for (const id of sessionIds) {
        await rm(getSessionDir(id), { force: true, recursive: true });
      }
    };
    const badRequest = async (message: string) => {
      await cleanup();
      res.status(400).json({ error: message });
    };

    try {
      if (error) {
        await badRequest(error.message);
        return;
      }

      const file = req.file;
      if (!file) {
        await badRequest("No SVG file provided");
        return;
      }

      const unsupportedField = findUnsupportedUploadField(req.body);
      if (unsupportedField) {
        await badRequest(`Unsupported upload field: ${unsupportedField}`);
        return;
      }

      const originalName = decodeOriginalName(file.originalname);
      const designName = path.basename(originalName, ".svg").trim();
      if (!designName) {
        await badRequest("SVG filename cannot be empty");
        return;
      }

      const scale = parseUploadScale(req.body?.scale);
      let outputFormat: OutputFormat;
      try {
        outputFormat = parseOutputFormat(req.body?.outputFormat);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await badRequest(message);
        return;
      }

      const sessionCount = parseUploadSessionCount(req.body?.sessionCount);
      sessionIds = Array.from({ length: sessionCount }, () => nanoid(10));

      for (const id of sessionIds) {
        await mkdir(getSessionDir(id), { recursive: true });
      }

      for (let i = 0; i < sessionCount; i++) {
        const svgPath = path.join(getSessionDir(sessionIds[i]!), originalName);
        await writeFile(svgPath, file.buffer);
      }

      let componentLibraryId: string | undefined;
      let componentLibrary: ComponentLibrarySessionRef | undefined;
      const rawComponentLibraryId = String(
        req.body?.componentLibraryId ?? "",
      ).trim();
      if (rawComponentLibraryId) {
        if (outputFormat !== "vue" && outputFormat !== "react") {
          await badRequest(
            "componentLibraryId is only supported for vue/react output",
          );
          return;
        }
        try {
          const library = await getComponentLibrary(rawComponentLibraryId);
          if (library.descriptor.framework !== outputFormat) {
            await badRequest(
              `Component library framework (${library.descriptor.framework}) does not match outputFormat (${outputFormat})`,
            );
            return;
          }
          componentLibraryId = rawComponentLibraryId;
          componentLibrary = library.sessionRef;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await badRequest(`Component library not available: ${message}`);
          return;
        }
      }

      const sessions = [];
      for (let i = 0; i < sessionCount; i++) {
        const sessionId = sessionIds[i]!;
        const sessionDir = getSessionDir(sessionId);
        const svgPath = path.join(sessionDir, originalName);
        const artifactDir = path.join(sessionDir, "artifacts");
        const outputTarget = resolveOutputTarget({
          format: outputFormat,
          svgPath,
        });

        const session = sessionStore.create({
          id: sessionId,
          designName,
          svgPath,
          scale,
          artifactDir,
          componentLibrary,
          componentLibraryId,
          sessionDir,
          outputFormat,
          outputTarget,
          status: "draft",
          activeStep: null,
          steps: {
            agent: { status: "pending" },
            verify: { status: "pending" },
          },
          result: {
            artifactDir,
            compareEntryPath: outputTarget.compareEntryPath,
            outputTarget,
            renderEntryPath: outputTarget.renderEntryPath,
            sourceEntryPath: outputTarget.sourceEntryPath,
            sourceStylePath: outputTarget.sourceStylePath,
            ...(componentLibrary
              ? { componentLibrary, componentLibraryId }
              : {}),
          },
          logs: [],
          messages: [
            {
              id: `system-${sessionId}`,
              role: "system",
              kind: "chat",
              text:
                `已创建 session ${sessionId}，设计文件为 ${originalName}，SVG 渲染缩放为 ${scale}x，输出格式为 ${getOutputFormatLabel(outputFormat)}。` +
                (componentLibrary
                  ? ` 已选择组件库 ${componentLibrary.name}（${componentLibrary.id}）。`
                  : "") +
                " 上传完成后将直接进入结构解析、模块生成、合并与 verify。可读文本必须保留为真实 DOM，复杂无文本视觉元素可在模块内按需导出为局部资产。",
              createdAt: Date.now(),
            },
          ],
          pendingUserMessages: [],
        });
        sessions.push(session);
      }

      if (sessionCount === 1) {
        res.json({
          designName,
          session: sessions[0],
          sessionId: sessionIds[0],
          status: sessions[0]!.status,
        });
      } else {
        res.json({
          designName,
          sessions,
          sessionIds,
          status: "draft",
        });
      }
    } catch (caughtError) {
      await cleanup();
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      res.status(500).json({ error: message });
    }
  });
});

export default router;

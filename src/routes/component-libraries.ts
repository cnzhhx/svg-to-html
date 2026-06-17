import { Router } from "express";

import {
  deleteComponentLibrary,
  ensureComponentLibraryDependenciesInstalled,
  getComponentLibrary,
  listComponentLibraries,
} from "../core/component-library/index.js";
import type { ComponentLibraryFramework } from "../core/component-library/types.js";
import { compileComponentLibrary } from "../pipeline/component-library/compiler.js";
import {
  getComponentLibraryCompileJob,
  listComponentLibraryCompileJobs,
  startComponentLibraryCompileJob,
} from "../pipeline/component-library/jobs.js";

const router = Router();

const parseFramework = (value: unknown): ComponentLibraryFramework | null => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "vue" || normalized === "react") return normalized;
  return null;
};

const asOptionalString = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
};

router.get("/component-libraries", async (_req, res) => {
  try {
    res.json({ libraries: await listComponentLibraries() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.get("/component-libraries/compile-jobs", (_req, res) => {
  res.json({ jobs: listComponentLibraryCompileJobs() });
});

router.get("/component-libraries/compile-jobs/:jobId", (req, res) => {
  const job = getComponentLibraryCompileJob(String(req.params["jobId"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Component library compile job not found" });
    return;
  }
  res.json({ job });
});

router.get("/component-libraries/:id", async (req, res) => {
  try {
    const library = await getComponentLibrary(String(req.params["id"] ?? ""));
    res.json(library);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(404).json({ error: message });
  }
});

router.post("/component-libraries/compile", async (req, res) => {
  try {
    const framework = parseFramework(req.body?.framework);
    if (!framework) {
      res.status(400).json({ error: "framework must be vue or react" });
      return;
    }
    const sourceDir = asOptionalString(req.body?.sourceDir);
    const url = asOptionalString(req.body?.url);
    if (!sourceDir && !url) {
      res.status(400).json({ error: "Provide at least one of sourceDir or url" });
      return;
    }
    const result = await compileComponentLibrary({
      force: Boolean(req.body?.force || req.body?.overwrite),
      framework,
      sourceDir,
      url,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.post("/component-libraries/compile-jobs", (req, res) => {
  try {
    const framework = parseFramework(req.body?.framework);
    if (!framework) {
      res.status(400).json({ error: "framework must be vue or react" });
      return;
    }
    const sourceDir = asOptionalString(req.body?.sourceDir);
    const url = asOptionalString(req.body?.url);
    if (!sourceDir && !url) {
      res.status(400).json({ error: "Provide at least one of sourceDir or url" });
      return;
    }
    const job = startComponentLibraryCompileJob({
      force: Boolean(req.body?.force || req.body?.overwrite),
      framework,
      sourceDir,
      url,
    });
    res.status(202).json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.post("/component-libraries/:id/install", async (req, res) => {
  try {
    const id = String(req.params["id"] ?? "");
    const install = await ensureComponentLibraryDependenciesInstalled(id);
    const library = await getComponentLibrary(id);
    res.json({ install, library: library.registryItem });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

router.delete("/component-libraries/:id", async (req, res) => {
  try {
    const id = String(req.params["id"] ?? "");
    await deleteComponentLibrary(id);
    res.json({ deleted: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

export default router;

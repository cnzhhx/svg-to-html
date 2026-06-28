import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  getBrowserPoolDisabled,
  getBrowserPoolIdleMs,
  getCdpReadyTimeoutMs,
  getCdpSendTimeoutMs,
  getBackendConfig,
} from "../config/index.js";

type ServerWithEvents = Server & {
  on(event: "error", listener: (error: Error) => void): Server;
};

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (error: Error) => void): ChildProcess;
  once(event: "exit", listener: () => void): ChildProcess;
};

const resolveBrowserBinary = () => {
  const envCandidates = [
    getBackendConfig().browser.chromiumPath,
    getBackendConfig().browser.chromePath,
    getBackendConfig().browser.browserPath,
  ].filter((value): value is string => Boolean(value));

  const platformCandidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/opt/google/chrome/chrome",
          ]
        : [];

  const candidate = [...envCandidates, ...platformCandidates].find((item) =>
    existsSync(item),
  );

  if (!candidate) {
    throw new Error(
      `No Chromium-compatible browser found. Set CHROMIUM_PATH or install Chrome/Chromium. platform=${process.platform}`,
    );
  }

  return candidate;
};

const detectBrowserBinary = () => {
  try {
    return resolveBrowserBinary();
  } catch {
    return null;
  }
};

type LaunchResult = {
  close: () => Promise<void>;
  port: number;
};

type TargetInfo = {
  id: string;
  webSocketDebuggerUrl: string;
};

type PendingMessage = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const toCdpViewportSize = (value: number) =>
  Math.max(1, Math.ceil(Number.isFinite(value) ? value : 1));

const toCdpScreenshotClip = ({
  height,
  width,
  x,
  y,
}: {
  height: number;
  width: number;
  x: number;
  y: number;
}) => ({
  height: Math.max(1, Math.ceil(Number.isFinite(height) ? height : 1)),
  scale: 1,
  width: Math.max(1, Math.ceil(Number.isFinite(width) ? width : 1)),
  x: Math.max(0, Math.floor(Number.isFinite(x) ? x : 0)),
  y: Math.max(0, Math.floor(Number.isFinite(y) ? y : 0)),
});

class CdpClient {
  private readonly listeners = new Map<string, ((params: unknown) => void)[]>();
  private readonly pending = new Map<number, PendingMessage>();
  private closed = false;
  private messageId = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: string | Buffer) => {
      const message = JSON.parse(String(data)) as {
        error?: { message?: string };
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };

      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? "Unknown CDP error"),
          );
          return;
        }
        pending.resolve(message.result);
        return;
      }

      if (!message.method) return;
      const callbacks = this.listeners.get(message.method) ?? [];
      callbacks.forEach((callback) => callback(message.params));
    });
    socket.on("close", () => {
      this.closed = true;
      this.rejectAllPending(new Error("CDP socket closed"));
    });
    socket.on("error", (error: Error) => {
      this.closed = true;
      this.rejectAllPending(error);
    });
  }

  static connect = async (url: string) => {
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    return new CdpClient(socket);
  };

  close = () => {
    this.closed = true;
    this.rejectAllPending(new Error("CDP client closed"));
    this.socket.close();
  };

  send = <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = getCdpSendTimeoutMs(),
  ) => {
    if (this.closed) {
      return Promise.reject(new Error(`CDP socket is closed: ${method}`));
    }
    const id = ++this.messageId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for CDP command: ${method}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        reject,
        resolve: resolve as (value: unknown) => void,
        timer,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  };

  private rejectAllPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  waitFor = (method: string, timeoutMs = 15000) =>
    new Promise<unknown>((resolve, reject) => {
      const callbacks = this.listeners.get(method) ?? [];
      const callback = (params: unknown) => {
        clearTimeout(timer);
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((it) => it !== callback),
        );
        resolve(params);
      };

      const timer = setTimeout(() => {
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((it) => it !== callback),
        );
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, timeoutMs);

      this.listeners.set(method, [...callbacks, callback]);
    });
}

const sleep = (delay: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });

const getAvailablePort = async () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer() as ServerWithEvents;
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a CDP port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const waitForCdp = async (port: number) => {
  const versionUrl = `http://127.0.0.1:${port}/json/version`;

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) return;
    } catch {}

    await sleep(250);
  }

  throw new Error(`CDP did not become ready on port ${port}`);
};

const createTarget = async (port: number): Promise<TargetInfo> => {
  const endpoint = `http://127.0.0.1:${port}/json/new?about%3Ablank`;

  const response =
    (await fetch(endpoint, { method: "PUT" }).catch(() => null)) ??
    (await fetch(endpoint));

  if (!response.ok)
    throw new Error(`Failed to create CDP target: ${response.status}`);

  return (await response.json()) as TargetInfo;
};

const closeTarget = async (port: number, targetId: string) => {
  const endpoint = `http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`;

  try {
    const response = await fetch(endpoint);
    if (!response.ok)
      throw new Error(`Failed to close CDP target: ${response.status}`);
  } catch {
    // Target cleanup is best-effort; every capture/evaluation uses a fresh target.
  }
};

const waitForCondition = async (
  cdp: CdpClient,
  expression: string,
  timeoutMs = getCdpReadyTimeoutMs(),
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await cdp.send<{ result?: { value?: boolean } }>(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        expression,
        returnByValue: true,
      },
    );

    if (result.result?.value) return;
    await sleep(150);
  }

  throw new Error(`Timed out waiting for page condition: ${expression}`);
};

type BrowserProcess = LaunchResult & {
  child: ChildProcessWithEvents;
  closed: boolean;
  profileDir: string;
};

let pooledBrowser: BrowserProcess | null = null;
let pooledBrowserStarting: Promise<BrowserProcess> | null = null;
let pooledBrowserRefCount = 0;
let pooledBrowserIdleTimer: ReturnType<typeof setTimeout> | null = null;

const isBrowserProcessClosed = (browser: BrowserProcess) =>
  browser.closed ||
  browser.child.exitCode !== null ||
  browser.child.signalCode !== null;

const clearPooledBrowserIdleTimer = () => {
  if (!pooledBrowserIdleTimer) return;
  clearTimeout(pooledBrowserIdleTimer);
  pooledBrowserIdleTimer = null;
};

const launchBrowserProcess = async (
  preferredPort?: number,
): Promise<BrowserProcess> => {
  const port = preferredPort ?? (await getAvailablePort());
  const browserBinary = resolveBrowserBinary();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "svg-to-html-cdp-"));
  const extraArgs =
    process.platform === "linux"
      ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-software-rasterizer",
        ]
      : [];

  let spawnError: null | Error = null;
  let stderrOutput = "";
  const child = spawn(
    browserBinary,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-component-extensions-with-background-pages",
      "--disable-domain-reliability",
      "--disable-extensions",
      "--disable-sync",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
      "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE 127.0.0.1",
      "--allow-file-access-from-files",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      // 统一 macOS / Linux 字体渲染行为
      "--font-render-hinting=none",
      "--disable-font-subpixel-positioning",
      "--lang=zh-CN",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  ) as ChildProcessWithEvents;

  child.on("error", (error: Error) => {
    spawnError = error;
  });
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderrOutput += String(chunk);
    if (stderrOutput.length > 8000) {
      stderrOutput = stderrOutput.slice(-8000);
    }
  });

  const browserProcess: BrowserProcess = {
    child,
    close: async () => {
      if (browserProcess.closed) return;
      browserProcess.closed = true;
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
      // Retry rm in case browser process hasn't fully released files yet
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rm(profileDir, { force: true, recursive: true });
          break;
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
        }
      }
    },
    closed: false,
    port,
    profileDir,
  };
  child.once("exit", () => {
    browserProcess.closed = true;
  });

  try {
    await waitForCdp(port);
  } catch (error) {
    await browserProcess.close();
    if (spawnError) throw spawnError;
    if (stderrOutput.trim()) {
      throw new Error(
        `CDP did not become ready on port ${port}. Browser stderr:\n${stderrOutput.trim()}`,
      );
    }
    throw error;
  }

  return browserProcess;
};

const getPooledBrowser = async () => {
  clearPooledBrowserIdleTimer();
  if (pooledBrowser && !isBrowserProcessClosed(pooledBrowser)) {
    return pooledBrowser;
  }
  pooledBrowser = null;

  if (!pooledBrowserStarting) {
    pooledBrowserStarting = launchBrowserProcess()
      .then((browser) => {
        pooledBrowser = browser;
        browser.child.once("exit", () => {
          if (pooledBrowser === browser) pooledBrowser = null;
          pooledBrowserRefCount = 0;
          clearPooledBrowserIdleTimer();
        });
        return browser;
      })
      .finally(() => {
        pooledBrowserStarting = null;
      });
  }

  return pooledBrowserStarting;
};

const releasePooledBrowser = async (browser: BrowserProcess) => {
  if (pooledBrowserRefCount > 0 || pooledBrowser !== browser) return;
  clearPooledBrowserIdleTimer();

  const browserPoolIdleMs = getBrowserPoolIdleMs();
  if (browserPoolIdleMs === 0) {
    pooledBrowser = null;
    await browser.close();
    return;
  }

  pooledBrowserIdleTimer = setTimeout(() => {
    pooledBrowserIdleTimer = null;
    if (pooledBrowserRefCount > 0 || pooledBrowser !== browser) return;
    pooledBrowser = null;
    void browser.close();
  }, browserPoolIdleMs);
};

const shutdownBrowserPool = async () => {
  clearPooledBrowserIdleTimer();
  const starting = pooledBrowserStarting;
  const browser = pooledBrowser;
  pooledBrowser = null;
  pooledBrowserRefCount = 0;

  const startedBrowser = starting ? await starting.catch(() => null) : null;
  await Promise.allSettled(
    [browser, startedBrowser]
      .filter((item): item is BrowserProcess => Boolean(item))
      .filter((item, index, items) => items.indexOf(item) === index)
      .map((item) => item.close()),
  );
};

const launchEdge = async (preferredPort?: number): Promise<LaunchResult> => {
  if (preferredPort || getBrowserPoolDisabled()) {
    const browser = await launchBrowserProcess(preferredPort);
    return {
      close: browser.close,
      port: browser.port,
    };
  }

  const browser = await getPooledBrowser();
  pooledBrowserRefCount += 1;
  let released = false;

  return {
    close: async () => {
      if (released) return;
      released = true;
      pooledBrowserRefCount = Math.max(0, pooledBrowserRefCount - 1);
      await releasePooledBrowser(browser);
    },
    port: browser.port,
  };
};

const capturePage = async ({
  clip,
  deviceScaleFactor = 1,
  // Default to an opaque base. The browser process is pooled and reused
  // across captures; without forcing a surface clear, stale pixels from a
  // previously captured page bleed through transparent regions and stack
  // onto the new screenshot ("duplicate/ghosted content"). Callers that
  // genuinely need transparency must opt in via transparentBackground.
  opaqueBackground = true,
  outputPath,
  port,
  readyExpression = 'document.readyState === "complete" && window.__RENDER_READY__ === true',
  readyTimeoutMs = getCdpReadyTimeoutMs(),
  transparentBackground = false,
  url,
  viewportHeight,
  viewportWidth,
}: {
  clip?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  deviceScaleFactor?: number;
  opaqueBackground?: boolean;
  outputPath: string;
  port: number;
  readyExpression?: string;
  readyTimeoutMs?: number;
  transparentBackground?: boolean;
  url: string;
  viewportHeight: number;
  viewportWidth: number;
}) => {
  const target = await createTarget(port);
  let cdp: CdpClient | undefined;
  const safeDeviceScaleFactor =
    Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
      ? deviceScaleFactor
      : 1;
  const metricViewportHeight = toCdpViewportSize(viewportHeight);
  const metricViewportWidth = toCdpViewportSize(viewportWidth);

  try {
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    if (transparentBackground) {
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { a: 0, b: 0, g: 0, r: 0 },
      });
    } else if (opaqueBackground) {
      // Force an opaque base so the compositor clears the surface each frame
      // before drawing (see the opaqueBackground default note above).
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { a: 255, b: 255, g: 255, r: 255 },
      });
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: safeDeviceScaleFactor,
      height: metricViewportHeight,
      mobile: false,
      screenHeight: metricViewportHeight,
      screenWidth: metricViewportWidth,
      width: metricViewportWidth,
    });
    await cdp.send("Page.navigate", { url });

    await waitForCondition(cdp, readyExpression, readyTimeoutMs);

    const screenshot = await cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        captureBeyondViewport: false,
        clip: toCdpScreenshotClip({
          height: clip?.height ?? viewportHeight,
          width: clip?.width ?? viewportWidth,
          x: clip?.x ?? 0,
          y: clip?.y ?? 0,
        }),
        format: "png",
        fromSurface: true,
      },
    );

    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  } finally {
    if (cdp) {
      try {
        await cdp.send("Page.stopLoading");
      } catch {}
      try {
        await cdp.send("Page.resetNavigationHistory");
      } catch {}
    }
    cdp?.close();
    await closeTarget(port, target.id);
  }
};

const evaluatePage = async <T>({
  deviceScaleFactor = 1,
  expression,
  evaluateTimeoutMs = getCdpSendTimeoutMs(),
  port,
  readyExpression = 'document.readyState === "complete" && window.__RENDER_READY__ === true',
  readyTimeoutMs = getCdpReadyTimeoutMs(),
  url,
  viewportHeight,
  viewportWidth,
}: {
  deviceScaleFactor?: number;
  expression: string;
  evaluateTimeoutMs?: number;
  port: number;
  readyExpression?: string;
  readyTimeoutMs?: number;
  url: string;
  viewportHeight: number;
  viewportWidth: number;
}) => {
  const safeDeviceScaleFactor =
    Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0
      ? deviceScaleFactor
      : 1;
  const metricViewportHeight = toCdpViewportSize(viewportHeight);
  const metricViewportWidth = toCdpViewportSize(viewportWidth);
  const target = await createTarget(port);
  let cdp: CdpClient | undefined;

  try {
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: safeDeviceScaleFactor,
      height: metricViewportHeight,
      mobile: false,
      screenHeight: metricViewportHeight,
      screenWidth: metricViewportWidth,
      width: metricViewportWidth,
    });
    await cdp.send("Page.navigate", { url });

    await waitForCondition(cdp, readyExpression, readyTimeoutMs);

    const result = await cdp.send<{
      exceptionDetails?: {
        exception?: { description?: string; value?: string };
        text?: string;
      };
      result?: { value?: T };
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    }, evaluateTimeoutMs);

    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text ??
        "Unknown page evaluation error";
      throw new Error(`Page evaluation failed: ${detail}`);
    }

    return result.result?.value as T;
  } finally {
    cdp?.close();
    await closeTarget(port, target.id);
  }
};

export {
  capturePage,
  CdpClient,
  closeTarget,
  createTarget,
  detectBrowserBinary,
  evaluatePage,
  launchEdge,
  shutdownBrowserPool,
  waitForCondition,
};

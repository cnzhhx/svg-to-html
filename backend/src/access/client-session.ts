import { createHash, randomBytes } from "node:crypto";

import type { Request, Response } from "express";

const CLIENT_COOKIE_NAME = "svg_to_html_client";
const CLIENT_COOKIE_PATH = "/transformer";
const CLIENT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const CLIENT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const readCookie = (request: Request, name: string) => {
  const header = request.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
};

const isSecureRequest = (request: Request) =>
  request.secure || String(request.headers["x-forwarded-proto"] ?? "") === "https";

const writeClientCookie = (request: Request, response: Response, value: string) => {
  const attributes = [
    `${CLIENT_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${CLIENT_COOKIE_PATH}`,
    `Max-Age=${CLIENT_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(isSecureRequest(request) ? ["Secure"] : []),
  ];
  response.append("Set-Cookie", attributes.join("; "));
};

const clientKeyForToken = (token: string) =>
  createHash("sha256").update(`svg-to-html-client\0${token}`).digest("hex");

const ensureClientKey = (request: Request, response: Response) => {
  const existing = readCookie(request, CLIENT_COOKIE_NAME);
  const token = CLIENT_TOKEN_PATTERN.test(existing)
    ? existing
    : randomBytes(32).toString("hex");
  if (token !== existing) writeClientCookie(request, response, token);
  return clientKeyForToken(token);
};

export { CLIENT_COOKIE_NAME, clientKeyForToken, ensureClientKey };

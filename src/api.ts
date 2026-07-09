import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export const API_BASE = process.env.TEMPMD_API_URL ?? "https://api.temp.md";

export type FileInput = {
  // Path inside the published bundle, e.g. "assets/app.js"
  bundlePath: string;
  // Absolute path on disk to read from
  sourcePath: string;
};

export type PublishResult = {
  tempId: string;
  canonicalUrl: string;
  updateToken: string;
  claimToken: string;
  claimLink: string;
  expiresAt: string;
};

export type UpdateResult = {
  tempId: string;
  canonicalUrl: string;
  versionId: string;
  expiresAt: string;
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown;
  let message = `temp.md API responded ${res.status}`;
  try {
    body = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    // non-JSON error body — keep the status message
  }
  return new ApiError(message, res.status, body);
}

// The main file is always stored at index.html in the bundle; its content type
// (html/markdown/csv/mermaid) is what drives rendering in the resolver, so it
// must reflect the real source file, not the bundle path.
async function buildFormData(mainFile: string, additionalFiles: FileInput[], title?: string): Promise<FormData> {
  const form = new FormData();

  const mainBuf = await readFile(mainFile);
  form.set(
    "file",
    new Blob([new Uint8Array(mainBuf)], { type: guessContentType(mainFile) }),
    basename(mainFile)
  );

  for (const f of additionalFiles) {
    const buf = await readFile(f.sourcePath);
    form.set(
      `files/${f.bundlePath}`,
      new Blob([new Uint8Array(buf)], { type: guessContentType(f.bundlePath) }),
      basename(f.bundlePath)
    );
  }

  if (title) form.set("title", title);
  return form;
}

export async function publishTemp(
  mainFile: string,
  additionalFiles: FileInput[],
  title?: string
): Promise<PublishResult> {
  const form = await buildFormData(mainFile, additionalFiles, title);
  const res = await fetch(`${API_BASE}/temps`, { method: "POST", body: form });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as PublishResult;
}

export async function updateTemp(
  tempId: string,
  updateToken: string,
  mainFile: string,
  additionalFiles: FileInput[],
  title?: string
): Promise<UpdateResult> {
  const form = await buildFormData(mainFile, additionalFiles, title);
  const res = await fetch(`${API_BASE}/temps/${tempId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${updateToken}` },
    body: form,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as UpdateResult;
}

export async function getTempStatus(tempId: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/temps/${tempId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as Record<string, unknown>;
}

export async function restoreTemp(tempId: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/temps/${tempId}/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as Record<string, unknown>;
}

export async function snapshotTemp(
  tempId: string,
  token: string,
  label?: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/temps/${tempId}/snapshot`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(label ? { label } : {}),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as Record<string, unknown>;
}

export async function setComments(tempId: string, token: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/temps/${tempId}/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commentsEnabled: enabled }),
  });
  if (!res.ok) throw await parseError(res);
}

// Mirrors the API's guessContentType map so uploads carry the right MIME even
// when read from disk (Node gives us no file.type).
export function guessContentType(path: string): string {
  const ext = path.split(".").at(-1)?.toLowerCase();
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    md: "text/markdown",
    mmd: "text/x-mermaid",
    csv: "text/csv",
    txt: "text/plain",
    xml: "application/xml",
    webmanifest: "application/manifest+json",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

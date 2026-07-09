#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import {
  publishTemp,
  updateTemp,
  getTempStatus,
  restoreTemp,
  snapshotTemp,
  setComments,
  ApiError,
  type FileInput,
} from "./api.js";
import { appendRecord, touchRecord, resolveRecord, readRecords, recordsPath } from "./records.js";

const server = new McpServer(
  { name: "tempmd", version: "0.2.0" },
  {
    instructions: `temp.md gives in-progress work one stable public link while it evolves.

Semantics to preserve:
- A Temp is the primary object. The canonical URL (slug.temp.md) is the only link to share with humans — never surface version-specific links.
- Updating a Temp keeps the same URL and resets its 7-day active window. A failed update never breaks the live link.
- Temps expire intentionally when inactive (48h cooling first) and can be restored within 7 days of expiry.
- Publish records are stored in the project's .tempmd file; update_temp reads it automatically, so prefer updating an existing Temp over publishing a new one for the same artifact.
- After a first publish, offer the user the claim link (claimed Temps are managed from the dashboard) and offer to enable pinned comments on the page.
- Claiming ROTATES the update token: the claim page shows a new token, and the old one stops working. If an update returns 403 after the user claimed, ask them for the new token and update .tempmd.
- Owners can password-protect a claimed Temp from the dashboard; use snapshot_temp when an exact frozen state matters (sign-offs) — the canonical link stays latest-first.`,
  }
);

const projectDirSchema = z
  .string()
  .optional()
  .describe("Project root holding the .tempmd records file. Defaults to the current working directory.");

const additionalFilesSchema = z
  .array(
    z.object({
      bundle_path: z.string().describe("Path inside the published bundle, e.g. assets/app.js"),
      source_path: z.string().describe("Absolute path of the file on disk"),
    })
  )
  .optional()
  .describe("Extra files to publish alongside the main file (scripts, styles, images)");

function toFileInputs(files?: { bundle_path: string; source_path: string }[]): FileInput[] {
  return (files ?? []).map((f) => ({ bundlePath: f.bundle_path, sourcePath: f.source_path }));
}

function resolveProjectDir(projectDir?: string): string {
  return projectDir ? resolve(projectDir) : process.cwd();
}

function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`file must be an absolute path, got: ${path}`);
  }
  return path;
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const detail = err instanceof ApiError && err.body ? `\n${JSON.stringify(err.body)}` : "";
  return { content: [{ type: "text" as const, text: `Error: ${message}${detail}` }], isError: true };
}

// ─── publish_temp ─────────────────────────────────────────────────────────────

server.registerTool(
  "publish_temp",
  {
    title: "Publish a new Temp",
    description:
      "Publish an artifact (HTML, Markdown, CSV, or Mermaid) to temp.md and get a stable public URL. " +
      "Use only for a NEW artifact — if this project already has a Temp for it (check .tempmd), use update_temp to keep the same link. " +
      "The record is saved to .tempmd automatically.",
    inputSchema: {
      file: z.string().describe("Absolute path to the main artifact file (.html, .md, .csv, .mmd)"),
      additional_files: additionalFilesSchema,
      title: z.string().optional().describe("Display title (defaults to the HTML <title> if present)"),
      project_dir: projectDirSchema,
    },
  },
  async ({ file, additional_files, title, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const result = await publishTemp(requireAbsolute(file), toFileInputs(additional_files), title);
      await appendRecord(dir, {
        tempId: result.tempId,
        canonicalUrl: result.canonicalUrl,
        updateToken: result.updateToken,
        expiresAt: result.expiresAt,
        claimLink: result.claimLink,
      });
      return ok({
        canonicalUrl: result.canonicalUrl,
        tempId: result.tempId,
        expiresAt: result.expiresAt,
        claimLink: result.claimLink,
        recordSavedTo: recordsPath(dir),
        nextSteps: [
          `Share ${result.canonicalUrl} — it stays the same across future updates (use update_temp).`,
          `Ask the user: claim this Temp to keep it? Claim link: ${result.claimLink}`,
          "Ask the user: enable pinned comments on the page? If yes, call set_comments.",
        ],
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── update_temp ──────────────────────────────────────────────────────────────

server.registerTool(
  "update_temp",
  {
    title: "Update an existing Temp",
    description:
      "Push a new version of an artifact behind the same temp.md URL — no re-sharing needed. " +
      "Resets the 7-day active window. Reads temp_id and update_token from the project's .tempmd file when omitted. " +
      "If the update fails, the previous version stays live.",
    inputSchema: {
      file: z.string().describe("Absolute path to the updated main artifact file"),
      additional_files: additionalFilesSchema,
      temp_id: z.string().optional().describe("Temp ID (omit to use the project's .tempmd record)"),
      update_token: z.string().optional().describe("Update token (omit to use the project's .tempmd record)"),
      title: z.string().optional(),
      project_dir: projectDirSchema,
    },
  },
  async ({ file, additional_files, temp_id, update_token, title, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const { tempId, updateToken } = await resolveRecord(dir, temp_id, update_token);
      const result = await updateTemp(
        tempId,
        updateToken,
        requireAbsolute(file),
        toFileInputs(additional_files),
        title
      );
      await touchRecord(dir, tempId, result.expiresAt);
      return ok({
        canonicalUrl: result.canonicalUrl,
        tempId: result.tempId,
        versionId: result.versionId,
        expiresAt: result.expiresAt,
        note: "Same link, new version. No re-sharing needed.",
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── get_temp_status ──────────────────────────────────────────────────────────

server.registerTool(
  "get_temp_status",
  {
    title: "Get Temp status",
    description:
      "Check a Temp's lifecycle: active/cooling/expired, when it expires, and whether it can be restored. " +
      "Reads credentials from the project's .tempmd file when omitted.",
    inputSchema: {
      temp_id: z.string().optional(),
      update_token: z.string().optional(),
      project_dir: projectDirSchema,
    },
  },
  async ({ temp_id, update_token, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const { tempId, updateToken } = await resolveRecord(dir, temp_id, update_token);
      return ok(await getTempStatus(tempId, updateToken));
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── restore_temp ─────────────────────────────────────────────────────────────

server.registerTool(
  "restore_temp",
  {
    title: "Restore an expired Temp",
    description:
      "Reactivate a recently expired Temp — the same canonical URL comes back to life. " +
      "Only works within 7 days of expiry. Reads credentials from .tempmd when omitted.",
    inputSchema: {
      temp_id: z.string().optional(),
      update_token: z.string().optional(),
      project_dir: projectDirSchema,
    },
  },
  async ({ temp_id, update_token, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const { tempId, updateToken } = await resolveRecord(dir, temp_id, update_token);
      const result = await restoreTemp(tempId, updateToken);
      if (typeof result.expiresAt === "string") {
        await touchRecord(dir, tempId, result.expiresAt);
      }
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── snapshot_temp ────────────────────────────────────────────────────────────

server.registerTool(
  "snapshot_temp",
  {
    title: "Freeze a snapshot",
    description:
      "Freeze the current version of a Temp as a fixed reference with its own URL — for sign-offs and 'approve exactly this' moments. " +
      "The canonical link keeps serving the latest version; share the snapshot URL only when exactness matters. " +
      "Reads credentials from the project's .tempmd file when omitted.",
    inputSchema: {
      label: z.string().optional().describe("Optional label for the snapshot, e.g. 'client sign-off v2'"),
      temp_id: z.string().optional(),
      update_token: z.string().optional(),
      project_dir: projectDirSchema,
    },
  },
  async ({ label, temp_id, update_token, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const { tempId, updateToken } = await resolveRecord(dir, temp_id, update_token);
      return ok(await snapshotTemp(tempId, updateToken, label));
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── set_comments ─────────────────────────────────────────────────────────────

server.registerTool(
  "set_comments",
  {
    title: "Enable or disable comments",
    description:
      "Toggle pinned visitor comments (Pindrop) on a Temp's page. " +
      "Reads credentials from the project's .tempmd file when omitted.",
    inputSchema: {
      enabled: z.boolean().describe("true to enable comments, false to disable"),
      temp_id: z.string().optional(),
      update_token: z.string().optional(),
      project_dir: projectDirSchema,
    },
  },
  async ({ enabled, temp_id, update_token, project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const { tempId, updateToken, canonicalUrl } = await resolveRecord(dir, temp_id, update_token);
      await setComments(tempId, updateToken, enabled);
      return ok({
        tempId,
        commentsEnabled: enabled,
        note: enabled
          ? `Visitors can now leave pinned feedback directly on ${canonicalUrl ?? "the page"}.`
          : "Comments disabled.",
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ─── list_temps ───────────────────────────────────────────────────────────────

server.registerTool(
  "list_temps",
  {
    title: "List this project's Temps",
    description: "List the Temps recorded in this project's .tempmd file (local records, no network call).",
    inputSchema: {
      project_dir: projectDirSchema,
    },
  },
  async ({ project_dir }) => {
    try {
      const dir = resolveProjectDir(project_dir);
      const records = await readRecords(dir);
      return ok(
        records.map((r) => ({ tempId: r.tempId, canonicalUrl: r.canonicalUrl, expiresAt: r.expiresAt }))
      );
    } catch (err) {
      return fail(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

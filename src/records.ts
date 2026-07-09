import { readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The .tempmd project record file. One line per Temp, same format the API's
// publish hint asks agents to write, so both flows interoperate:
//   Temp ID: <id> | URL: <url> | Update Token: <token> | Expires: <iso> | Claim Link: <link>

export type TempRecord = {
  tempId: string;
  canonicalUrl: string;
  updateToken: string;
  expiresAt: string;
  claimLink?: string;
};

export function recordsPath(projectDir: string): string {
  return join(projectDir, ".tempmd");
}

function formatRecord(r: TempRecord): string {
  const parts = [
    `Temp ID: ${r.tempId}`,
    `URL: ${r.canonicalUrl}`,
    `Update Token: ${r.updateToken}`,
    `Expires: ${r.expiresAt}`,
  ];
  if (r.claimLink) parts.push(`Claim Link: ${r.claimLink}`);
  return parts.join(" | ");
}

function parseLine(line: string): TempRecord | null {
  const fields = new Map<string, string>();
  for (const part of line.split("|")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    fields.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
  }
  const tempId = fields.get("temp id");
  const canonicalUrl = fields.get("url");
  const updateToken = fields.get("update token");
  if (!tempId || !canonicalUrl || !updateToken) return null;
  return {
    tempId,
    canonicalUrl,
    updateToken,
    expiresAt: fields.get("expires") ?? "",
    claimLink: fields.get("claim link"),
  };
}

export async function readRecords(projectDir: string): Promise<TempRecord[]> {
  let raw: string;
  try {
    raw = await readFile(recordsPath(projectDir), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => parseLine(line.trim()))
    .filter((r): r is TempRecord => r !== null);
}

export async function appendRecord(projectDir: string, record: TempRecord): Promise<void> {
  await appendFile(recordsPath(projectDir), formatRecord(record) + "\n", "utf8");
}

// Rewrites the matching record's Expires field after an update or restore.
export async function touchRecord(projectDir: string, tempId: string, expiresAt: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(recordsPath(projectDir), "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").map((line) => {
    const parsed = parseLine(line.trim());
    if (parsed?.tempId !== tempId) return line;
    return formatRecord({ ...parsed, expiresAt });
  });
  await writeFile(recordsPath(projectDir), lines.join("\n"), "utf8");
}

// Resolves which Temp a tool call refers to: explicit args win; otherwise fall
// back to the project's .tempmd records (unambiguous only if a single record,
// unless tempId narrows it down).
export async function resolveRecord(
  projectDir: string,
  tempId?: string,
  updateToken?: string
): Promise<{ tempId: string; updateToken: string; canonicalUrl?: string }> {
  if (tempId && updateToken) return { tempId, updateToken };

  const records = await readRecords(projectDir);

  if (tempId) {
    const match = records.find((r) => r.tempId === tempId);
    if (updateToken) return { tempId, updateToken };
    if (!match) {
      throw new Error(
        `No update token given and no record for Temp ${tempId} in ${recordsPath(projectDir)}. Pass update_token explicitly.`
      );
    }
    return { tempId, updateToken: match.updateToken, canonicalUrl: match.canonicalUrl };
  }

  if (records.length === 0) {
    throw new Error(
      `No .tempmd records found in ${projectDir}. Pass temp_id and update_token explicitly, or publish_temp first.`
    );
  }
  if (records.length > 1) {
    throw new Error(
      `Multiple Temps recorded in ${recordsPath(projectDir)} — pass temp_id to pick one: ` +
        records.map((r) => `${r.tempId} (${r.canonicalUrl})`).join(", ")
    );
  }
  const only = records[0];
  return { tempId: only.tempId, updateToken: updateToken ?? only.updateToken, canonicalUrl: only.canonicalUrl };
}

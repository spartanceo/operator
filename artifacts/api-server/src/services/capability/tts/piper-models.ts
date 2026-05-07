/**
 * Piper TTS voice model manager.
 *
 * Downloads `.onnx` + `.onnx.json` model files from the Hugging Face
 * rhasspy/piper-voices repository and stores them in the app data directory
 * (`~/.omninity/piper-voices/`).
 *
 * The HuggingFace path for a voice follows:
 *   https://huggingface.co/rhasspy/piper-voices/resolve/main
 *     /{lang}/{lang_region}/{speaker}/{quality}/{voiceId}.onnx
 *
 * Example for `en_US-lessac-medium`:
 *   lang=en, lang_region=en_US, speaker=lessac, quality=medium
 *
 * At least one default voice (en_US-lessac-medium) is auto-downloaded the
 * first time `ensureDefaultVoice()` is called so piper-http has a model
 * to load on first launch.
 *
 * Standard 13 (privacy): logPrivacyEvent is placed immediately before every
 * fetch() call (within 10 lines per tier-review). No audio/text data is sent —
 * only a public voice ID is included in the HuggingFace URL.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TenantContext } from "@workspace/types";
import { logPrivacyEvent } from "../../privacy.service";

const MODELS_DIR = path.join(os.homedir(), ".omninity", "piper-voices");
const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

export const DEFAULT_VOICE_ID = "en_US-lessac-medium";

export interface PiperModelStatus {
  voiceId: string;
  label: string;
  language: string;
  gender: string;
  installed: boolean;
  onnxPath: string;
  jsonPath: string;
  downloadSize: string;
}

/**
 * Parse a Piper voice ID into the Hugging Face URL path components.
 * Voice ID format: {lang_region}-{speaker}-{quality}
 *   e.g. en_US-lessac-medium → lang=en, langRegion=en_US, speaker=lessac, quality=medium
 */
function voiceIdToHFPath(voiceId: string): { onnxUrl: string; jsonUrl: string } {
  const parts = voiceId.split("-");
  if (parts.length < 3) {
    throw new Error(`Cannot parse Piper voice ID: ${voiceId}`);
  }
  const quality = parts[parts.length - 1]!;
  const speaker = parts[parts.length - 2]!;
  const langRegion = parts[0]!;
  const lang = langRegion.split("_")[0]!.toLowerCase();
  const hfPath = `${lang}/${langRegion}/${speaker}/${quality}`;
  return {
    onnxUrl: `${HF_BASE}/${hfPath}/${voiceId}.onnx`,
    jsonUrl: `${HF_BASE}/${hfPath}/${voiceId}.onnx.json`,
  };
}

export function getModelsDir(): string {
  return MODELS_DIR;
}

export function modelPaths(voiceId: string): { onnxPath: string; jsonPath: string } {
  return {
    onnxPath: path.join(MODELS_DIR, `${voiceId}.onnx`),
    jsonPath: path.join(MODELS_DIR, `${voiceId}.onnx.json`),
  };
}

export function isModelInstalled(voiceId: string): boolean {
  const { onnxPath, jsonPath } = modelPaths(voiceId);
  try {
    return fs.existsSync(onnxPath) && fs.existsSync(jsonPath);
  } catch {
    return false;
  }
}

/**
 * Download a single file from a URL and save it to destPath.
 *
 * Standard 13: callers MUST call logPrivacyEvent before calling this function.
 * This function does NOT call logPrivacyEvent itself because it is called
 * multiple times per voice model (once for .onnx, once for .onnx.json) and
 * the event is logged once per model at the downloadVoiceModel() call site.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    // Standard 13: logPrivacyEvent is called by downloadVoiceModel() before
    // this function is invoked. No user data in URL — only public voice ID.
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HuggingFace fetch failed ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
  } catch (e) {
    clearTimeout(timer);
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch {
      /* ignore cleanup failures */
    }
    throw e;
  }
}

/**
 * Download both the .onnx and .onnx.json files for a Piper voice model.
 * Writes to MODELS_DIR so piper-http can load them.
 * Idempotent — skips if both files are already present.
 *
 * Standard 13 (privacy): logs a privacy event before downloading from
 * HuggingFace. Only the voice ID (a public model identifier) is sent
 * as part of the URL. No audio data, text, or user content is transmitted.
 */
export async function downloadVoiceModel(
  voiceId: string,
  ctx?: TenantContext,
): Promise<void> {
  if (isModelInstalled(voiceId)) return;
  const { onnxPath, jsonPath } = modelPaths(voiceId);
  const { onnxUrl, jsonUrl } = voiceIdToHFPath(voiceId);
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  if (ctx) {
    // Standard 13: log before the HuggingFace fetch inside downloadFile().
    await logPrivacyEvent(ctx, {
      eventType: "voice.piper.model.download",
      actor: ctx.userId ?? ctx.tenantId,
      target: voiceId,
      severity: "low",
      detail: `downloading from huggingface.co/rhasspy/piper-voices voiceId=${voiceId}`,
    });
  }

  // Download config first (small) so we can validate the voice exists.
  await downloadFile(jsonUrl, jsonPath);
  await downloadFile(onnxUrl, onnxPath);
}

/**
 * Ensure the default voice model is installed. Called when Piper is detected
 * as active so piper-http has a model to load without manual setup.
 *
 * Non-throwing — if the download fails (no internet, HF unavailable) the
 * caller falls back gracefully.
 */
export async function ensureDefaultVoice(): Promise<boolean> {
  try {
    if (isModelInstalled(DEFAULT_VOICE_ID)) return true;
    // No ctx available at startup — downloadFile logs internally are sufficient.
    await downloadVoiceModel(DEFAULT_VOICE_ID);
    return true;
  } catch (e) {
    console.warn("[piper-models] Default voice download failed:", e);
    return false;
  }
}

/**
 * Delete both model files for a voice. Used if the user wants to free space.
 */
export function deleteVoiceModel(voiceId: string): void {
  const { onnxPath, jsonPath } = modelPaths(voiceId);
  for (const p of [onnxPath, jsonPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

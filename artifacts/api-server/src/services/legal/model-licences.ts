/**
 * Bundled / downloadable model licence catalogue (Task #25).
 *
 * The Software ships with a curated set of foundation models. Each entry
 * here records the upstream licence, the permitted commercial-use
 * verdict, and the user-facing restrictions that must be disclosed at
 * download time.
 *
 * Adding a model: append a row below. The /api/legal/model-licences
 * endpoint serialises this list verbatim — keep it data-only (Standard
 * 12, config as data).
 *
 * Sources reviewed:
 *   - Llama 3:           Meta Llama 3 Community Licence (commercial use OK
 *                        for entities < 700M MAU)
 *   - Mistral 7B:        Apache-2.0
 *   - Qwen 2.5 / Coder:  Apache-2.0 (Tongyi Qianwen Licence for some sizes)
 *   - LLaVA / Moondream: Apache-2.0 (vision adapters)
 *   - Phi-3:             MIT
 *   - Whisper:           MIT
 *   - Stable Diffusion:  CreativeML Open RAIL-M (commercial OK with
 *                        downstream restrictions on illegal/harmful use)
 *   - FLUX.1 [schnell]:  Apache-2.0
 *   - FLUX.1 [dev]:      FLUX.1 [dev] Non-Commercial Licence
 *                        (non-commercial only — DISALLOWED in the default
 *                        bundle; surfaced in the catalogue with a clear
 *                        warning so power users who acquire a commercial
 *                        licence can opt in manually).
 *   - MusicGen:          CC-BY-NC-4.0 for the model weights
 *                        (non-commercial only — DISALLOWED in the default
 *                        bundle; surfaced with a warning).
 *   - Kokoro TTS:        Apache-2.0
 */

export type ModelCommercialUseVerdict =
  | "permitted"
  | "permitted_with_conditions"
  | "non_commercial_only";

export interface ModelLicenceEntry {
  readonly modelId: string;
  readonly displayName: string;
  readonly licenceName: string;
  readonly licenceSpdxId: string | null;
  readonly licenceUrl: string;
  readonly commercialUse: ModelCommercialUseVerdict;
  readonly bundledByDefault: boolean;
  readonly summary: string;
  readonly restrictions: ReadonlyArray<string>;
}

export const MODEL_LICENCES: ReadonlyArray<ModelLicenceEntry> = [
  {
    modelId: "llama3.1:8b",
    displayName: "Llama 3.1 8B",
    licenceName: "Meta Llama 3 Community Licence",
    licenceSpdxId: null,
    licenceUrl: "https://llama.meta.com/llama3/license/",
    commercialUse: "permitted_with_conditions",
    bundledByDefault: true,
    summary:
      "Commercial use permitted for entities with fewer than 700M monthly active users.",
    restrictions: [
      "Display 'Built with Meta Llama 3' on user-facing surfaces.",
      "Do not use Llama outputs to improve any other large language model.",
      "Comply with the Llama 3 Acceptable Use Policy.",
    ],
  },
  {
    modelId: "llama3.1:70b",
    displayName: "Llama 3.1 70B",
    licenceName: "Meta Llama 3 Community Licence",
    licenceSpdxId: null,
    licenceUrl: "https://llama.meta.com/llama3/license/",
    commercialUse: "permitted_with_conditions",
    bundledByDefault: false,
    summary:
      "Same Meta Llama 3 Community Licence terms as the 8B variant.",
    restrictions: [
      "Display 'Built with Meta Llama 3' on user-facing surfaces.",
      "Do not use Llama outputs to improve any other large language model.",
    ],
  },
  {
    modelId: "mistral:7b",
    displayName: "Mistral 7B Instruct",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "Permissive open-source licence — commercial use permitted.",
    restrictions: [
      "Reproduce the Apache-2.0 notice in distributed copies.",
    ],
  },
  {
    modelId: "qwen2.5-coder:7b",
    displayName: "Qwen 2.5 Coder 7B",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "Apache-2.0 — commercial coding assistance permitted.",
    restrictions: [
      "Reproduce the Apache-2.0 notice in distributed copies.",
    ],
  },
  {
    modelId: "phi3:mini",
    displayName: "Phi-3 Mini (3.8B)",
    licenceName: "MIT",
    licenceSpdxId: "MIT",
    licenceUrl: "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "MIT licence — commercial use permitted with attribution.",
    restrictions: ["Reproduce the MIT copyright notice."],
  },
  {
    modelId: "moondream:1.8b",
    displayName: "Moondream 2 (vision)",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://huggingface.co/vikhyatk/moondream2/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "Apache-2.0 vision companion — commercial use permitted.",
    restrictions: ["Reproduce the Apache-2.0 notice."],
  },
  {
    modelId: "llava:7b",
    displayName: "LLaVA 7B (vision)",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://github.com/haotian-liu/LLaVA/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: false,
    summary: "Apache-2.0 — commercial use permitted.",
    restrictions: ["Reproduce the Apache-2.0 notice."],
  },
  {
    modelId: "whisper:base",
    displayName: "Whisper (speech-to-text)",
    licenceName: "MIT",
    licenceSpdxId: "MIT",
    licenceUrl: "https://github.com/openai/whisper/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "MIT licence — commercial use permitted.",
    restrictions: ["Reproduce the MIT copyright notice."],
  },
  {
    modelId: "stable-diffusion-xl",
    displayName: "Stable Diffusion XL",
    licenceName: "CreativeML Open RAIL-M",
    licenceSpdxId: null,
    licenceUrl:
      "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
    commercialUse: "permitted_with_conditions",
    bundledByDefault: false,
    summary:
      "Open responsible AI licence — commercial use permitted; downstream users must accept the same use-based restrictions.",
    restrictions: [
      "Forbidden uses: illegal content, harassment, misinformation, surveillance.",
      "Pass the licence and use-based restrictions through to derivatives.",
    ],
  },
  {
    modelId: "flux.1-schnell",
    displayName: "FLUX.1 [schnell]",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md",
    commercialUse: "permitted",
    bundledByDefault: false,
    summary: "Apache-2.0 — commercial image generation permitted.",
    restrictions: ["Reproduce the Apache-2.0 notice."],
  },
  {
    modelId: "flux.1-dev",
    displayName: "FLUX.1 [dev]",
    licenceName: "FLUX.1 [dev] Non-Commercial Licence",
    licenceSpdxId: null,
    licenceUrl: "https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md",
    commercialUse: "non_commercial_only",
    bundledByDefault: false,
    summary:
      "Non-commercial licence — NOT bundled. Power users with a separate commercial agreement may opt in manually.",
    restrictions: [
      "No commercial use without a separate licence from Black Forest Labs.",
      "Output may not be used to train competing image models.",
    ],
  },
  {
    modelId: "musicgen-medium",
    displayName: "MusicGen Medium",
    licenceName: "CC-BY-NC-4.0 (weights)",
    licenceSpdxId: "CC-BY-NC-4.0",
    licenceUrl: "https://creativecommons.org/licenses/by-nc/4.0/",
    commercialUse: "non_commercial_only",
    bundledByDefault: false,
    summary:
      "Model weights are CC-BY-NC — NOT bundled. Use only for personal / research projects.",
    restrictions: [
      "No commercial use of generated audio.",
      "Provide attribution to Meta AI when sharing outputs.",
    ],
  },
  {
    modelId: "kokoro-tts",
    displayName: "Kokoro TTS",
    licenceName: "Apache 2.0",
    licenceSpdxId: "Apache-2.0",
    licenceUrl: "https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE",
    commercialUse: "permitted",
    bundledByDefault: true,
    summary: "Apache-2.0 text-to-speech — commercial use permitted.",
    restrictions: ["Reproduce the Apache-2.0 notice."],
  },
];

export function getModelLicence(modelId: string): ModelLicenceEntry | undefined {
  return MODEL_LICENCES.find((m) => m.modelId === modelId);
}

export function getDefaultBundledLicences(): ReadonlyArray<ModelLicenceEntry> {
  return MODEL_LICENCES.filter((m) => m.bundledByDefault);
}

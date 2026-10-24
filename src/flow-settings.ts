export const IMAGE_MODELS = ["Nano Banana 2.1", "Nano Banana Pro", "Nano Banana 2 Lite"] as const;
export const VIDEO_MODELS = ["Omni 1.1 Flash", "Veo 3.1 - Lite", "Veo 3.1 - Fast", "Veo 3.1 - Quality"] as const;
export const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const DURATIONS = [4, 6, 8, 10] as const;
export const RESOLUTIONS = ["720p", "360p"] as const;

export type FlowModel = typeof IMAGE_MODELS[number] | typeof VIDEO_MODELS[number];

export interface GenerationSettings {
  type: "image" | "video";
  model: FlowModel;
  aspectRatio: typeof ASPECT_RATIOS[number];
  outputs: number;
  videoMode?: "frames" | "ingredients";
  durationSeconds?: number;
  resolution?: typeof RESOLUTIONS[number];
}

// A setting with one allowed value has no control in the Flow popover; with several, it must be chosen explicitly.
interface ModelRule {
  type: "image" | "video";
  aspects: readonly string[];
  durations?: readonly number[];
  resolutions?: readonly string[];
}

const IMAGE_RULE: ModelRule = { type: "image", aspects: ASPECT_RATIOS };
const VEO_RULE: ModelRule = { type: "video", aspects: ["16:9", "9:16"], durations: [8], resolutions: ["720p"] };

export const MODEL_RULES: Record<FlowModel, ModelRule> = {
  "Nano Banana 2.1": IMAGE_RULE,
  "Nano Banana Pro": IMAGE_RULE,
  "Nano Banana 2 Lite": IMAGE_RULE,
  "Omni 1.1 Flash": { type: "video", aspects: ["16:9", "9:16"], durations: DURATIONS, resolutions: RESOLUTIONS },
  "Veo 3.1 - Lite": VEO_RULE,
  "Veo 3.1 - Fast": VEO_RULE,
  "Veo 3.1 - Quality": VEO_RULE,
};

const checkOption = <T>(name: string, value: T | undefined, options: readonly T[] | undefined, model: string): string[] => {
  if (!options) return value === undefined ? [] : [`${name} is not available for ${model}.`];
  if (value === undefined) return options.length > 1 ? [`${name} is required for ${model} (${options.join(", ")}).`] : [];
  return options.includes(value) ? [] : [`${name} ${value} is not available for ${model} (${options.join(", ")}).`];
};

export function settingsErrors(settings: GenerationSettings): string[] {
  const rule = MODEL_RULES[settings.model];
  if (!rule) return [`Unknown model: ${settings.model}.`];
  if (rule.type !== settings.type) return [`${settings.model} is a ${rule.type} model, not ${settings.type}.`];
  return [
    ...checkOption("aspectRatio", settings.aspectRatio, rule.aspects, settings.model),
    ...checkOption("durationSeconds", settings.durationSeconds, rule.durations, settings.model),
    ...checkOption("resolution", settings.resolution, rule.resolutions, settings.model),
    ...(settings.type === "image" && settings.videoMode ? ["videoMode is only for video."] : []),
  ];
}

export function parseCreditLine(text: string): number | undefined {
  const match = text.match(/Generating will use ([\d,]+) credits?/i);
  return match ? Number(match[1].replace(/,/g, "")) : undefined;
}

export function assertWithinCreditLimit(credits: number | undefined, maxCredits: number): void {
  if (credits === undefined) throw new Error("Could not read \"Generating will use N credits\" from Flow settings; refusing to submit.");
  if (credits > maxCredits) throw new Error(`Flow says this generation will use ${credits} credits, above maxCredits ${maxCredits}; refusing to submit.`);
}

export function matchMention(afterAt: string, titles: string[]): string | undefined {
  return titles
    .filter((title) => afterAt.startsWith(title) && !/[\p{L}\p{N}_]/u.test(afterAt.charAt(title.length)))
    .sort((a, b) => b.length - a.length)[0];
}

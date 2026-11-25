import { z } from "zod";
import type {
  AspectRatioOption,
  GeneratedSlideConfig,
  GeneratedSlideTemplate,
  StoryboardLanguage,
} from "../types/studio";

export const ASPECT_RATIO_SLIDE_DIMENSIONS: Record<
  AspectRatioOption,
  { width: number; height: number }
> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
};

export const SLIDE_TEMPLATE_OPTIONS: ReadonlyArray<{
  value: GeneratedSlideTemplate;
  label: string;
  description: string;
}> = [
  {
    value: "title",
    label: "Title Card",
    description: "Centered high-impact opening or scene headline.",
  },
  {
    value: "educational",
    label: "Educational Point",
    description: "Structured heading with readable explanatory body text.",
  },
  {
    value: "section_heading",
    label: "Section Heading",
    description: "Clean chapter divider card with optional accent label.",
  },
  {
    value: "closing",
    label: "Closing Card",
    description: "Summary or call-to-action ending graphic.",
  },
];

export const SLIDE_COLOR_PRESETS: ReadonlyArray<{
  label: string;
  backgroundColor: string;
  gradientColor: string;
  textColor: string;
}> = [
  {
    label: "Obsidian Violet",
    backgroundColor: "#0F0C1D",
    gradientColor: "#1E1638",
    textColor: "#F8FAFC",
  },
  {
    label: "Deep Slate",
    backgroundColor: "#090D16",
    gradientColor: "#172033",
    textColor: "#F8FAFC",
  },
  {
    label: "Midnight Emerald",
    backgroundColor: "#081C15",
    gradientColor: "#103528",
    textColor: "#ECFDF5",
  },
  {
    label: "Warm Paper",
    backgroundColor: "#FAF8F5",
    gradientColor: "#EFECE6",
    textColor: "#18181B",
  },
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const GeneratedSlideConfigSchema = z.object({
  template: z.enum(["title", "educational", "section_heading", "closing"]),
  headingText: z
    .string()
    .trim()
    .min(1, "Heading text is required.")
    .max(180, "Heading text must be 180 characters or fewer."),
  bodyText: z
    .string()
    .trim()
    .max(480, "Body text must be 480 characters or fewer.")
    .optional()
    .default(""),
  footerText: z
    .string()
    .trim()
    .max(90, "Footer text must be 90 characters or fewer.")
    .optional()
    .default(""),
  backgroundColor: z.string().trim().regex(HEX_COLOR_RE, "Invalid background hex color."),
  gradientColor: z
    .string()
    .trim()
    .regex(HEX_COLOR_RE, "Invalid gradient hex color.")
    .optional(),
  useGradient: z.boolean().optional().default(true),
  textColor: z.string().trim().regex(HEX_COLOR_RE, "Invalid text hex color."),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
  fontSize: z.number().int().min(28).max(96).default(56),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  language: z.enum(["English", "Hindi", "Bengali"]).default("English"),
});

export interface LanguageFontSupportStatus {
  language: StoryboardLanguage;
  fontFamily: string;
  supported: boolean;
  warning?: string;
}

export function getSlideFontFamily(language: StoryboardLanguage): string {
  if (language === "Hindi") {
    return '"Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Plus Jakarta Sans", sans-serif';
  }
  if (language === "Bengali") {
    return '"Noto Sans Bengali", "Nirmala UI", "Kohinoor Bangla", "Plus Jakarta Sans", sans-serif';
  }
  return '"Plus Jakarta Sans", "DM Sans", system-ui, sans-serif';
}

export function checkLanguageFontSupport(
  language: StoryboardLanguage
): LanguageFontSupportStatus {
  const fontFamily = getSlideFontFamily(language);
  if (language === "English") {
    return { language, fontFamily, supported: true };
  }

  if (typeof document === "undefined") {
    return {
      language,
      fontFamily,
      supported: false,
      warning: `Browser canvas fonts for ${language} can only be verified inside a browser runtime.`,
    };
  }

  try {
    const sampleChar = language === "Hindi" ? "अ" : "অ";
    const missingProbe = "\uFFFF";
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return {
        language,
        fontFamily,
        supported: false,
        warning: `2D canvas context is unavailable to check ${language} glyph support.`,
      };
    }
    ctx.font = `40px ${fontFamily}`;
    const sampleWidth = ctx.measureText(sampleChar).width;
    const missingWidth = ctx.measureText(missingProbe).width;
    const loadedByFaceSet =
      typeof document.fonts !== "undefined" && typeof document.fonts.check === "function"
        ? document.fonts.check(`40px ${fontFamily}`, sampleChar)
        : false;

    const supported = sampleWidth > 0 && (Math.abs(sampleWidth - missingWidth) > 0.5 || loadedByFaceSet);
    if (!supported) {
      return {
        language,
        fontFamily,
        supported: false,
        warning: `${language} webfont has not finished loading yet or no ${language} system font is installed; preview carefully before saving.`,
      };
    }
    return { language, fontFamily, supported: true };
  } catch {
    return {
      language,
      fontFamily,
      supported: false,
      warning: `Could not verify ${language} font metrics in this browser.`,
    };
  }
}

export function wrapCanvasTextLines(
  measureWidth: (text: string) => number,
  text: string,
  maxWidth: number
): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }

    const words = trimmed.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (measureWidth(candidate) <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = "";
        }
        // Handle single very long unbroken word safely
        if (measureWidth(word) <= maxWidth) {
          currentLine = word;
        } else {
          let chunk = "";
          for (const ch of Array.from(word)) {
            if (measureWidth(chunk + ch) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          currentLine = chunk;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [""];
}

export function renderTextSlideToCanvas(
  canvas: HTMLCanvasElement,
  rawConfig: GeneratedSlideConfig
): { width: number; height: number } {
  const config = GeneratedSlideConfigSchema.parse(rawConfig);
  const dims = ASPECT_RATIO_SLIDE_DIMENSIONS[config.aspectRatio];
  canvas.width = dims.width;
  canvas.height = dims.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not acquire 2D canvas context to render text slide.");
  }

  // Background solid or linear gradient fill
  if (config.useGradient && config.gradientColor) {
    const grad = ctx.createLinearGradient(0, 0, dims.width, dims.height);
    grad.addColorStop(0, config.backgroundColor);
    grad.addColorStop(1, config.gradientColor);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = config.backgroundColor;
  }
  ctx.fillRect(0, 0, dims.width, dims.height);

  // Subtle geometric frame accent for visual depth without external assets
  ctx.save();
  ctx.strokeStyle = config.textColor;
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = 2;
  const inset = Math.round(Math.min(dims.width, dims.height) * 0.045);
  ctx.strokeRect(inset, inset, dims.width - inset * 2, dims.height - inset * 2);
  ctx.restore();

  const marginX = Math.round(dims.width * 0.09);
  const contentWidth = dims.width - marginX * 2;
  const anchorX =
    config.textAlign === "left"
      ? marginX
      : config.textAlign === "right"
        ? dims.width - marginX
        : Math.round(dims.width / 2);

  const fontFamily = getSlideFontFamily(config.language);
  const scaleFactor = dims.width < 900 ? 0.84 : 1;
  const headingSize = Math.round(config.fontSize * scaleFactor);
  const bodySize = Math.max(20, Math.round(headingSize * 0.52));
  const footerSize = Math.max(16, Math.round(headingSize * 0.34));

  ctx.textAlign = config.textAlign;
  ctx.textBaseline = "top";
  ctx.fillStyle = config.textColor;

  ctx.font = `700 ${headingSize}px ${fontFamily}`;
  const headingLines = wrapCanvasTextLines(
    (s) => ctx.measureText(s).width,
    config.headingText,
    contentWidth
  );
  const headingLineHeight = Math.round(headingSize * 1.24);

  let bodyLines: string[] = [];
  const bodyLineHeight = Math.round(bodySize * 1.42);
  if (config.bodyText?.trim()) {
    ctx.font = `400 ${bodySize}px ${fontFamily}`;
    bodyLines = wrapCanvasTextLines(
      (s) => ctx.measureText(s).width,
      config.bodyText.trim(),
      contentWidth
    );
  }

  const gapAfterHeading = bodyLines.length > 0 ? Math.round(headingSize * 0.48) : 0;
  const totalBlockHeight =
    headingLines.length * headingLineHeight +
    gapAfterHeading +
    bodyLines.length * bodyLineHeight;

  let cursorY = Math.max(
    Math.round(dims.height * 0.12),
    Math.round((dims.height - totalBlockHeight) / 2)
  );

  // Template top label accent for section heading or educational slides
  if (config.template === "section_heading" || config.template === "educational") {
    ctx.save();
    ctx.fillStyle = config.textColor;
    ctx.globalAlpha = 0.65;
    ctx.font = `600 ${Math.max(16, Math.round(footerSize * 0.95))}px ${fontFamily}`;
    const label = config.template === "section_heading" ? "SECTION" : "KEY TAKEAWAY";
    ctx.fillText(label, anchorX, Math.max(inset + 24, cursorY - Math.round(headingSize * 0.8)));
    ctx.restore();
  }

  ctx.font = `700 ${headingSize}px ${fontFamily}`;
  ctx.fillStyle = config.textColor;
  for (const line of headingLines) {
    if (cursorY + headingLineHeight > dims.height - inset * 2) break;
    ctx.fillText(line, anchorX, cursorY);
    cursorY += headingLineHeight;
  }

  if (bodyLines.length > 0) {
    cursorY += gapAfterHeading;
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.font = `400 ${bodySize}px ${fontFamily}`;
    for (const line of bodyLines) {
      if (cursorY + bodyLineHeight > dims.height - inset * 2.4) break;
      ctx.fillText(line, anchorX, cursorY);
      cursorY += bodyLineHeight;
    }
    ctx.restore();
  }

  if (config.footerText?.trim()) {
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.font = `500 ${footerSize}px ${fontFamily}`;
    ctx.fillText(config.footerText.trim(), anchorX, dims.height - inset - footerSize - 20);
    ctx.restore();
  }

  return dims;
}

export async function generateSlideImageFile(
  rawConfig: GeneratedSlideConfig,
  filenameHint?: string
): Promise<{ file: File; config: GeneratedSlideConfig; width: number; height: number }> {
  const config = GeneratedSlideConfigSchema.parse(rawConfig);
  if (typeof document === "undefined") {
    throw new Error("Local text slide rendering requires a browser canvas environment.");
  }

  const canvas = document.createElement("canvas");
  const dims = renderTextSlideToCanvas(canvas, config);

  const blob = await new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new Error("Canvas image export (toBlob) is not supported in this browser."));
      return;
    }
    canvas.toBlob(
      (result) => {
        if (result && result.size > 0) {
          resolve(result);
        } else {
          reject(new Error("Rendered slide canvas produced an empty PNG."));
        }
      },
      "image/png",
      0.95
    );
  });

  const slug = (filenameHint || config.headingText || config.template)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  const filename = `slide_${config.template}_${slug || Date.now()}.png`;
  const file = new File([blob], filename, { type: "image/png" });

  return {
    file,
    config,
    width: dims.width,
    height: dims.height,
  };
}

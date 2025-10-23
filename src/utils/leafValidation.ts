// Lightweight client-side heuristics to reject obvious non-leaf images.
// Mirrors backend/backend/leaf_validator.py thresholds, but implemented for browser Canvas.

export type LeafValidationResult = {
  valid: boolean;
  reason?: string;
};

// Allowed plant categories in Bahasa Indonesia
export const ALLOWED_PLANTS = [
  "Anggur",
  "Apel",
  "Jagung",
  "Kentang",
  "Tomat",
  "Buncis",
  "Cabai",
  "Durian",
  "Pisang",
  "Selada",
] as const;

export type AllowedPlant = (typeof ALLOWED_PLANTS)[number];

// Parse plant/species token from a model label, e.g. "Daun_Apel_Busuk" -> "Apel"
export function parsePlantFromLabel(label: string): string | null {
  const raw = String(label || "");
  if (!raw) return null;
  const parts = raw.split(/[_\s]+/).filter(Boolean);
  // Common pattern: Daun_<Plant>_...
  if (parts.length >= 2 && /^daun$/i.test(parts[0])) {
    return parts[1];
  }
  // Fallback: find any allowed plant name inside label (case-insensitive)
  const lower = raw.toLowerCase();
  for (const p of ALLOWED_PLANTS) {
    if (lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

// Optional synonyms to support Spaces that return English labels
const PLANT_SYNONYMS: Record<string, string[]> = {
  Anggur: ["grape", "grapes"],
  Apel: ["apple", "apples"],
  Jagung: ["corn", "maize"],
  Kentang: ["potato", "potatoes"],
  Tomat: ["tomato", "tomatoes"],
  Buncis: ["bean", "beans", "kidney bean", "green bean", "soybean"],
  Cabai: ["chili", "chilli", "pepper", "chile"],
  Durian: ["durian", "durio"],
  Pisang: ["banana", "bananas", "plantain"],
  Selada: ["lettuce"],
};

export function isAllowedPlantLabel(label: string): boolean {
  const plant = parsePlantFromLabel(label);
  const lowerLabel = String(label || "").toLowerCase();
  if (plant) {
    if (ALLOWED_PLANTS.map((p) => p.toLowerCase()).includes(plant.toLowerCase())) return true;
  }
  // Check English synonyms inside label
  for (const [id, synonyms] of Object.entries(PLANT_SYNONYMS)) {
    if (synonyms.some((s) => lowerLabel.includes(s))) return true;
    if (lowerLabel.includes(id.toLowerCase())) return true; // Indonesian name directly
  }
  return false;
}

// Canvas helpers
async function readImageData(file: File): Promise<ImageData> {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Gagal memuat gambar."));
      el.src = blobUrl;
    });

    const maxDim = 256; // downscale for speed
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const targetW = Math.max(1, Math.round(img.width * scale));
    const targetH = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas tidak tersedia.");
    ctx.drawImage(img, 0, 0, targetW, targetH);
    return ctx.getImageData(0, 0, targetW, targetH);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function validateLeafImage(file: File): Promise<LeafValidationResult> {
  try {
    const { data, width, height } = await readImageData(file);
    const area = width * height;

    // Base guards
    const MIN_AREA = 8_000; // pixels (slightly more permissive)
    const MAX_ASPECT = 7; // w/h or h/w
    if (area < MIN_AREA) {
      return { valid: false, reason: "Gambar terlalu kecil untuk dianalisis." };
    }
    const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (aspect > MAX_ASPECT) {
      return { valid: false, reason: "Rasio gambar terlalu ekstrem (tidak wajar)." };
    }

    // Precompute grayscale, HSV, palette bins
    const pixels = area;
    const gray = new Float32Array(pixels);
    const greenMask = new Uint8Array(pixels); // 1 for greenish/yellowish
    const hueValues: number[] = []; // store only for masked pixels
    let greenCount = 0;

    // Palette quantization (and counts): 4 bits per channel (0..15)
    const paletteCounts = new Map<number, number>();

    let rSum = 0, gSum = 0, bSum = 0;
    let rSq = 0, gSq = 0, bSq = 0;

    const toHSV = (r: number, g: number, b: number) => {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const d = max - min;
      let h = 0;
      if (d !== 0) {
        switch (max) {
          case rn:
            h = (gn - bn) / d + (gn < bn ? 6 : 0);
            break;
          case gn:
            h = (bn - rn) / d + 2;
            break;
          default:
            h = (rn - gn) / d + 4;
        }
        h /= 6; // 0..1
      }
      const s = max === 0 ? 0 : d / max;
      const v = max;
      return { h, s, v };
    };

    for (let p = 0, idx = 0; p < data.length; p += 4, idx++) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];

      // grayscale (BT.601)
      const gr = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[idx] = gr;

      // palette bin
      const pr = (r >> 4) & 0xf;
      const pg = (g >> 4) & 0xf;
      const pb = (b >> 4) & 0xf;
      const code = (pr << 8) | (pg << 4) | pb;
      paletteCounts.set(code, (paletteCounts.get(code) ?? 0) + 1);

      // stats for uniformity
      rSum += r; gSum += g; bSum += b;
      rSq += r * r; gSq += g * g; bSq += b * b;

      // greenish/yellowish mask in HSV
      const { h, s, v } = toHSV(r, g, b); // h in [0,1]
      const deg = h * 360; // 0..360
      const isGreenish = (deg >= 45 && deg <= 160) && s >= 0.18 && v >= 0.12; // include yellow-green
      if (isGreenish) {
        greenMask[idx] = 1;
        greenCount++;
        hueValues.push(h);
      }
    }

    const greenRatio = greenCount / pixels;

    // Connected-component on green mask (largest green object share)
    let largestComp = 0;
    if (greenCount > 0) {
      const visited = new Uint8Array(pixels);
      const stackX = new Int32Array(pixels);
      const stackY = new Int32Array(pixels);
      let sp = 0;
      const push = (x: number, y: number) => { stackX[sp] = x; stackY[sp] = y; sp++; };
      const pop = () => { sp--; return [stackX[sp], stackY[sp]] as const; };

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (!greenMask[i] || visited[i]) continue;
          // flood fill
          let areaComp = 0;
          push(x, y);
          visited[i] = 1;
          while (sp > 0) {
            const [cx, cy] = pop();
            areaComp++;
            // neighbors 4-connected
            const neighbors = (
              cx > 0 && [[cx - 1, cy]] || []
            ).concat(
              cx + 1 < width ? [[cx + 1, cy]] : []
            ).concat(
              cy > 0 ? [[cx, cy - 1]] : []
            ).concat(
              cy + 1 < height ? [[cx, cy + 1]] : []
            );
            for (const n of neighbors) {
              const nx = n[0], ny = n[1];
              const j = ny * width + nx;
              if (!visited[j] && greenMask[j]) {
                visited[j] = 1;
                push(nx, ny);
              }
            }
          }
          if (areaComp > largestComp) largestComp = areaComp;
        }
      }
    }
    const largestCompRatio = largestComp / pixels;

    // Standard deviation per channel to reject very flat images
    const rMean = rSum / pixels;
    const gMean = gSum / pixels;
    const bMean = bSum / pixels;
    const rStd = Math.sqrt(Math.max(0, rSq / pixels - rMean * rMean));
    const gStd = Math.sqrt(Math.max(0, gSq / pixels - gMean * gMean));
    const bStd = Math.sqrt(Math.max(0, bSq / pixels - bMean * bMean));
    const isVeryUniform = rStd < 6 && gStd < 6 && bStd < 6;

    // Color palette size heuristic: natural photos have many color bins
    const uniqueBins = paletteCounts.size; // 0..4096
    const minBins = Math.max(32, Math.floor(pixels / 3000));
    const paletteTooSmall = uniqueBins < minBins;

    // Concentration of top palette bins to detect icons
    let topShare = 0;
    if (paletteCounts.size > 0) {
      const top = [...paletteCounts.values()].sort((a, b) => b - a).slice(0, 5);
      const sumTop = top.reduce((a, v) => a + v, 0);
      topShare = sumTop / pixels; // 0..1
    }

    // Hue variation within green areas (reject single-tone flats)
    let hueStdTooLow: boolean | undefined;
    if (hueValues.length > 0) {
      const m = hueValues.reduce((a, v) => a + v, 0) / hueValues.length;
      const vSum = hueValues.reduce((a, v) => a + (v - m) * (v - m), 0) / hueValues.length;
      const hueStd = Math.sqrt(vSum); // 0..1
      hueStdTooLow = hueStd < 0.02;
    }

    // Texture check: interior edge density within green region
    let edgeGreen = 0;
    let interiorGreen = 0;
    const EDGE_THR = 10; // grayscale difference
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!greenMask[i]) continue;
        interiorGreen++;
        const gx = Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i] - gray[i - 1]);
        const gy = Math.abs(gray[i + width] - gray[i]) + Math.abs(gray[i] - gray[i - width]);
        const gmag = gx + gy;
        if (gmag > EDGE_THR) edgeGreen++;
      }
    }
    let edgeDensity = 0;
    if (interiorGreen > 0) edgeDensity = edgeGreen / interiorGreen;

    // Mandatory guards: require substantial green object (helps block non-leaf)
    if (greenRatio < 0.18) {
      return { valid: false, reason: "Area daun terlalu kecil/Objek bukan daun." };
    }
    if (largestCompRatio < 0.12) {
      return { valid: false, reason: "Objek daun terlalu kecil/tersebar (bukan satu daun utama)." };
    }
    if (greenRatio > 0.995) {
      return { valid: false, reason: "Gambar terlalu dominan satu warna (kemungkinan latar/ilustrasi)." };
    }

    // Now combine as soft rules — accept if most signals indicate a real leaf
    let score = 0;
    // 1) Green coverage reasonable
    score += 1; // already guaranteed by mandatory guard
    // 2) Not extremely uniform color OR palette is sufficiently rich
    if (!isVeryUniform || !paletteTooSmall) score += 1;
    // 3) Within a wide but sane edge range (some texture but not line-art)
    if (edgeDensity === 0 || (edgeDensity >= 0.015 && edgeDensity <= 0.60)) score += 1;
    // 4) Hue variation (if measured) not too tiny
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (typeof hueStdTooLow === "undefined" || !hueStdTooLow) score += 1;
    // 5) Palette not dominated by very few colors (icons)
    if (topShare <= 0.70) score += 1;

    if (score >= 3) {
      return { valid: true };
    }

    // Provide the most likely reason
    if (largestCompRatio < 0.12) return { valid: false, reason: "Objek daun terlalu kecil/tersebar." };
    if (isVeryUniform) return { valid: false, reason: "Gambar terlalu seragam seperti ilustrasi/solid color." };
    if (paletteTooSmall || topShare > 0.70) return { valid: false, reason: "Palet warna sangat terbatas seperti ikon/ilustrasi." };
    if (edgeDensity > 0.60) return { valid: false, reason: "Terlalu banyak garis tegas seperti ikon/teks." };
    if (edgeDensity < 0.01) return { valid: false, reason: "Tekstur daun tidak terdeteksi (terlalu datar)." };

    return { valid: false, reason: "Gambar tidak menunjukkan ciri daun tanaman yang jelas." };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gagal memvalidasi gambar.";
    return { valid: false, reason: message };
  }
}

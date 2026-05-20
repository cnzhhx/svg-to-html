import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { overlapArea } from "./geometry.js";
import { readRegions, toAbsolutePath, writeJsonFile } from "./utils.js";

const execFileAsync = promisify(execFile);

const commandExists = (command: string) => {
  const pathValue = process.env["PATH"] ?? "";
  const pathExts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  const names = pathExts.map(
    (ext) =>
      `${command}${ext.toLowerCase() === path.extname(command).toLowerCase() ? "" : ext}`,
  );

  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => names.some((name) => existsSync(path.join(dir, name))));
};

const getOcrProvider = () => {
  const provider = process.env["OCR_PROVIDER"];
  if (provider === "tesseract") return "tesseract";
  if (provider === "swift-vision") return "swift-vision";
  return process.platform === "darwin" ? "swift-vision" : "tesseract";
};

const detectOcrSupport = () => {
  const provider = getOcrProvider();

  if (provider === "swift-vision") {
    return {
      available:
        existsSync("/usr/bin/swift") ||
        existsSync("/usr/local/swift/usr/bin/swift"),
      provider,
    };
  }

  return {
    available:
      existsSync("/usr/bin/tesseract") ||
      existsSync("/usr/local/bin/tesseract") ||
      commandExists("tesseract"),
    provider,
  };
};

type OcrResult = {
  fullText: string;
  imagePath: string;
  observations: Array<{
    lines: Array<{
      boundingBox: {
        height: number;
        width: number;
        x: number;
        y: number;
      };
      confidence: number;
      text: string;
    }>;
    candidates: Array<{ confidence: number; text: string }>;
    id: string;
    region?: {
      height: number;
      id?: string;
      width: number;
      x: number;
      y: number;
    };
    text: string;
  }>;
};

type TesseractWordRow = {
  conf: number;
  height: number;
  left: number;
  level: number;
  line_num: number;
  page_num: number;
  par_num: number;
  block_num: number;
  text: string;
  top: number;
  width: number;
  word_num: number;
};

const parseTesseractTsv = (raw: string) => {
  const [headerLine = "", ...rows] = raw.trim().split(/\r?\n/);
  const headers = headerLine.split("\t");
  const valuesByRow = rows
    .map((line) => line.split("\t"))
    .filter((columns) => columns.length === headers.length);

  return valuesByRow
    .map((columns) =>
      Object.fromEntries(
        headers.map((header, index) => [header, columns[index] ?? ""]),
      ),
    )
    .map(
      (row) =>
        ({
          block_num: Number(row["block_num"] ?? 0),
          conf: Number(row["conf"] ?? -1),
          height: Number(row["height"] ?? 0),
          left: Number(row["left"] ?? 0),
          level: Number(row["level"] ?? 0),
          line_num: Number(row["line_num"] ?? 0),
          page_num: Number(row["page_num"] ?? 0),
          par_num: Number(row["par_num"] ?? 0),
          text: String(row["text"] ?? ""),
          top: Number(row["top"] ?? 0),
          width: Number(row["width"] ?? 0),
          word_num: Number(row["word_num"] ?? 0),
        }) satisfies TesseractWordRow,
    )
    .filter(
      (row) =>
        row.level === 5 && row.width > 0 && row.height > 0 && row.text.trim(),
    );
};

const toBoundingBox = (word: TesseractWordRow) => ({
  height: word.height,
  width: word.width,
  x: word.left,
  y: word.top,
});

const buildTesseractResult = ({
  imagePath,
  regions,
  tsv,
}: {
  imagePath: string;
  regions: Awaited<ReturnType<typeof readRegions>>;
  tsv: string;
}): OcrResult => {
  const words = parseTesseractTsv(tsv);
  const lineGroups = new Map<
    string,
    {
      boxes: Array<{ height: number; width: number; x: number; y: number }>;
      confidenceSum: number;
      textParts: string[];
      wordCount: number;
    }
  >();

  words.forEach((word) => {
    const key = [
      word.page_num,
      word.block_num,
      word.par_num,
      word.line_num,
    ].join(":");
    const entry = lineGroups.get(key) ?? {
      boxes: [],
      confidenceSum: 0,
      textParts: [],
      wordCount: 0,
    };
    entry.boxes.push(toBoundingBox(word));
    entry.confidenceSum += Math.max(0, word.conf);
    entry.textParts.push(word.text.trim());
    entry.wordCount += 1;
    lineGroups.set(key, entry);
  });

  const lines = [...lineGroups.entries()]
    .map(([id, entry]) => {
      const minX = Math.min(...entry.boxes.map((box) => box.x));
      const minY = Math.min(...entry.boxes.map((box) => box.y));
      const maxX = Math.max(...entry.boxes.map((box) => box.x + box.width));
      const maxY = Math.max(...entry.boxes.map((box) => box.y + box.height));

      return {
        boundingBox: {
          height: maxY - minY,
          width: maxX - minX,
          x: minX,
          y: minY,
        },
        confidence: Number(
          (entry.confidenceSum / Math.max(1, entry.wordCount) / 100).toFixed(4),
        ),
        id,
        text: entry.textParts.join(" ").trim(),
      };
    })
    .sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y ||
        left.boundingBox.x - right.boundingBox.x,
    );

  const observations =
    regions.length > 0
      ? regions.map((region, index) => {
          const regionLines = lines.filter((line) => {
            const overlap = overlapArea(region, line.boundingBox);
            return overlap > 0;
          });
          const text = regionLines
            .map((line) => line.text)
            .join(" ")
            .trim();
          return {
            candidates: text ? [{ confidence: 0.6, text }] : [],
            id: region.id ?? `region-${index + 1}`,
            lines: regionLines.map((line) => ({
              boundingBox: line.boundingBox,
              confidence: line.confidence,
              text: line.text,
            })),
            region,
            text,
          };
        })
      : [
          {
            candidates: lines.length
              ? [
                  {
                    confidence: 0.6,
                    text: lines
                      .map((line) => line.text)
                      .join(" ")
                      .trim(),
                  },
                ]
              : [],
            id: "full-image",
            lines: lines.map((line) => ({
              boundingBox: line.boundingBox,
              confidence: line.confidence,
              text: line.text,
            })),
            text: lines
              .map((line) => line.text)
              .join(" ")
              .trim(),
          },
        ];

  return {
    fullText: lines
      .map((line) => line.text)
      .join("\n")
      .trim(),
    imagePath,
    observations,
  };
};

const runSwiftOcr = async ({
  imagePath,
  outputPath,
  regions,
}: {
  imagePath: string;
  outputPath: string;
  regions: Awaited<ReturnType<typeof readRegions>>;
}) => {
  const scriptPath = new URL("ocr.swift", import.meta.url).pathname;
  const inputPayloadPath = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.input.json`,
  );

  await writeJsonFile(inputPayloadPath, {
    imagePath,
    languages: ["zh-Hans", "en-US"],
    recognitionLevel: "accurate",
    regions,
  });

  await execFileAsync("swift", [scriptPath, inputPayloadPath, outputPath]);
  return outputPath;
};

const runTesseractOcr = async ({
  imagePath,
  outputPath,
  regions,
}: {
  imagePath: string;
  outputPath: string;
  regions: Awaited<ReturnType<typeof readRegions>>;
}) => {
  const { stdout } = await execFileAsync("tesseract", [
    imagePath,
    "stdout",
    "-l",
    "chi_sim+eng",
    "--psm",
    "6",
    "tsv",
  ]);

  const result = buildTesseractResult({
    imagePath,
    regions,
    tsv: stdout,
  });
  await writeJsonFile(outputPath, result);
  return outputPath;
};

const runOcr = async ({
  imagePath,
  outputPath,
  regionsPath,
}: {
  imagePath: string;
  outputPath: string;
  regionsPath?: string;
}) => {
  const resolvedImagePath = toAbsolutePath(imagePath);
  const regions = await readRegions(regionsPath);
  const provider = getOcrProvider();

  if (provider === "tesseract") {
    return runTesseractOcr({
      imagePath: resolvedImagePath,
      outputPath,
      regions,
    });
  }

  return runSwiftOcr({
    imagePath: resolvedImagePath,
    outputPath,
    regions,
  });
};

export type { OcrResult };
export { detectOcrSupport, getOcrProvider, runOcr };

import AppKit
import Foundation
import ImageIO
import Vision

struct Region: Codable {
  let height: Int
  let id: String?
  let width: Int
  let x: Int
  let y: Int
}

struct OcrInput: Codable {
  let imagePath: String
  let languages: [String]?
  let recognitionLevel: String?
  let regions: [Region]?
}

struct Candidate: Codable {
  let confidence: Float
  let text: String
}

struct BoundingBox: Codable {
  let height: Int
  let width: Int
  let x: Int
  let y: Int
}

struct OcrLine: Codable {
  let boundingBox: BoundingBox
  let confidence: Float
  let text: String
}

struct OcrObservation: Codable {
  let candidates: [Candidate]
  let id: String
  let lines: [OcrLine]
  let region: Region?
  let text: String
}

struct OcrOutput: Codable {
  let fullText: String
  let imagePath: String
  let observations: [OcrObservation]
}

let arguments = CommandLine.arguments

guard arguments.count >= 3 else {
  throw NSError(domain: "ocr.swift", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: swift ocr.swift <input-json> <output-json>"])
}

let inputPath = arguments[1]
let outputPath = arguments[2]

let inputUrl = URL(fileURLWithPath: inputPath)
let outputUrl = URL(fileURLWithPath: outputPath)
let inputData = try Data(contentsOf: inputUrl)
let decoder = JSONDecoder()
let input = try decoder.decode(OcrInput.self, from: inputData)

let imageUrl = URL(fileURLWithPath: input.imagePath)
guard let imageSource = CGImageSourceCreateWithURL(imageUrl as CFURL, nil),
      let sourceImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
  throw NSError(domain: "ocr.swift", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to read image: \(input.imagePath)"])
}

let recognitionLanguages = input.languages ?? ["zh-Hans", "en-US"]
let useAccurate = (input.recognitionLevel ?? "accurate") == "accurate"
let targetRegions = (input.regions?.isEmpty == false)
  ? input.regions!
  : [Region(height: sourceImage.height, id: "full-image", width: sourceImage.width, x: 0, y: 0)]

func toBoundingBox(observation: VNRecognizedTextObservation, cropRect: CGRect) -> BoundingBox {
  let normalized = observation.boundingBox
  let x = cropRect.origin.x + normalized.origin.x * cropRect.width
  let y = cropRect.origin.y + (1 - normalized.origin.y - normalized.height) * cropRect.height
  let width = normalized.width * cropRect.width
  let height = normalized.height * cropRect.height

  return BoundingBox(
    height: Int(height.rounded()),
    width: Int(width.rounded()),
    x: Int(x.rounded()),
    y: Int(y.rounded())
  )
}

let observations: [OcrObservation] = try targetRegions.map { region in
  let cropRect = CGRect(
    x: max(0, region.x),
    y: max(0, region.y),
    width: max(1, min(region.width, sourceImage.width - region.x)),
    height: max(1, min(region.height, sourceImage.height - region.y))
  )

  guard let croppedImage = sourceImage.cropping(to: cropRect) else {
    throw NSError(domain: "ocr.swift", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unable to crop image for region \(region.id ?? "unknown")"])
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLanguages = recognitionLanguages
  request.recognitionLevel = useAccurate ? .accurate : .fast
  request.usesLanguageCorrection = true

  let handler = VNImageRequestHandler(cgImage: croppedImage, options: [:])
  try handler.perform([request])

  let recognitionResults = request.results ?? []

  let topCandidates = recognitionResults.compactMap { observation in
    observation.topCandidates(3).map { candidate in
      Candidate(confidence: candidate.confidence, text: candidate.string)
    }
  }

  let lines = recognitionResults.compactMap { observation -> OcrLine? in
    guard let bestCandidate = observation.topCandidates(1).first else { return nil }
    return OcrLine(
      boundingBox: toBoundingBox(observation: observation, cropRect: cropRect),
      confidence: bestCandidate.confidence,
      text: bestCandidate.string
    )
  }
  .sorted {
    if $0.boundingBox.y != $1.boundingBox.y {
      return $0.boundingBox.y < $1.boundingBox.y
    }
    return $0.boundingBox.x < $1.boundingBox.x
  }

  let flattenedCandidates = topCandidates.flatMap { $0 }
  let text = topCandidates.compactMap { $0.first?.text }.joined(separator: "\n")

  return OcrObservation(
    candidates: flattenedCandidates,
    id: region.id ?? "region",
    lines: lines,
    region: region,
    text: text
  )
}

let output = OcrOutput(
  fullText: observations.map(\.text).joined(separator: "\n\n"),
  imagePath: input.imagePath,
  observations: observations
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let outputData = try encoder.encode(output)
try outputData.write(to: outputUrl)

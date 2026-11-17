import Foundation
import AppKit
import Vision
import PDFKit
import ImageIO
import UniformTypeIdentifiers
import NaturalLanguage

struct OCRFailure: Error { let code: String }

func fail(_ code: String) throws -> Never { throw OCRFailure(code: code) }

func normalizedImage(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int else { try fail("invalid_image") }
    guard width > 0, height > 0, width <= 20000, height <= 20000 else { try fail("too_large") }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                   kCGImageSourceCreateThumbnailWithTransform: true,
                                   kCGImageSourceThumbnailMaxPixelSize: 2400]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { try fail("invalid_image") }
    return image
}

func writePNG(_ image: CGImage, _ url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { try fail("preview_failed") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { try fail("preview_failed") }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}

func recognize(_ image: CGImage, page: Int, directory: URL) throws -> [String: Any] {
    try writePNG(image, directory.appendingPathComponent("page-\(page).png"))
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.automaticallyDetectsLanguage = true
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) }
    catch { try fail("recognition_failed") }
    let observations = (request.results ?? []).sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) < min($0.boundingBox.height, $1.boundingBox.height) * 0.45 {
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        return $0.boundingBox.midY > $1.boundingBox.midY
    }
    var blocks: [[String: Any]] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let rect = observation.boundingBox
        let x = max(0, min(1, rect.minX))
        let y = max(0, min(1, 1 - rect.maxY))
        let width = min(1 - x, rect.width)
        let height = min(1 - y, rect.height)
        if width <= 0 || height <= 0 { continue }
        blocks.append(["id": "p\(page)-b\(blocks.count + 1)", "source": text,
                       "confidence": candidate.confidence,
                       "bbox": ["x": x, "y": y, "width": width, "height": height]])
    }
    return ["page": page, "width": image.width, "height": image.height, "blocks": blocks]
}

func run() throws -> [String: Any] {
    guard CommandLine.arguments.count == 3 else { try fail("invalid_image") }
    let source = URL(fileURLWithPath: CommandLine.arguments[1])
    let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    var pages: [[String: Any]] = []
    if source.pathExtension.lowercased() == "pdf" {
        guard let document = PDFDocument(url: source), !document.isLocked, document.pageCount > 0 else { try fail("invalid_pdf") }
        guard document.pageCount <= 10 else { try fail("too_many_pages") }
        for index in 0..<document.pageCount {
            let result: [String: Any] = try autoreleasepool {
                guard let page = document.page(at: index) else { try fail("invalid_page") }
                let bounds = page.bounds(for: .mediaBox)
                guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else { try fail("invalid_page") }
                let scale = min(2400 / max(bounds.width, bounds.height), 3)
                let size = NSSize(width: max(1, (bounds.width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
                let thumbnail = page.thumbnail(of: size, for: .mediaBox)
                guard let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) else { try fail("invalid_page") }
                return try recognize(image, page: index + 1, directory: directory)
            }
            pages.append(result)
        }
    } else {
        pages.append(try recognize(normalizedImage(source), page: 1, directory: directory))
    }
    let text = pages.flatMap { $0["blocks"] as? [[String: Any]] ?? [] }.compactMap { $0["source"] as? String }.joined(separator: "\n")
    let detector = NLLanguageRecognizer()
    detector.processString(text)
    let hypotheses = detector.languageHypotheses(withMaximum: 1)
    let language = hypotheses.first.flatMap { $0.value >= 0.8 ? $0.key.rawValue : nil } ?? "und"
    return ["pages": pages, "sourceLanguage": language]
}

do {
    let data = try JSONSerialization.data(withJSONObject: run(), options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    let code = (error as? OCRFailure)?.code ?? "recognition_failed"
    let data = try! JSONSerialization.data(withJSONObject: ["error": code])
    FileHandle.standardOutput.write(data)
    exit(1)
}

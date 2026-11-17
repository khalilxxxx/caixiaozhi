// Synthetic receipts only. These fixtures never represent real financial records.
import Foundation
import AppKit
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

func drawReceipt(width: CGFloat, height: CGFloat, page: Int = 1) {
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    let lines = ["SAMPLE - TEST RECEIPT", "Hotel Orchard", "Invoice INV-2026-00\(page)", "Date 2026-11-17", "Room 2 nights", "Tax USD 8.00", "Total USD 128.00", "Thank you for your stay"]
    for (index, line) in lines.enumerated() {
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: width * 0.036), .foregroundColor: NSColor.black]
        (line as NSString).draw(at: NSPoint(x: width * 0.08, y: height * 0.88 - CGFloat(index) * height * 0.095), withAttributes: attributes)
    }
}

let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: 1400, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
drawReceipt(width: 1000, height: 1400)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("sample-hotel.png"))
let jpeg = CGImageDestinationCreateWithURL(directory.appendingPathComponent("sample-oriented.jpg") as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(jpeg, bitmap.cgImage!, [kCGImagePropertyOrientation: 6] as CFDictionary)
CGImageDestinationFinalize(jpeg)

for count in [2, 11] {
    var box = CGRect(x: 0, y: 0, width: 600, height: 840)
    let context = CGContext(directory.appendingPathComponent("sample-hotel-\(count)-pages.pdf") as CFURL, mediaBox: &box, nil)!
    for page in 1...count {
        context.beginPDFPage(nil)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        drawReceipt(width: 600, height: 840, page: page)
        NSGraphicsContext.restoreGraphicsState()
        context.endPDFPage()
    }
    context.closePDF()
}

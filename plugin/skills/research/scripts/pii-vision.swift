// macOS Vision으로 이미지 속 글자와 얼굴, 바코드 위치를 찾고(ocr), 지정한 칸을 가짜 값으로 덮어 그린다(paint).
// 무엇이 개인정보인지는 판정하지 않는다. 그건 ges_research가 한다. 이 파일은 읽기와 그리기만 한다.
//
//   swift pii-vision.swift ocr   <이미지>                 → JSON을 stdout으로
//   swift pii-vision.swift paint <이미지> <계획.json> <출력> → 출력 확장자가 jpg면 품질 0.8, 아니면 png
import AppKit
import CoreImage
import Foundation
import Vision

struct Box: Codable {
  var x: Double
  var y: Double
  var w: Double
  var h: Double
}

struct Token: Codable {
  var start: Int
  var end: Int
  var box: Box
}

struct Line: Codable {
  var text: String
  var box: Box
  var confidence: Double
  var tokens: [Token]
}

struct BarcodeHit: Codable {
  var payload: String?
  var symbology: String
  var box: Box
}

struct OcrResult: Codable {
  var width: Int
  var height: Int
  var languages: [String]
  var lines: [Line]
  var faces: [Box]
  var barcodes: [BarcodeHit]
}

struct PaintItem: Codable {
  var type: String  // text, avatar, barcode
  var box: Box
  var text: String?
}

struct PaintPlan: Codable {
  var items: [PaintItem]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func loadCGImage(_ path: String) -> CGImage {
  guard let image = NSImage(contentsOfFile: path) else { fail("이미지를 못 열었다: \(path)") }
  var rect = CGRect(origin: .zero, size: image.size)
  guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fail("이미지를 디코드하지 못했다: \(path)")
  }
  return cg
}

// Vision 좌표는 0~1, 원점이 왼쪽 아래다. 픽셀과 왼쪽 위 원점으로 바꾼다
func toBox(_ normalized: CGRect, _ width: Int, _ height: Int) -> Box {
  Box(
    x: normalized.minX * Double(width),
    y: (1 - normalized.maxY) * Double(height),
    w: normalized.width * Double(width),
    h: normalized.height * Double(height))
}

func runOcr(_ path: String) {
  let cg = loadCGImage(path)
  let width = cg.width
  let height = cg.height

  let text = VNRecognizeTextRequest()
  text.recognitionLevel = .accurate
  text.usesLanguageCorrection = false
  let supported = (try? text.supportedRecognitionLanguages()) ?? []
  let wanted = ["ko-KR", "en-US"].filter { supported.contains($0) }
  if !wanted.isEmpty { text.recognitionLanguages = wanted }

  let faces = VNDetectFaceRectanglesRequest()
  let barcodes = VNDetectBarcodesRequest()

  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do {
    try handler.perform([text, faces, barcodes])
  } catch {
    fail("Vision 요청이 실패했다: \(error)")
  }

  var lines: [Line] = []
  for observation in text.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let string = candidate.string
    let ns = string as NSString
    var tokens: [Token] = []
    let regex = try! NSRegularExpression(pattern: "\\S+")
    for match in regex.matches(in: string, range: NSRange(location: 0, length: ns.length)) {
      guard let range = Range(match.range, in: string),
        let rect = try? candidate.boundingBox(for: range)
      else { continue }
      tokens.append(
        Token(
          start: match.range.location, end: match.range.location + match.range.length,
          box: toBox(rect.boundingBox, width, height)))
    }
    lines.append(
      Line(
        text: string, box: toBox(observation.boundingBox, width, height),
        confidence: Double(candidate.confidence), tokens: tokens))
  }

  let result = OcrResult(
    width: width, height: height, languages: wanted,
    lines: lines,
    faces: (faces.results ?? []).map { toBox($0.boundingBox, width, height) },
    barcodes: (barcodes.results ?? []).map {
      BarcodeHit(
        payload: $0.payloadStringValue, symbology: $0.symbology.rawValue,
        box: toBox($0.boundingBox, width, height))
    })
  let data = try! JSONEncoder().encode(result)
  FileHandle.standardOutput.write(data)
}

struct Rgb {
  var r: Double
  var g: Double
  var b: Double
  var luminance: Double { 0.299 * r + 0.587 * g + 0.114 * b }
  func distance(_ o: Rgb) -> Double { abs(r - o.r) + abs(g - o.g) + abs(b - o.b) }
}

// 칸 바로 바깥 둘레의 중앙값을 배경색으로 본다. 글자가 칸에 꽉 차 있어도 안쪽을 안 읽으니 글자색이 안 섞인다
func backgroundColor(_ pixels: UnsafePointer<UInt8>, _ rowBytes: Int, _ w: Int, _ h: Int, _ box: Box)
  -> Rgb
{
  func at(_ x: Int, _ y: Int) -> Rgb? {
    if x < 0 || y < 0 || x >= w || y >= h { return nil }
    let p = pixels + y * rowBytes + x * 4
    return Rgb(r: Double(p[0]), g: Double(p[1]), b: Double(p[2]))
  }
  let x0 = Int(box.x.rounded(.down)) - 2
  let y0 = Int(box.y.rounded(.down)) - 2
  let x1 = Int((box.x + box.w).rounded(.up)) + 2
  let y1 = Int((box.y + box.h).rounded(.up)) + 2
  var samples: [Rgb] = []
  for x in stride(from: x0, through: x1, by: 2) {
    if let c = at(x, y0) { samples.append(c) }
    if let c = at(x, y1) { samples.append(c) }
  }
  for y in stride(from: y0, through: y1, by: 2) {
    if let c = at(x0, y) { samples.append(c) }
    if let c = at(x1, y) { samples.append(c) }
  }
  if samples.isEmpty { return Rgb(r: 255, g: 255, b: 255) }
  func median(_ values: [Double]) -> Double { values.sorted()[values.count / 2] }
  return Rgb(
    r: median(samples.map { $0.r }), g: median(samples.map { $0.g }),
    b: median(samples.map { $0.b }))
}

// 배경에서 가장 먼 픽셀 몇 개의 평균을 글자색으로 본다
func foregroundColor(
  _ pixels: UnsafePointer<UInt8>, _ rowBytes: Int, _ w: Int, _ h: Int, _ box: Box, _ bg: Rgb
) -> Rgb {
  var far: [(Double, Rgb)] = []
  let x0 = max(0, Int(box.x)), x1 = min(w - 1, Int(box.x + box.w))
  let y0 = max(0, Int(box.y)), y1 = min(h - 1, Int(box.y + box.h))
  if x0 > x1 || y0 > y1 { return bg.luminance > 140 ? Rgb(r: 30, g: 30, b: 30) : Rgb(r: 245, g: 245, b: 245) }
  for y in y0...y1 {
    for x in x0...x1 {
      let p = pixels + y * rowBytes + x * 4
      let c = Rgb(r: Double(p[0]), g: Double(p[1]), b: Double(p[2]))
      far.append((c.distance(bg), c))
    }
  }
  far.sort { $0.0 > $1.0 }
  let top = far.prefix(max(1, far.count / 20))
  if let first = top.first, first.0 < 90 {
    return bg.luminance > 140 ? Rgb(r: 30, g: 30, b: 30) : Rgb(r: 245, g: 245, b: 245)
  }
  let n = Double(top.count)
  return Rgb(
    r: top.reduce(0) { $0 + $1.1.r } / n, g: top.reduce(0) { $0 + $1.1.g } / n,
    b: top.reduce(0) { $0 + $1.1.b } / n)
}

func drawText(_ text: String, in box: Box, imageHeight: Int, color: Rgb) {
  var size = max(6, box.h * 0.85)
  func attributes(_ s: Double) -> [NSAttributedString.Key: Any] {
    [
      .font: NSFont.systemFont(ofSize: s),
      .foregroundColor: NSColor(
        deviceRed: color.r / 255, green: color.g / 255, blue: color.b / 255, alpha: 1),
    ]
  }
  var measured = (text as NSString).size(withAttributes: attributes(size))
  if measured.width > box.w * 1.02 {
    size = max(6, size * (box.w * 1.02) / measured.width)
    measured = (text as NSString).size(withAttributes: attributes(size))
  }
  // 그리기 좌표는 왼쪽 아래 원점이다
  let y = Double(imageHeight) - box.y - box.h + (box.h - measured.height) / 2
  (text as NSString).draw(at: NSPoint(x: box.x, y: y), withAttributes: attributes(size))
}

func drawAvatar(in box: Box, imageHeight: Int) {
  let side = min(box.w, box.h)
  let cx = box.x + box.w / 2
  let cy = Double(imageHeight) - (box.y + box.h / 2)
  let frame = NSRect(x: cx - side / 2, y: cy - side / 2, width: side, height: side)
  NSColor(calibratedWhite: 0.85, alpha: 1).setFill()
  NSBezierPath(ovalIn: frame).fill()
  NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
  let head = NSRect(x: cx - side * 0.17, y: cy + side * 0.02, width: side * 0.34, height: side * 0.34)
  NSBezierPath(ovalIn: head).fill()
  let shoulders = NSRect(x: cx - side * 0.3, y: cy - side * 0.4, width: side * 0.6, height: side * 0.5)
  NSGraphicsContext.saveGraphicsState()
  NSBezierPath(ovalIn: frame).addClip()
  NSBezierPath(ovalIn: shoulders).fill()
  NSGraphicsContext.restoreGraphicsState()
}

func drawBarcode(_ payload: String, in box: Box, imageHeight: Int) {
  let rect = NSRect(
    x: box.x, y: Double(imageHeight) - box.y - box.h, width: box.w, height: box.h)
  NSColor.white.setFill()
  NSBezierPath(rect: rect).fill()
  let square = abs(box.w - box.h) < min(box.w, box.h) * 0.25
  let name = square ? "CIQRCodeGenerator" : "CICode128BarcodeGenerator"
  guard let filter = CIFilter(name: name) else { return }
  filter.setValue(payload.data(using: .ascii) ?? Data(), forKey: "inputMessage")
  guard let output = filter.outputImage else { return }
  let scaled = output.transformed(
    by: CGAffineTransform(
      scaleX: rect.width / output.extent.width, y: rect.height / output.extent.height))
  guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return }
  let ctx = NSGraphicsContext.current!.cgContext
  ctx.interpolationQuality = .none
  ctx.draw(cg, in: rect)
}

func runPaint(_ input: String, _ planPath: String, _ output: String) {
  let cg = loadCGImage(input)
  guard let planData = FileManager.default.contents(atPath: planPath),
    let plan = try? JSONDecoder().decode(PaintPlan.self, from: planData)
  else { fail("계획 파일을 못 읽었다: \(planPath)") }

  let w = cg.width
  let h = cg.height
  guard
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fail("그릴 캔버스를 못 만들었다") }
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  let rowBytes = ctx.bytesPerRow

  // 비트맵 메모리는 위쪽 행이 먼저다. 덮기 전의 원본 색을 먼저 다 읽어 둔다
  let base = UnsafePointer(ctx.data!.assumingMemoryBound(to: UInt8.self))
  struct Colors { var bg: Rgb; var fg: Rgb }
  var colors: [Colors] = []
  for item in plan.items where item.type == "text" {
    let bg = backgroundColor(base, rowBytes, w, h, item.box)
    let fg = foregroundColor(base, rowBytes, w, h, item.box, bg)
    colors.append(Colors(bg: bg, fg: fg))
  }

  let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = gc
  var textIndex = 0
  for item in plan.items {
    // 왼쪽은 안 넓힌다. 토큰 상자가 앞 글자에 닿아 있어서 넓히면 라벨 끝이 잘린다
    let rect = NSRect(
      x: item.box.x + 1, y: Double(h) - item.box.y - item.box.h - 1, width: item.box.w + 1,
      height: item.box.h + 2)
    switch item.type {
    case "text":
      let c = colors[textIndex]
      textIndex += 1
      NSColor(deviceRed: c.bg.r / 255, green: c.bg.g / 255, blue: c.bg.b / 255, alpha: 1)
        .setFill()
      NSBezierPath(rect: rect).fill()
      drawText(item.text ?? "", in: Box(x: item.box.x + 1, y: item.box.y, w: item.box.w, h: item.box.h), imageHeight: h, color: c.fg)
    case "avatar":
      drawAvatar(in: item.box, imageHeight: h)
    case "barcode":
      drawBarcode(item.text ?? "0000000000", in: item.box, imageHeight: h)
    default:
      break
    }
  }
  NSGraphicsContext.restoreGraphicsState()

  guard let out = ctx.makeImage() else { fail("결과 이미지를 못 만들었다") }
  let rep = NSBitmapImageRep(cgImage: out)
  let lower = output.lowercased()
  let isJpeg = lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg")
  let data =
    isJpeg
    ? rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
    : rep.representation(using: .png, properties: [:])
  guard let bytes = data else { fail("인코딩에 실패했다") }
  do { try bytes.write(to: URL(fileURLWithPath: output)) } catch { fail("파일을 못 썼다: \(error)") }
}

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "ocr" {
  runOcr(args[2])
} else if args.count >= 5 && args[1] == "paint" {
  runPaint(args[2], args[3], args[4])
} else {
  fail("사용법: ocr <이미지> | paint <이미지> <계획.json> <출력>")
}

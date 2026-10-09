import AppKit

// Draws the colors and shapes of assets/pacenote-icon.svg and assets/pacenote.svg as PNG.
// - Default: the dock icon for dev runs (electron .), the README logo and the menu bar icon, into the assets directory.
//   The dock uses the PNG as is, so the icon gets the treatment the system applies to packaged app icons (824 body out
//   of 1024, rounded square, shadow, top highlight) by hand. pacenote-icon-dev.png adds an amber DEV tag, so a run
//   from the repository never looks like the installed app. The menu bar icon is the mark alone, in its gradient.
//   Usage: swift apps/desktop/scripts/icon.swift <assets directory>
// - --iconset: macOS icon set for the packaged app (.icns). Draws the svg full bleed; the system applies the grid and effects.
//   Usage: swift apps/desktop/scripts/icon.swift --iconset <Pacenote.iconset>
let iconsetMode = CommandLine.arguments[1] == "--iconset"
let destination = URL(fileURLWithPath: CommandLine.arguments[iconsetMode ? 2 : 1])

let emerald = CGColor(red: 0x01 / 255, green: 0xab / 255, blue: 0x78 / 255, alpha: 1)
let green = CGColor(red: 0x1f / 255, green: 0xc2 / 255, blue: 0x89 / 255, alpha: 1)
let mint = CGColor(red: 0x48 / 255, green: 0xc8 / 255, blue: 0x9c / 255, alpha: 1)
// The UI's Dev badge color (status-interrupted)
let amber = CGColor(red: 0xd0 / 255, green: 0x84 / 255, blue: 0x1e / 255, alpha: 1)
let space = CGColorSpaceCreateDeviceRGB()

/// Superellipse (n=5) close to the macOS icon outline
func squircle(_ rect: CGRect) -> CGPath {
    let path = CGMutablePath()
    let a = rect.width / 2, cx = rect.midX, cy = rect.midY, n: CGFloat = 5
    for i in 0..<720 {
        let t = CGFloat(i) / 720 * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = cx + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
        let y = cy + a * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
        i == 0 ? path.move(to: CGPoint(x: x, y: y)) : path.addLine(to: CGPoint(x: x, y: y))
    }
    path.closeSubpath()
    return path
}

func gradient(_ colors: [CGColor], _ locations: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations)!
}

/// The mark as one filled outline, from assets/pacenote.svg (512 grid): the track, a ring of radius 164 and width 84
/// opened at the upper right, and Pacey, a dot of radius 42 on the same circle one step ahead. `scale` maps svg units
/// to pixels around `center`. y grows upward here, so the svg's angles flip sign.
func mark(center: CGPoint, scale: CGFloat) -> CGPath {
    let start = atan2(256 - 92.9, 273.1 - 256) // svg (273.1, 92.9): the top, just right of center
    let end = atan2(256 - 238.9, 419.1 - 256) // svg (419.1, 238.9): the right, just above center
    let track = CGMutablePath()
    track.addArc(center: center, radius: 164 * scale, startAngle: start, endAngle: end + 2 * .pi,
        clockwise: false)
    let path = CGMutablePath()
    path.addPath(track.copy(strokingWithWidth: 84 * scale, lineCap: .round, lineJoin: .round,
        miterLimit: 10))
    // svg (372, 140): 116 right of and 116 above the center
    path.addEllipse(in: CGRect(x: center.x + (116 - 42) * scale, y: center.y + (116 - 42) * scale,
        width: 84 * scale, height: 84 * scale))
    return path
}

/// The icon svgs draw the mark at 0.04126 of its 512 grid per cell of their 32 grid (an outer diameter of 17 cells).
let markPerCell: CGFloat = 0.04126

func render(pixels: Int, to name: String, dev: Bool = false) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    let k = CGFloat(pixels) / 1024
    // Coordinates where y grows upward. The body is 824 from (100, 100) on the 1024 grid
    let body = CGRect(x: 100 * k, y: 100 * k, width: 824 * k, height: 824 * k)
    let unit = body.width / 32 // one cell of the pacenote-icon.svg 32 grid
    let shape = squircle(body)

    // 1. Drop shadow
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -12 * k), blur: 30 * k,
        color: CGColor(gray: 0, alpha: 0.32))
    context.addPath(shape)
    context.setFillColor(emerald)
    context.fillPath()
    context.restoreGState()

    // 2. Emerald bottom left -> mint top right (svg: (4, 28) -> (28, 4))
    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.drawLinearGradient(gradient([emerald, green, mint], [0, 0.5, 1]),
        start: CGPoint(x: body.minX + 4 * unit, y: body.minY + 4 * unit),
        end: CGPoint(x: body.minX + 28 * unit, y: body.minY + 28 * unit),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

    // 3. Top highlight
    context.drawLinearGradient(
        gradient([CGColor(gray: 1, alpha: 0.12), CGColor(gray: 1, alpha: 0)], [0, 1]),
        start: CGPoint(x: body.midX, y: body.maxY),
        end: CGPoint(x: body.midX, y: body.midY), options: [])

    // 4. The mark (svg: centered at (16, 16), outer diameter 17). A shadow makes it look slightly raised.
    let center = CGPoint(x: body.midX, y: body.midY)
    let shapeOfMark = mark(center: center, scale: markPerCell * unit)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 16 * k,
        color: CGColor(red: 0, green: 0.25, blue: 0.16, alpha: 0.3))
    context.addPath(shapeOfMark)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fillPath()
    context.restoreGState()
    context.saveGState()
    context.addPath(shapeOfMark)
    context.clip()
    context.drawLinearGradient(
        gradient([CGColor(gray: 1, alpha: 1),
                  CGColor(red: 0.91, green: 0.98, blue: 0.95, alpha: 1)], [0, 1]),
        start: CGPoint(x: center.x, y: center.y + 8.5 * unit),
        end: CGPoint(x: center.x, y: center.y - 8.5 * unit), options: [])
    context.restoreGState()
    context.restoreGState()

    // 5. Edge light (bright at the top, fading toward the bottom)
    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.addPath(shape)
    context.setLineWidth(5 * k)
    context.replacePathWithStrokedPath()
    context.clip()
    context.drawLinearGradient(
        gradient([CGColor(gray: 1, alpha: 0.55), CGColor(gray: 1, alpha: 0.08)], [0, 1]),
        start: CGPoint(x: body.midX, y: body.maxY),
        end: CGPoint(x: body.midX, y: body.minY), options: [])
    context.restoreGState()

    // 6. Dev tag: an amber pill under the mark, clear of it (the mark ends 23.5% above the body bottom)
    if dev {
        let h = body.height * 0.16, w = body.width * 0.5
        let pill = CGRect(x: body.midX - w / 2, y: body.minY + body.height * 0.02, width: w, height: h)
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -4 * k), blur: 10 * k,
            color: CGColor(gray: 0, alpha: 0.3))
        context.addPath(CGPath(roundedRect: pill, cornerWidth: h / 2, cornerHeight: h / 2, transform: nil))
        context.setFillColor(amber)
        context.fillPath()
        context.restoreGState()
        let font = NSFont.systemFont(ofSize: h * 0.6, weight: .heavy)
        let text = NSAttributedString(string: "DEV", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
            NSAttributedString.Key(kCTKernAttributeName as String): h * 0.06,
        ])
        let line = CTLineCreateWithAttributedString(text)
        let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        context.saveGState()
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: pill.midX - bounds.width / 2 - bounds.minX,
            y: pill.midY - bounds.height / 2 - bounds.minY)
        CTLineDraw(line, context)
        context.restoreGState()
    }

    try bitmap.representation(using: .png, properties: [:])!
        .write(to: destination.appendingPathComponent(name))
}

/// Full-bleed icon matching the svg: 32 grid, corner 8, diagonal gradient, white mark
func renderFlat(pixels: Int, to name: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    let unit = CGFloat(pixels) / 32
    context.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 32 * unit, height: 32 * unit),
        cornerWidth: 8 * unit, cornerHeight: 8 * unit, transform: nil))
    context.clip()
    // In the svg y grows downward: (4, 28) -> (28, 4) is bottom left -> top right here
    context.drawLinearGradient(gradient([emerald, mint], [0, 1]),
        start: CGPoint(x: 4 * unit, y: 4 * unit), end: CGPoint(x: 28 * unit, y: 28 * unit),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    context.addPath(mark(center: CGPoint(x: 16 * unit, y: 16 * unit), scale: markPerCell * unit))
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fillPath()
    try bitmap.representation(using: .png, properties: [:])!
        .write(to: destination.appendingPathComponent(name))
}

/// The menu bar icon: the mark alone on transparent, fitted to the square, in the logo's gradient
/// (svg: (54, 314) -> (458, 198), emerald -> mint)
func renderTray(pixels: Int, to name: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    let side = CGFloat(pixels)
    let scale = side / 412 // the mark's outer diameter is 412 svg units
    let center = CGPoint(x: side / 2, y: side / 2)
    context.addPath(mark(center: center, scale: scale))
    context.clip()
    context.drawLinearGradient(gradient([emerald, green, mint], [0, 0.46, 1]),
        start: CGPoint(x: center.x - 202 * scale, y: center.y - 58 * scale),
        end: CGPoint(x: center.x + 202 * scale, y: center.y + 58 * scale),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    try bitmap.representation(using: .png, properties: [:])!
        .write(to: destination.appendingPathComponent(name))
}

if iconsetMode {
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            try renderFlat(pixels: size * scale,
                to: "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png")
        }
    }
} else {
    // Dock/window icon (1024) and README logo (256, shown at 128 on screen)
    try render(pixels: 1024, to: "pacenote-icon.png")
    try render(pixels: 256, to: "pacenote-icon-256.png")
    // Dock/window icon for dev runs (Pacenote Dev)
    try render(pixels: 1024, to: "pacenote-icon-dev.png", dev: true)
    // Menu bar icon (18pt, and @2x for Retina)
    try renderTray(pixels: 18, to: "pacenote-tray.png")
    try renderTray(pixels: 36, to: "pacenote-tray@2x.png")
}

import AppKit

// Draws the colors and shapes of assets/verda-icon.svg as PNG.
// - Default: dock icon for dev runs (electron .). The dock uses the PNG as is, so this draws the treatment the system
//   applies to packaged app icons (824 body out of 1024, rounded square, shadow, top highlight) by hand.
//   Usage: swift apps/desktop/scripts/icon.swift <assets directory>
// - --iconset: macOS icon set for the packaged app (.icns). Draws the svg full bleed; the system applies the grid and effects.
//   Usage: swift apps/desktop/scripts/icon.swift --iconset <Verda.iconset>
let iconsetMode = CommandLine.arguments[1] == "--iconset"
let destination = URL(fileURLWithPath: CommandLine.arguments[iconsetMode ? 2 : 1])

let emerald = CGColor(red: 0x01 / 255, green: 0xab / 255, blue: 0x78 / 255, alpha: 1)
let green = CGColor(red: 0x1f / 255, green: 0xc2 / 255, blue: 0x89 / 255, alpha: 1)
let mint = CGColor(red: 0x48 / 255, green: 0xc8 / 255, blue: 0x9c / 255, alpha: 1)
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

func render(pixels: Int, to name: String) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    let k = CGFloat(pixels) / 1024
    // Coordinates where y grows upward. The body is 824 from (100, 100) on the 1024 grid
    let body = CGRect(x: 100 * k, y: 100 * k, width: 824 * k, height: 824 * k)
    let unit = body.width / 32 // one cell of the verda-icon.svg 32 grid
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

    // 4. Ring (svg: center (16, 16), outer 8.5, inner 3.25). A shadow makes it look slightly raised.
    let center = CGPoint(x: body.midX, y: body.midY)
    let ring = CGMutablePath()
    ring.addEllipse(in: CGRect(x: center.x - 8.5 * unit, y: center.y - 8.5 * unit,
        width: 17 * unit, height: 17 * unit))
    ring.addEllipse(in: CGRect(x: center.x - 3.25 * unit, y: center.y - 3.25 * unit,
        width: 6.5 * unit, height: 6.5 * unit))
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -6 * k), blur: 16 * k,
        color: CGColor(red: 0, green: 0.25, blue: 0.16, alpha: 0.3))
    context.addPath(ring)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fillPath(using: .evenOdd)
    context.restoreGState()
    context.saveGState()
    context.addPath(ring)
    context.clip(using: .evenOdd)
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

    try bitmap.representation(using: .png, properties: [:])!
        .write(to: destination.appendingPathComponent(name))
}

/// Full-bleed icon matching the svg: 32 grid, corner 8, diagonal gradient, white ring
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
    let ring = CGMutablePath()
    ring.addEllipse(in: CGRect(x: 7.5 * unit, y: 7.5 * unit, width: 17 * unit, height: 17 * unit))
    ring.addEllipse(in: CGRect(x: 12.75 * unit, y: 12.75 * unit, width: 6.5 * unit, height: 6.5 * unit))
    context.addPath(ring)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fillPath(using: .evenOdd)
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
    try render(pixels: 1024, to: "verda-icon.png")
    try render(pixels: 256, to: "verda-icon-256.png")
}

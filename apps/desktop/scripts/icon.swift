import AppKit

// assets/verda-icon.svg 의 색과 도형을 macOS 앱 아이콘 격자에 맞춰 PNG 로 그린다.
// 개발 실행(electron .)은 독 아이콘을 PNG 그대로 쓰므로, 시스템이 패키지 앱 아이콘에 해 주는 처리
// (1024 중 824 본체, 둥근 사각형, 그림자, 위쪽 반사광)를 직접 그린다.
// 사용: swift apps/desktop/scripts/icon.swift <assets 디렉터리>
let destination = URL(fileURLWithPath: CommandLine.arguments[1])

let emerald = CGColor(red: 0x01 / 255, green: 0xab / 255, blue: 0x78 / 255, alpha: 1)
let green = CGColor(red: 0x1f / 255, green: 0xc2 / 255, blue: 0x89 / 255, alpha: 1)
let mint = CGColor(red: 0x48 / 255, green: 0xc8 / 255, blue: 0x9c / 255, alpha: 1)
let space = CGColorSpaceCreateDeviceRGB()

/// macOS 아이콘 윤곽에 가까운 초타원(n=5)
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
    // y 가 위로 커지는 좌표. 본체는 1024 격자에서 (100, 100) 부터 824
    let body = CGRect(x: 100 * k, y: 100 * k, width: 824 * k, height: 824 * k)
    let unit = body.width / 32 // verda-icon.svg 의 32 격자 한 칸
    let shape = squircle(body)

    // 1. 바닥 그림자
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -12 * k), blur: 30 * k,
        color: CGColor(gray: 0, alpha: 0.32))
    context.addPath(shape)
    context.setFillColor(emerald)
    context.fillPath()
    context.restoreGState()

    // 2. 왼쪽 아래 에메랄드 -> 오른쪽 위 민트 (svg: (4, 28) -> (28, 4))
    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.drawLinearGradient(gradient([emerald, green, mint], [0, 0.5, 1]),
        start: CGPoint(x: body.minX + 4 * unit, y: body.minY + 4 * unit),
        end: CGPoint(x: body.minX + 28 * unit, y: body.minY + 28 * unit),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

    // 3. 위쪽 반사광
    context.drawLinearGradient(
        gradient([CGColor(gray: 1, alpha: 0.12), CGColor(gray: 1, alpha: 0)], [0, 1]),
        start: CGPoint(x: body.midX, y: body.maxY),
        end: CGPoint(x: body.midX, y: body.midY), options: [])

    // 4. 링 (svg: 중심 (16, 16), 바깥 8.5, 안쪽 3.25). 살짝 띄워 보이게 그림자를 준다.
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

    // 5. 가장자리 빛 (위는 밝게, 아래로 갈수록 흐리게)
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

// 독/창 아이콘(1024)과 README 로고(256, 화면에서 128 로 보인다)
try render(pixels: 1024, to: "verda-icon.png")
try render(pixels: 256, to: "verda-icon-256.png")

// 生成 1024×1024 应用图标 PNG:蓝紫渐变圆角方 + 白色盾牌勾(呼应安全审计主题)。
// 用法:swift make-icon.swift <输出 PNG 路径>
import AppKit

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

let rect = NSRect(x: 0, y: 0, width: size, height: size)
// macOS 图标的圆角(约 22.5% squircle 近似)
let corner = size * 0.225
let path = NSBezierPath(roundedRect: rect, xRadius: corner, yRadius: corner)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.29, green: 0.42, blue: 0.98, alpha: 1),   // 蓝
    NSColor(calibratedRed: 0.47, green: 0.29, blue: 0.93, alpha: 1),   // 紫
])!
gradient.draw(in: path, angle: -90)

// 盾牌勾(SF Symbol),白色,居中偏上
let cfg = NSImage.SymbolConfiguration(pointSize: size * 0.5, weight: .semibold)
if let sym = NSImage(systemSymbolName: "checkmark.shield.fill", accessibilityDescription: nil)?
    .withSymbolConfiguration(cfg) {
    let tinted = NSImage(size: sym.size)
    tinted.lockFocus()
    NSColor.white.set()
    let r = NSRect(origin: .zero, size: sym.size)
    r.fill()
    sym.draw(in: r, from: .zero, operation: .destinationIn, fraction: 1)
    tinted.unlockFocus()
    let w = size * 0.52, h = w * (sym.size.height / sym.size.width)
    tinted.draw(in: NSRect(x: (size - w) / 2, y: (size - h) / 2, width: w, height: h),
                from: .zero, operation: .sourceOver, fraction: 0.96)
}

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("icon render failed\n".data(using: .utf8)!)
    exit(1)
}
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")

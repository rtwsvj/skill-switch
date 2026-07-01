import SwiftUI

// 原生设计组件 —— 卡片 / 指标卡 / 徽章 + 语义色。明暗主题由系统自动处理。

enum Tone: Sendable {
    case good, warn, danger, neutral, accent

    var color: Color {
        switch self {
        case .good: return .green
        case .warn: return .orange
        case .danger: return .red
        case .neutral: return .secondary
        case .accent: return .accentColor
        }
    }
}

extension AuditSeverity {
    var tone: Tone {
        switch self {
        case .critical, .high: return .danger
        case .medium, .low: return .warn
        }
    }
    var label: String {
        switch self {
        case .critical: return "严重"
        case .high: return "高"
        case .medium: return "中"
        case .low: return "低"
        }
    }
}

extension AuditVerdict {
    var tone: Tone {
        switch self {
        case .SAFE: return .good
        case .REVIEW: return .warn
        case .DANGER: return .danger
        }
    }
    var label: String {
        switch self {
        case .SAFE: return "安全"
        case .REVIEW: return "建议看看"
        case .DANGER: return "危险"
        }
    }
}

/// 卡片容器:材质背景 + 圆角 + 细边框,明暗自适应。
struct Card<Content: View>: View {
    var tone: Tone = .neutral
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(tone == .neutral ? Color.primary.opacity(0.08) : tone.color.opacity(0.35), lineWidth: 1)
            )
    }
}

/// 指标卡:SF Symbol 图标徽章 + 大数值 + 说明。
struct MetricCard: View {
    let icon: String
    let value: String
    let label: String
    var tone: Tone = .neutral

    var body: some View {
        Card(tone: tone) {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(tone == .neutral ? Color.secondary : tone.color)
                    .frame(width: 40, height: 40)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                Text(value)
                    .font(.system(size: 40, weight: .semibold, design: .rounded))
                    .foregroundStyle(tone == .good || tone == .danger ? tone.color : Color.primary)
                    .monospacedDigit()
                Text(label)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// 小徽章(状态 / severity / verdict)。
struct Pill: View {
    let text: String
    var tone: Tone = .neutral

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tone.color.opacity(0.15), in: Capsule())
            .foregroundStyle(tone == .neutral ? Color.secondary : tone.color)
            .overlay(Capsule().strokeBorder(tone.color.opacity(0.3), lineWidth: 1))
    }
}

/// 屏标题栏:标题 + 右侧刷新。
struct ScreenHeader: View {
    let title: String
    var subtitle: String?
    var onReload: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title2.weight(.semibold))
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if let onReload {
                Button { onReload() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("刷新")
            }
        }
    }
}

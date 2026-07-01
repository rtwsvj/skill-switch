import SwiftUI

struct SafetyView: View {
    @EnvironmentObject var state: AppState
    private let cols = [GridItem(.adaptive(minimum: 170), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "安全", subtitle: "\(state.audit.total) 个技能已体检") {
                    Task { await state.reload() }
                }

                LazyVGrid(columns: cols, spacing: 14) {
                    MetricCard(icon: "checkmark.shield.fill", value: "\(state.safeCount)", label: "安全", tone: .good)
                    MetricCard(icon: "shield.lefthalf.filled", value: "\(state.reviewCount)", label: "建议看看",
                               tone: state.reviewCount > 0 ? .warn : .neutral)
                    MetricCard(icon: "exclamationmark.octagon.fill", value: "\(state.blockedCount)", label: "被拦下",
                               tone: state.blockedCount > 0 ? .danger : .neutral)
                }

                let cross = state.audit.crossSkillFindings ?? []
                if !cross.isEmpty {
                    Card(tone: .danger) {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("跨技能协同风险", systemImage: "link.badge.plus").font(.headline)
                            ForEach(cross) { findingRow($0) }
                        }
                    }
                }

                ForEach(state.audit.skills.sorted { $0.score < $1.score }) { report in
                    skillReport(report)
                }
            }
            .padding(20)
        }
    }

    @ViewBuilder private func skillReport(_ r: AuditReport) -> some View {
        Card(tone: r.blocked == true ? .danger : r.verdict.tone) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(r.name ?? r.path).font(.headline)
                    Spacer()
                    Text("\(r.score)")
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .foregroundStyle(r.verdict.tone.color)
                        .monospacedDigit()
                }
                HStack(spacing: 6) {
                    Pill(text: r.verdict.label, tone: r.verdict.tone)
                    if r.blocked == true { Pill(text: "被拦下", tone: .danger) }
                    if !r.findings.isEmpty { Text("\(r.findings.count) 条发现").font(.caption).foregroundStyle(.secondary) }
                }
                if r.findings.isEmpty {
                    Text("没有发现明显风险。").font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(r.findings) { findingRow($0) }
                }
            }
        }
    }

    @ViewBuilder private func findingRow(_ f: AuditFinding) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(f.severity.tone.color).frame(width: 7, height: 7).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(f.ruleId).font(.callout.weight(.medium))
                    Spacer()
                    Pill(text: f.severity.label, tone: f.severity.tone)
                }
                Text(f.message).font(.caption).foregroundStyle(.secondary)
                Text("\(f.file):\(f.line)").font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
        }
    }
}

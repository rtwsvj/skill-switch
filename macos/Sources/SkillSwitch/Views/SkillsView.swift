import SwiftUI

struct SkillsView: View {
    @EnvironmentObject var state: AppState
    @State private var selected: SkillRecord?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "技能", subtitle: "\(state.scan.total) 个技能") {
                    Task { await state.reload() }
                }
                Text("这些技能是各个 AI 工具装的。点开看详情;停用 / 删除等写操作在「安装维护」里(都会先自动备份)。")
                    .font(.callout).foregroundStyle(.secondary)

                if state.scan.skills.isEmpty {
                    Card { Text("还没有任何技能。").foregroundStyle(.secondary) }
                } else {
                    ForEach(state.scan.skills) { skill in
                        skillRow(skill)
                    }
                }
            }
            .padding(20)
        }
    }

    @ViewBuilder private func skillRow(_ skill: SkillRecord) -> some View {
        let isOpen = selected?.id == skill.id
        Card(tone: skill.error != nil ? .warn : .neutral) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "puzzlepiece.extension.fill").foregroundStyle(.secondary)
                    Text(skill.displayName).font(.headline)
                    Spacer()
                    if let enabled = skill.enabled {
                        Pill(text: enabled ? "已启用" : "已停用", tone: enabled ? .good : .neutral)
                    }
                    if skill.error != nil { Pill(text: "读取失败", tone: .warn) }
                    Image(systemName: isOpen ? "chevron.up" : "chevron.down").foregroundStyle(.tertiary)
                }
                HStack(spacing: 6) {
                    ForEach(skill.agents, id: \.self) { Pill(text: $0, tone: .neutral) }
                }
                if isOpen {
                    Divider()
                    detail(skill)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy) { selected = isOpen ? nil : skill } }
        }
    }

    @ViewBuilder private func detail(_ skill: SkillRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            row("目录", skill.dirName)
            row("位置", skill.relSkillsDir)
            if let d = skill.description, !d.isEmpty { row("描述", d) }
            if let e = skill.error { row("错误", e) }
        }
    }

    @ViewBuilder private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(k).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            Text(v).font(.callout).textSelection(.enabled)
        }
    }
}

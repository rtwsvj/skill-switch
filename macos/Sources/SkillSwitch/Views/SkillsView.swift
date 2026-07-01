import SwiftUI

private enum SkillAction: Identifiable {
    case toggle(name: String, to: Bool)
    case remove(name: String, agent: String)

    var id: String {
        switch self {
        case .toggle(let n, let t): return "toggle-\(n)-\(t)"
        case .remove(let n, let a): return "remove-\(n)-\(a)"
        }
    }
    var isDestructive: Bool { if case .remove = self { return true }; return false }
    var confirmTitle: String {
        switch self {
        case .toggle(_, let to): return to ? "启用这个技能?" : "停用这个技能?"
        case .remove: return "删除这个技能?"
        }
    }
    var confirmMessage: String {
        switch self {
        case .toggle(let n, let to):
            return to ? "启用 \(n)。改动前会先自动备份,随时可从「历史」还原。"
                      : "停用 \(n)(只是关掉,文件仍在磁盘,随时可再启用)。改动前会先自动备份。"
        case .remove(let n, let a):
            return "从 \(a) 删除 \(n)。改动前会先自动备份,误删可从「历史」一键还原。"
        }
    }
    var confirmButton: String {
        switch self {
        case .toggle(_, let to): return to ? "启用" : "停用"
        case .remove: return "删除"
        }
    }
}

struct SkillsView: View {
    @EnvironmentObject var state: AppState
    @State private var openId: String?
    @State private var pending: SkillAction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "技能", subtitle: "\(state.scan.total) 个技能") {
                    Task { await state.reload() }
                }
                Text("这些技能是各个 AI 工具装的。停用 / 删除都会先自动备份,可从「历史」还原。")
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
        .disabled(state.busy)
        .confirmationDialog(
            pending?.confirmTitle ?? "",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            presenting: pending
        ) { action in
            Button(action.confirmButton, role: action.isDestructive ? .destructive : nil) {
                perform(action)
            }
            Button("取消", role: .cancel) {}
        } message: { action in
            Text(action.confirmMessage)
        }
    }

    private func perform(_ action: SkillAction) {
        Task {
            switch action {
            case .toggle(let name, let to): await state.toggle(name, enabled: to)
            case .remove(let name, let agent): await state.remove(name, agent: agent)
            }
        }
    }

    @ViewBuilder private func skillRow(_ skill: SkillRecord) -> some View {
        let isOpen = openId == skill.id
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
                    actions(skill)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy) { openId = isOpen ? nil : skill.id } }
        }
    }

    @ViewBuilder private func actions(_ skill: SkillRecord) -> some View {
        HStack(spacing: 10) {
            let enabled = skill.enabled ?? true
            Button {
                pending = .toggle(name: skill.name ?? skill.dirName, to: !enabled)
            } label: {
                Label(enabled ? "停用" : "启用", systemImage: enabled ? "pause.circle" : "play.circle")
            }
            .buttonStyle(.bordered)

            Button(role: .destructive) {
                pending = .remove(name: skill.name ?? skill.dirName, agent: skill.agents.first ?? "")
            } label: {
                Label("删除", systemImage: "trash")
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .disabled(skill.agents.isEmpty)
            Spacer()
        }
        .padding(.top, 4)
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

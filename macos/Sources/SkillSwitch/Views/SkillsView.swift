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
}

struct SkillsView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared
    @State private var openId: String?
    @State private var pending: SkillAction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("nav.skills"),
                             subtitle: l10n.t("skills.subtitle.count", state.scan.total)) {
                    Task { await state.reload() }
                }
                Text(l10n.t("skills.intro"))
                    .font(.callout).foregroundStyle(.secondary)

                if state.scan.skills.isEmpty {
                    Card { Text(l10n.t("skills.empty")).foregroundStyle(.secondary) }
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
            dialogTitle(pending),
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            presenting: pending
        ) { action in
            Button(dialogConfirmBtn(action), role: action.isDestructive ? .destructive : nil) {
                perform(action)
            }
            Button(l10n.t("skills.confirm.cancel"), role: .cancel) {}
        } message: { action in
            Text(dialogMessage(action))
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

    private func dialogTitle(_ action: SkillAction?) -> String {
        guard let action else { return "" }
        switch action {
        case .toggle(_, let to):
            return l10n.t(to ? "skills.confirm.enable.title" : "skills.confirm.disable.title")
        case .remove:
            return l10n.t("skills.confirm.remove.title")
        }
    }

    private func dialogMessage(_ action: SkillAction) -> String {
        switch action {
        case .toggle(let n, let to):
            return l10n.t(to ? "skills.confirm.enable.msg" : "skills.confirm.disable.msg", n)
        case .remove(let n, let a):
            return l10n.t("skills.confirm.remove.msg", a, n)
        }
    }

    private func dialogConfirmBtn(_ action: SkillAction) -> String {
        switch action {
        case .toggle(_, let to):
            return l10n.t(to ? "skills.confirm.enable.btn" : "skills.confirm.disable.btn")
        case .remove:
            return l10n.t("skills.confirm.remove.btn")
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
                        Pill(text: l10n.t(enabled ? "skills.pill.enabled" : "skills.pill.disabled"),
                             tone: enabled ? .good : .neutral)
                    }
                    if skill.error != nil { Pill(text: l10n.t("skills.pill.readFailed"), tone: .warn) }
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
                Label(l10n.t(enabled ? "skills.action.disable" : "skills.action.enable"),
                      systemImage: enabled ? "pause.circle" : "play.circle")
            }
            .buttonStyle(.bordered)

            Button(role: .destructive) {
                pending = .remove(name: skill.name ?? skill.dirName, agent: skill.agents.first ?? "")
            } label: {
                Label(l10n.t("skills.action.remove"), systemImage: "trash")
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
            row(l10n.t("skills.row.dir"), skill.dirName)
            row(l10n.t("skills.row.path"), skill.relSkillsDir)
            if let d = skill.description, !d.isEmpty { row(l10n.t("skills.row.desc"), d) }
            if let e = skill.error { row(l10n.t("skills.row.error"), e) }
        }
    }

    @ViewBuilder private func row(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(k).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            Text(v).font(.callout).textSelection(.enabled)
        }
    }
}
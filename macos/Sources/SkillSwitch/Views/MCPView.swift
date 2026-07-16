import SwiftUI

// 「MCP」屏(milestone 6):运行时 MCP 审计 + rug-pull 基线(GUI 壳)。
//
// 设计纪律(规格铁律,任何一条违反即失败):
//   - 进屏默认加载 list 模式:`mcp-scan --json` 无 flag → CLI 只列不连(天然安全)
//   - 「扫描」按钮 → 走原生确认弹窗,如实交代将启动什么进程 / 请求什么 URL
//     (按 describe 字段原样渲染,不掩盖),GUI 确认=同意 → CLI 侧带 --yes 执行
//   - 「重新接受」按钮仅当有 rug-pull findings 时出现,二次确认后 --reset-baseline
//   - GUI 自身绝不实现任何 CLI 没有的连接逻辑(GUI 只是 CLI 的壳)
//   - 该屏自管加载/刷新;不污染 AppState.reload() 全局链

private enum McpAction: Identifiable {
    case scan(server: McpServerSummary)
    case resetBaseline(serverKey: String, serverName: String)

    var id: String {
        switch self {
        case .scan(let s): return "scan-\(s.key)"
        case .resetBaseline(let k, _): return "reset-\(k)"
        }
    }
}

struct MCPView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared

    // 自屏数据:list 报告 + 每 server 的扫描结果(含本次的 baselineStatus)
    @State private var listReport: McpScanListReport?
    @State private var scanRows: [String: McpScanRow] = [:]
    @State private var loadingList = false
    @State private var scanningKeys: Set<String> = []
    @State private var resettingKeys: Set<String> = []
    @State private var error: String?
    @State private var pending: McpAction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("nav.mcp"),
                             subtitle: l10n.t("mcpscan.subtitle.count", servers.count)) {
                    Task { await loadList() }
                }
                Text(l10n.t("mcpscan.intro"))
                    .font(.callout).foregroundStyle(.secondary)

                if loadingList {
                    ProgressView().padding()
                } else if let error {
                    Card(tone: .danger) { Text(error).font(.callout) }
                } else if servers.isEmpty {
                    Card { Text(l10n.t("mcpscan.empty")).foregroundStyle(.secondary) }
                } else {
                    ForEach(servers) { server in
                        serverCard(server)
                    }
                }
            }
            .padding(20)
        }
        .disabled(state.busy || !scanningKeys.isEmpty || !resettingKeys.isEmpty)
        .task { if listReport == nil { await loadList() } }
        .confirmationDialog(
            dialogTitle(pending),
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            presenting: pending
        ) { action in
            Button(dialogConfirmBtn(action), role: nil) { perform(action) }
            Button(l10n.t("mcpscan.confirm.cancel"), role: .cancel) {}
        } message: { action in
            Text(dialogMessage(action))
        }
    }

    private var servers: [McpServerSummary] {
        listReport?.servers ?? []
    }

    // ── list 加载 ──────────────────────────────────────────────────────
    private func loadList() async {
        loadingList = true
        error = nil
        do {
            listReport = try await state.loadMcpList()
        } catch {
            // 通用文案 + 底层原因(CLI 找不到/解码失败),便于用户转述排查
            let msg = (error as? CLIError)?.message ?? error.localizedDescription
            self.error = "\(l10n.t("mcpscan.load.failed"))\n\(msg)"
        }
        loadingList = false
    }

    // ── scan(单 server)─────────────────────────────────────────────
    private func scan(_ server: McpServerSummary, resetBaseline: Bool) async {
        let key = server.key
        if resetBaseline { resettingKeys.insert(key) } else { scanningKeys.insert(key) }
        defer {
            if resetBaseline { resettingKeys.remove(key) } else { scanningKeys.remove(key) }
        }
        do {
            let report = try await state.scanMcp(serverKey: key, resetBaseline: resetBaseline)
            if let r = report.servers.first(where: { $0.key == key }) {
                scanRows[key] = McpScanRow(result: r, baselineStatus: report.baselineStatus)
            } else {
                // 空或不含该 key 都按无结果报——不许静默
                error = l10n.t("mcpscan.scan.noResult")
            }
        } catch {
            let msg = (error as? CLIError)?.message ?? error.localizedDescription
            self.error = l10n.t("mcpscan.scan.failed", key, msg)
        }
    }

    private func perform(_ action: McpAction) {
        Task {
            switch action {
            case .scan(let s): await scan(s, resetBaseline: false)
            case .resetBaseline(let k, _):
                if let s = servers.first(where: { $0.key == k }) {
                    await scan(s, resetBaseline: true)
                }
            }
        }
    }

    // ── 确认弹窗文案 ──────────────────────────────────────────────
    private func dialogTitle(_ action: McpAction?) -> String {
        guard let action else { return "" }
        switch action {
        case .scan: return l10n.t("mcpscan.confirm.scan.title")
        case .resetBaseline: return l10n.t("mcpscan.confirm.reset.title")
        }
    }

    private func dialogConfirmBtn(_ action: McpAction) -> String {
        switch action {
        case .scan: return l10n.t("mcpscan.confirm.scan.btn")
        case .resetBaseline: return l10n.t("mcpscan.confirm.reset.btn")
        }
    }

    private func dialogMessage(_ action: McpAction) -> String {
        switch action {
        case .scan(let s):
            // stdio / http 走不同 key:std = 「将启动本地进程」,http = 「将请求 URL」。
            // describe 字段是 CLI 已经拼好的一行(「stdio: cmd args」或「http: url」),
            // 两套模板共用后半句「skill-switch 只读取工具清单,绝不调用任何工具」—— 大白话交代。
            switch s.transport {
            case .stdio:
                return l10n.t("mcpscan.confirm.scan.msg.stdio", s.name, s.describe)
            case .http:
                return l10n.t("mcpscan.confirm.scan.msg.http", s.name, s.describe)
            }
        case .resetBaseline(_, let name):
            return l10n.t("mcpscan.confirm.reset.msg", name)
        }
    }

    // ── 单 server 卡片 ──────────────────────────────────────────────
    @ViewBuilder private func serverCard(_ s: McpServerSummary) -> some View {
        let row = scanRows[s.key]
        let isScanning = scanningKeys.contains(s.key)
        Card(tone: cardTone(for: row)) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: s.transport == .stdio ? "terminal" : "network")
                        .foregroundStyle(.secondary)
                    Text(s.name).font(.headline)
                    Spacer()
                    Pill(text: l10n.t(s.transport == .stdio ? "mcpscan.transport.stdio" : "mcpscan.transport.http"),
                         tone: .neutral)
                }
                row2(l10n.t("mcpscan.row.source"), s.source)
                row2(l10n.t("mcpscan.row.describe"), s.describe, mono: true)

                if let row {
                    Divider().padding(.vertical, 2)
                    resultSection(row)
                } else {
                    HStack {
                        Spacer()
                        Button {
                            pending = .scan(server: s)
                        } label: {
                            Label(l10n.t("mcpscan.action.scan"), systemImage: "magnifyingglass")
                        }
                        .buttonStyle(.bordered)
                        .disabled(isScanning || state.busy)
                        if isScanning { ProgressView().controlSize(.small) }
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    @ViewBuilder private func resultSection(_ row: McpScanRow) -> some View {
        let r = row.result
        VStack(alignment: .leading, spacing: 8) {
            baselineStatusRow(row)

            if !r.connected {
                // 连接失败:error.message 原样进行内提示(红)
                Card(tone: .danger) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(l10n.t("mcpscan.result.connectFailed"), systemImage: "xmark.octagon.fill")
                            .font(.callout.weight(.medium))
                        if let e = r.error, !e.message.isEmpty {
                            Text(e.message).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text(l10n.t("mcpscan.result.tools", r.tools.count))
                    .font(.callout).foregroundStyle(.secondary)

                if !r.findings.isEmpty {
                    Label(l10n.t("mcpscan.result.findings", r.findings.count),
                          systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.orange)
                    ForEach(r.findings) { findingRow($0) }
                }

                // rug-pull findings(单独一组,大白话:「和上次不一样了」)
                if !r.rugPullFindings.isEmpty {
                    Card(tone: .danger) {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(l10n.t("mcpscan.result.rugPull.title"),
                                  systemImage: "arrow.triangle.2.circlepath.circle.fill")
                                .font(.callout.weight(.medium))
                            Text(l10n.t("mcpscan.result.rugPull.hint"))
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(r.rugPullFindings) { findingRow($0) }
                            if !r.removedTools.isEmpty {
                                Text(l10n.t("mcpscan.result.removed", r.removedTools.count))
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(r.removedTools.joined(separator: ", "))
                                    .font(.caption.monospaced()).foregroundStyle(.tertiary)
                            }
                            Button {
                                pending = .resetBaseline(serverKey: r.key, serverName: r.name)
                            } label: {
                                Label(l10n.t("mcpscan.action.reset"), systemImage: "arrow.counterclockwise")
                            }
                            .buttonStyle(.bordered)
                            .tint(.orange)
                            .disabled(resettingKeys.contains(r.key))
                            .padding(.top, 2)
                        }
                    }
                }
            }

            // 该行重新扫描入口(已有结果时也能再扫)
            HStack {
                Spacer()
                Button {
                    if let s = servers.first(where: { $0.key == r.key }) {
                        pending = .scan(server: s)
                    }
                } label: {
                    Label(l10n.t("mcpscan.action.rescan"), systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .disabled(scanningKeys.contains(r.key) || resettingKeys.contains(r.key) || state.busy)
                if scanningKeys.contains(r.key) { ProgressView().controlSize(.small) }
            }
            .padding(.top, 4)
        }
    }

    private func cardTone(for row: McpScanRow?) -> Tone {
        guard let r = row?.result else { return .neutral }
        if !r.connected { return .danger }
        if r.hasRugPull { return .danger }
        if r.findings.contains(where: { $0.severity == .critical || $0.severity == .high }) { return .danger }
        if !r.findings.isEmpty { return .warn }
        return .good
    }

    @ViewBuilder private func baselineStatusRow(_ row: McpScanRow) -> some View {
        HStack(spacing: 6) {
            Pill(text: l10n.t("mcpscan.baseline.pill"), tone: .neutral)
            Text(l10n.t(baselineStatusKey(row.baselineStatus), row.result.name))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// 把 baselineStatus 字符串映射到 i18n key(check-i18n 是静态扫描,这里用 switch
    /// 把 key 都显式列出来,工具链能扫到)。未来 CLI 新增状态 → 落到"状态未知",
    /// 而不是误标成"还没有记录"(那会误导安全判断)。
    private func baselineStatusKey(_ status: String) -> String {
        switch status {
        case "established": return "mcpscan.baseline.established"
        case "compared": return "mcpscan.baseline.compared"
        case "reset": return "mcpscan.baseline.reset"
        case "missing": return "mcpscan.baseline.missing"
        default: return "mcpscan.baseline.unknown"
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
            }
        }
    }

    @ViewBuilder private func row2(_ k: String, _ v: String, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(k).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(minWidth: 60, alignment: .leading)
            if mono {
                Text(v).font(.caption.monospaced()).textSelection(.enabled)
            } else {
                Text(v).font(.callout).textSelection(.enabled)
            }
        }
    }
}
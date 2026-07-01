import SwiftUI
import AppKit

// 裸 SPM 可执行文件默认以 accessory 策略启动、不显示窗口;设为 .regular 并激活,
// 让它作为普通 macOS 窗口 App 运行(开发/截图用;正式分发会打进 .app 包)。
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct SkillSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 900, minHeight: 600)
                .task { await state.reload() }
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("刷新") { Task { await state.reload() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

enum Screen: String, CaseIterable, Identifiable {
    case overview, skills, safety, operations, history, usage
    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "总览"
        case .skills: return "技能"
        case .safety: return "安全"
        case .operations: return "维护"
        case .history: return "历史"
        case .usage: return "使用"
        }
    }
    var icon: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .skills: return "puzzlepiece.extension"
        case .safety: return "checkmark.shield"
        case .operations: return "wrench.and.screwdriver"
        case .history: return "clock.arrow.circlepath"
        case .usage: return "chart.bar"
        }
    }
}

struct RootView: View {
    @EnvironmentObject var state: AppState
    @State private var selection: Screen = .overview

    var body: some View {
        NavigationSplitView {
            List(Screen.allCases, selection: $selection) { screen in
                Label(screen.title, systemImage: screen.icon).tag(screen)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Divider()
                    HStack(spacing: 6) {
                        Circle().fill(state.fatalError == nil ? Color.green : Color.red).frame(width: 7, height: 7)
                        Text(state.fatalError == nil ? "已连接 CLI" : "CLI 未连接")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let at = state.loadedAt {
                        Text("刷新于 \(at.formatted(date: .omitted, time: .shortened))")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
            }
        } detail: {
            Group {
                switch selection {
                case .overview: OverviewView()
                case .skills: SkillsView()
                case .safety: SafetyView()
                case .operations: OperationsView()
                case .history: HistoryView()
                case .usage: UsageView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("skill-switch").font(.headline) }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await state.reload() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }.help("刷新").disabled(state.isLoading)
                }
            }
        }
        .overlay(alignment: .top) {
            if let err = state.fatalError {
                Text(err)
                    .font(.callout)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                    .padding()
            }
        }
        .overlay(alignment: .bottom) { banner }
    }

    // 写操作反馈:成功(绿)/ 失败(红)/ 处理中。3 秒后自动消失。
    @ViewBuilder private var banner: some View {
        if state.busy {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("处理中…") }
                .padding(10).background(.regularMaterial, in: Capsule()).padding(.bottom, 16)
        } else if let msg = state.toast {
            Label(msg, systemImage: "checkmark.circle.fill")
                .font(.callout).foregroundStyle(.green)
                .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task { try? await Task.sleep(for: .seconds(3.5)); state.toast = nil }
        } else if let err = state.actionError {
            Label(err, systemImage: "exclamationmark.triangle.fill")
                .font(.callout).foregroundStyle(.red)
                .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task { try? await Task.sleep(for: .seconds(5)); state.actionError = nil }
        }
    }
}

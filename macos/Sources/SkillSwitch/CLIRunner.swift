import Foundation

// 壳外调用 skill-switch CLI 的唯一出口。核心引擎不动,这里只负责:找到 CLI → 跑子进程 → 拿 JSON。
//
// CLI 解析顺序:
//   1. 环境变量 SKILL_SWITCH_CLI = 可执行文件全路径(打包后指向内置 SEA sidecar)
//   2. 环境变量 SKILL_SWITCH_ROOT = 仓库根 → 跑 `node <root>/bin/skill-switch.mjs`(开发用)
//   3. 回退 PATH 上的 `skill-switch`
//
// 安全:只读命令走这里;写操作(install/toggle/remove/sync)后续里程碑再接,且沿用 CLI 的
// 装前审计 + 快照护栏。绝不在此拼接执行任意用户输入。

struct CLIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum CLI {
    /// 解析出启动程序与固定前缀参数。
    static func resolve() -> (launch: String, prefix: [String]) {
        let env = ProcessInfo.processInfo.environment
        if let cli = env["SKILL_SWITCH_CLI"], !cli.isEmpty {
            return (cli, [])
        }
        if let root = env["SKILL_SWITCH_ROOT"], !root.isEmpty {
            return ("/usr/bin/env", ["node", "\(root)/bin/skill-switch.mjs"])
        }
        return ("/usr/bin/env", ["skill-switch"])
    }

    /// 跑 CLI 拿原始 stdout。非 2xx 退出码或空输出会抛错(带 stderr 摘要)。
    static func runRaw(_ args: [String]) async throws -> Data {
        let (launch, prefix) = resolve()
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: launch)
                proc.arguments = prefix + args
                let out = Pipe()
                let err = Pipe()
                proc.standardOutput = out
                proc.standardError = err
                do {
                    try proc.run()
                    let outData = out.fileHandleForReading.readDataToEndOfFile()
                    let errData = err.fileHandleForReading.readDataToEndOfFile()
                    proc.waitUntilExit()
                    if outData.isEmpty && proc.terminationStatus != 0 {
                        let msg = String(data: errData, encoding: .utf8) ?? "exit \(proc.terminationStatus)"
                        cont.resume(throwing: CLIError(message: msg.trimmingCharacters(in: .whitespacesAndNewlines)))
                        return
                    }
                    cont.resume(returning: outData)
                } catch {
                    cont.resume(throwing: CLIError(message: "无法启动 CLI:\(error.localizedDescription)"))
                }
            }
        }
    }

    /// 跑 CLI 并把 JSON 解码成指定类型。
    static func runJSON<T: Decodable>(_ args: [String], as type: T.Type) async throws -> T {
        let data = try await runRaw(args)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            let snippet = String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw CLIError(message: "JSON 解码失败(\(T.self)):\(error)\n\(snippet)")
        }
    }
}

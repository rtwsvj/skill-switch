import Darwin
import Foundation

// 壳外调用 skill-switch CLI 的唯一出口。核心引擎不动，这里只负责：找到 CLI → 跑子进程 → 拿 JSON。
//
// CLI 解析顺序：
//   1. .app 内置 SEA sidecar
//   2. 环境变量 SKILL_SWITCH_CLI = 可执行文件全路径
//   3. 环境变量 SKILL_SWITCH_ROOT = 仓库根 → 跑 `node <root>/bin/skill-switch.mjs`
//   4. 回退 PATH 上的 `skill-switch`
//
// 非零退出码兼容约定：部分只读命令（尤其 audit）会用退出码表达“发现问题”，同时仍在
// stdout 输出有效 JSON。因此 runJSON 会接受“非零 + 可解码 JSON”；非零且无 stdout，或
// stdout 不是目标 JSON 时才抛错。所有参数始终通过 argv 传递，不拼接 shell 命令。

struct CLIError: LocalizedError, Sendable {
    enum Kind: Equatable, Sendable {
        case launchFailed
        case nonZeroExit(Int32)
        case timedOut
        case outputLimitExceeded
        case streamReadFailed
        case invalidJSON
    }

    let kind: Kind
    let message: String

    init(kind: Kind = .launchFailed, message: String) {
        self.kind = kind
        self.message = message
    }

    var errorDescription: String? { message }
}

struct CLIInvocation: Sendable {
    let launch: String
    let prefix: [String]
}

struct CLIExecutionPolicy: Sendable {
    /// GUI 的外层保险。具体命令仍应设置更短的 CLI 级超时。
    var timeout: TimeInterval = 120
    /// stdout + stderr 的合计上限，避免异常 CLI 或子进程耗尽 GUI 内存。
    var maximumOutputBytes: Int = 16 * 1024 * 1024
    /// 先发 SIGTERM，宽限后升级到 SIGKILL。
    var terminationGracePeriod: TimeInterval = 0.5
    /// 主进程退出后，给两个 pipe 留出的排空时间。
    var pipeDrainTimeout: TimeInterval = 2

    static let `default` = CLIExecutionPolicy()
}

private enum CLIStream: String, Sendable {
    case stdout
    case stderr
}

private enum CLIStopReason: Sendable {
    case cancelled
    case timedOut
    case outputLimitExceeded(CLIStream)
}

private struct CLIProcessResult: Sendable {
    let stdout: Data
    let stderr: Data
    let terminationStatus: Int32
}

/// Process 没有 Sendable 标注；所有跨线程访问都通过这把锁串行化。
private final class CLIProcessController: @unchecked Sendable {
    private let lock = NSLock()
    private let gracePeriod: TimeInterval
    private var process: Process?
    private var stopReason: CLIStopReason?
    private var finished = false

    init(gracePeriod: TimeInterval) {
        self.gracePeriod = max(0, gracePeriod)
    }

    func register(_ process: Process) {
        lock.lock()
        self.process = process
        let shouldStop = stopReason != nil && !finished
        lock.unlock()
        if shouldStop { beginTermination() }
    }

    func processDidStart() {
        lock.lock()
        let shouldStop = stopReason != nil && !finished
        lock.unlock()
        if shouldStop { beginTermination() }
    }

    var isStopRequested: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopReason != nil
    }

    func requestStop(_ reason: CLIStopReason) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        if stopReason == nil { stopReason = reason }
        let shouldStop = process?.isRunning == true
        lock.unlock()
        if shouldStop { beginTermination() }
    }

    func finish() -> CLIStopReason? {
        lock.lock()
        defer { lock.unlock() }
        finished = true
        return stopReason
    }

    private func beginTermination() {
        lock.lock()
        guard !finished, let process, process.isRunning else {
            lock.unlock()
            return
        }
        let pid = process.processIdentifier
        process.terminate()
        lock.unlock()

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + gracePeriod) { [weak self] in
            self?.forceKillIfStillRunning(pid: pid)
        }
    }

    private func forceKillIfStillRunning(pid: pid_t) {
        lock.lock()
        guard !finished, let process, process.processIdentifier == pid, process.isRunning else {
            lock.unlock()
            return
        }
        lock.unlock()
        _ = Darwin.kill(pid, SIGKILL)
    }
}

/// 两个 pipe 共用一个预算；append/snapshot 可安全地从不同 reader queue 调用。
private final class CLIOutputAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var totalBytes = 0
    private var stdout = Data()
    private var stderr = Data()
    private var readError: String?
    private var didExceedLimit = false

    init(maximumBytes: Int) {
        self.maximumBytes = max(1, maximumBytes)
    }

    /// 只保留预算内的数据；仅第一次越界返回 true。
    func append(_ data: Data, from stream: CLIStream) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !didExceedLimit else { return false }

        let remaining = maximumBytes - totalBytes
        if remaining > 0 {
            let retained = data.prefix(remaining)
            switch stream {
            case .stdout: stdout.append(contentsOf: retained)
            case .stderr: stderr.append(contentsOf: retained)
            }
            totalBytes += retained.count
        }

        if data.count > remaining {
            didExceedLimit = true
            return true
        }
        return false
    }

    func recordReadError(_ error: Error) {
        lock.lock()
        if readError == nil { readError = error.localizedDescription }
        lock.unlock()
    }

    func snapshot() -> (stdout: Data, stderr: Data, readError: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (stdout, stderr, readError)
    }
}

private final class CLIStreamReader: @unchecked Sendable {
    private let handle: FileHandle
    private let stream: CLIStream
    private let accumulator: CLIOutputAccumulator
    private let controller: CLIProcessController

    init(
        handle: FileHandle,
        stream: CLIStream,
        accumulator: CLIOutputAccumulator,
        controller: CLIProcessController
    ) {
        self.handle = handle
        self.stream = stream
        self.accumulator = accumulator
        self.controller = controller
    }

    func drain() {
        do {
            while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                if accumulator.append(chunk, from: stream) {
                    controller.requestStop(.outputLimitExceeded(stream))
                    return
                }
            }
        } catch {
            accumulator.recordReadError(error)
        }
    }

    func close() {
        try? handle.close()
    }
}

private final class CLIExecution: @unchecked Sendable {
    let invocation: CLIInvocation
    let args: [String]
    let policy: CLIExecutionPolicy
    let controller: CLIProcessController

    init(invocation: CLIInvocation, args: [String], policy: CLIExecutionPolicy) {
        self.invocation = invocation
        self.args = args
        self.policy = policy
        self.controller = CLIProcessController(gracePeriod: policy.terminationGracePeriod)
    }

    func cancel() {
        controller.requestStop(.cancelled)
    }

    func run() throws -> CLIProcessResult {
        if controller.isStopRequested { throw CancellationError() }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.launch)
        process.arguments = invocation.prefix + args

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        controller.register(process)

        do {
            try process.run()
        } catch {
            _ = controller.finish()
            throw CLIError(kind: .launchFailed, message: "无法启动 CLI：\(error.localizedDescription)")
        }
        controller.processDidStart()

        let accumulator = CLIOutputAccumulator(maximumBytes: policy.maximumOutputBytes)
        let stdoutReader = CLIStreamReader(
            handle: stdoutPipe.fileHandleForReading,
            stream: .stdout,
            accumulator: accumulator,
            controller: controller)
        let stderrReader = CLIStreamReader(
            handle: stderrPipe.fileHandleForReading,
            stream: .stderr,
            accumulator: accumulator,
            controller: controller)

        let readers = DispatchGroup()
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stdoutReader.drain()
            readers.leave()
        }
        readers.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            stderrReader.drain()
            readers.leave()
        }

        // 取消的 asyncAfter work item 仍可能留在队列到原 deadline；弱引用避免每次成功调用
        // 都额外保留 Process/pipe 120 秒。
        let timeoutWork = DispatchWorkItem { [weak controller] in
            controller?.requestStop(.timedOut)
        }
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + max(0.001, policy.timeout),
            execute: timeoutWork)

        process.waitUntilExit()
        timeoutWork.cancel()

        let drainResult = readers.wait(timeout: .now() + max(0.001, policy.pipeDrainTimeout))
        if drainResult == .timedOut {
            // 后代进程继承 pipe 时 EOF 可能永远不到；主动关闭避免 GUI 永久等待。
            stdoutReader.close()
            stderrReader.close()
        }

        let stopReason = controller.finish()
        let captured = accumulator.snapshot()

        switch stopReason {
        case .cancelled:
            throw CancellationError()
        case .timedOut:
            throw CLIError(
                kind: .timedOut,
                message: "CLI 执行超时（\(formatSeconds(policy.timeout)) 秒），进程已终止")
        case let .outputLimitExceeded(stream):
            throw CLIError(
                kind: .outputLimitExceeded,
                message: "CLI \(stream.rawValue) 输出超过上限（\(policy.maximumOutputBytes) bytes），进程已终止")
        case nil:
            break
        }

        if drainResult == .timedOut {
            throw CLIError(kind: .streamReadFailed, message: "CLI 退出后输出管道未能及时关闭")
        }
        if let readError = captured.readError {
            throw CLIError(kind: .streamReadFailed, message: "读取 CLI 输出失败：\(readError)")
        }

        return CLIProcessResult(
            stdout: captured.stdout,
            stderr: captured.stderr,
            terminationStatus: process.terminationStatus)
    }
}

enum CLI {
    /// 解析出启动程序与固定前缀参数。
    static func resolve() -> CLIInvocation {
        let env = ProcessInfo.processInfo.environment
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("skill-switch-cli").path
            if FileManager.default.isExecutableFile(atPath: bundled) {
                return CLIInvocation(launch: bundled, prefix: [])
            }
        }
        if let cli = env["SKILL_SWITCH_CLI"], !cli.isEmpty {
            return CLIInvocation(launch: cli, prefix: [])
        }
        if let root = env["SKILL_SWITCH_ROOT"], !root.isEmpty {
            return CLIInvocation(
                launch: "/usr/bin/env",
                prefix: ["node", "\(root)/bin/skill-switch.mjs"])
        }
        return CLIInvocation(launch: "/usr/bin/env", prefix: ["skill-switch"])
    }

    /// 跑 CLI 拿原始 stdout。非零但有 stdout 保持历史兼容；调用者需要时再解析内容。
    static func runRaw(_ args: [String]) async throws -> Data {
        try await runRaw(args, invocation: resolve(), policy: .default)
    }

    /// 内部可注入入口，供无 shell 拼接的进程级回归测试使用。
    static func runRaw(
        _ args: [String],
        invocation: CLIInvocation,
        policy: CLIExecutionPolicy
    ) async throws -> Data {
        let result = try await execute(args, invocation: invocation, policy: policy)
        if result.stdout.isEmpty, result.terminationStatus != 0 {
            throw nonZeroError(result)
        }
        return result.stdout
    }

    /// 跑 CLI 并把 JSON 解码成指定类型。
    static func runJSON<T: Decodable>(_ args: [String], as type: T.Type) async throws -> T {
        try await runJSON(args, as: type, invocation: resolve(), policy: .default)
    }

    /// 非零 + 有效 JSON 是 audit 等命令的预期协议；非零 + 无效 JSON 会同时报告退出码与 stderr。
    static func runJSON<T: Decodable>(
        _ args: [String],
        as type: T.Type,
        invocation: CLIInvocation,
        policy: CLIExecutionPolicy
    ) async throws -> T {
        let result = try await execute(args, invocation: invocation, policy: policy)
        if result.stdout.isEmpty, result.terminationStatus != 0 {
            throw nonZeroError(result)
        }
        do {
            return try JSONDecoder().decode(T.self, from: result.stdout)
        } catch {
            let output = safeSnippet(result.stdout, limit: 200)
            let stderr = safeSnippet(result.stderr, limit: 500)
            let status = result.terminationStatus == 0 ? "" : "，退出码 \(result.terminationStatus)"
            let diagnostic = stderr.isEmpty ? "" : "\nstderr: \(stderr)"
            throw CLIError(
                kind: .invalidJSON,
                message: "JSON 解码失败（\(T.self)\(status)）：\(error)\n\(output)\(diagnostic)")
        }
    }

    private static func execute(
        _ args: [String],
        invocation: CLIInvocation,
        policy: CLIExecutionPolicy
    ) async throws -> CLIProcessResult {
        let execution = CLIExecution(invocation: invocation, args: args, policy: policy)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        continuation.resume(returning: try execution.run())
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            execution.cancel()
        }
    }

    private static func nonZeroError(_ result: CLIProcessResult) -> CLIError {
        let stderr = safeSnippet(result.stderr, limit: 2_000)
        let detail = stderr.isEmpty ? "exit \(result.terminationStatus)" : stderr
        return CLIError(
            kind: .nonZeroExit(result.terminationStatus),
            message: "CLI 退出码 \(result.terminationStatus)：\(detail)")
    }

    private static func safeSnippet(_ data: Data, limit: Int) -> String {
        let decoded = String(decoding: data.prefix(limit), as: UTF8.self)
        let sanitized = decoded.unicodeScalars.map { scalar -> String in
            switch scalar.value {
            case 0x0A:
                return String(scalar)
            case 0x00...0x1F, 0x7F...0x9F:
                return String(format: "\\u{%02X}", scalar.value)
            default:
                return String(scalar)
            }
        }.joined()
        return sanitized.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private func formatSeconds(_ seconds: TimeInterval) -> String {
    if seconds.rounded() == seconds { return String(Int(seconds)) }
    return String(format: "%.2f", seconds)
}

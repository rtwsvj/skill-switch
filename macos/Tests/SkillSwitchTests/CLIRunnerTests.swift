import Foundation
import Testing
@testable import SkillSwitch

private struct FixturePayload: Codable, Equatable {
    let ok: Bool
}

private let quickPolicy = CLIExecutionPolicy(
    timeout: 3,
    maximumOutputBytes: 4 * 1024 * 1024,
    terminationGracePeriod: 0.1,
    pipeDrainTimeout: 1)

private func shell(_ script: String) -> CLIInvocation {
    CLIInvocation(launch: "/bin/sh", prefix: ["-c", script, "cli-runner-test"])
}

@Test("stdout and stderr are drained concurrently")
func drainsBothPipesWithoutDeadlock() async throws {
    let script = #"i=0; while [ "$i" -lt 20000 ]; do printf 'stderr-flood-012345678901234567890123456789\n' >&2; i=$((i+1)); done; printf '{"ok":true}\n'"#

    let payload = try await CLI.runJSON(
        [],
        as: FixturePayload.self,
        invocation: shell(script),
        policy: quickPolicy)

    #expect(payload == FixturePayload(ok: true))
}

@Test("hung process times out and escalates past ignored SIGTERM")
func hungProcessTimesOut() async throws {
    var policy = quickPolicy
    policy.timeout = 0.15
    let started = ContinuousClock.now

    do {
        _ = try await CLI.runRaw(
            [],
            invocation: shell("trap '' TERM; while :; do :; done"),
            policy: policy)
        Issue.record("expected timeout")
    } catch let error as CLIError {
        #expect(error.kind == .timedOut)
    }

    #expect(started.duration(to: .now) < .seconds(2))
}

@Test("task cancellation terminates the child")
func cancellationTerminatesChild() async throws {
    var policy = quickPolicy
    policy.timeout = 30
    let started = ContinuousClock.now
    let task = Task {
        try await CLI.runRaw(
            [],
            invocation: shell("trap '' TERM; while :; do :; done"),
            policy: policy)
    }

    try await Task.sleep(for: .milliseconds(100))
    task.cancel()

    do {
        _ = try await task.value
        Issue.record("expected cancellation")
    } catch is CancellationError {
        // expected
    }
    #expect(started.duration(to: .now) < .seconds(2))
}

@Test("nonzero exit with valid JSON remains compatible")
func nonZeroWithValidJSONIsAccepted() async throws {
    let payload = try await CLI.runJSON(
        [],
        as: FixturePayload.self,
        invocation: shell("printf '{\"ok\":true}'; printf 'audit found issues' >&2; exit 7"),
        policy: quickPolicy)

    #expect(payload.ok)
}

@Test("nonzero malformed JSON reports status and stderr")
func nonZeroMalformedJSONIsDiagnostic() async throws {
    do {
        _ = try await CLI.runJSON(
            [],
            as: FixturePayload.self,
            invocation: shell("printf 'not-json'; printf 'fixture-stderr' >&2; exit 7"),
            policy: quickPolicy)
        Issue.record("expected JSON failure")
    } catch let error as CLIError {
        #expect(error.kind == .invalidJSON)
        #expect(error.message.contains("退出码 7"))
        #expect(error.message.contains("fixture-stderr"))
    }
}

@Test("nonzero exit without stdout is an execution failure")
func nonZeroWithoutStdoutFails() async throws {
    do {
        _ = try await CLI.runRaw(
            [],
            invocation: shell("printf 'failed' >&2; exit 9"),
            policy: quickPolicy)
        Issue.record("expected exit failure")
    } catch let error as CLIError {
        #expect(error.kind == .nonZeroExit(9))
        #expect(error.message.contains("failed"))
    }
}

@Test("combined output is capped")
func outputLimitTerminatesChild() async throws {
    var policy = quickPolicy
    policy.maximumOutputBytes = 32 * 1024

    do {
        _ = try await CLI.runRaw(
            [],
            invocation: shell("while :; do printf '0123456789012345678901234567890123456789'; done"),
            policy: policy)
        Issue.record("expected output cap")
    } catch let error as CLIError {
        #expect(error.kind == .outputLimitExceeded)
    }
}

@Test("diagnostics neutralize terminal control characters")
func diagnosticsSanitizeControls() async throws {
    do {
        _ = try await CLI.runRaw(
            [],
            invocation: shell("printf '\\033]52;c;payload\\007\\rrewrite\\t\\302\\233' >&2; exit 3"),
            policy: quickPolicy)
        Issue.record("expected exit failure")
    } catch let error as CLIError {
        #expect(!error.message.contains("\u{001B}"))
        #expect(error.message.contains("\\u{1B}"))
        #expect(error.message.contains("\\u{07}"))
        #expect(error.message.contains("\\u{0D}"))
        #expect(error.message.contains("\\u{09}"))
        #expect(error.message.contains("\\u{9B}"))
    }
}

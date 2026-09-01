import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch


SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR))

from prewalk import (  # noqa: E402
    ApprovalBroker,
    AppServerClient,
    HandoffController,
    PrewalkBusyError,
    build_bootstrap_prompt,
    build_executor_prompt,
    completed_file_change,
    choose_approval_input,
    parse_json_line,
    parse_args,
    acquire_pre_walk_lock,
    resolve_codex_command,
)


def checklist_message(text="1. Inspect the code and validate the relevant behavior."):
    return {
        "method": "item/completed",
        "params": {"item": {"type": "plan", "text": text}},
    }


class HandoffControllerTests(unittest.TestCase):
    def test_handoff_requires_checklist_and_completed_file_change(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )

        controller.observe_message(checklist_message())
        self.assertIsNone(controller.observe_text("[PREWALK_READY]\n"))
        action = controller.observe_message(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "fileChange",
                        "status": "completed",
                        "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x"}],
                    }
                },
            }
        )

        self.assertEqual(action, "request_interrupt")
        self.assertTrue(controller.handoff_requested)
        self.assertIsNone(controller.observe_message({"method": "item/completed", "params": {}}))

    def test_failed_file_change_does_not_trigger_handoff(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )
        controller.observe_message(checklist_message())
        controller.observe_text("[PREWALK_READY]\n")

        action = controller.observe_message(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "fileChange",
                        "status": "failed",
                        "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x"}],
                    }
                },
            }
        )

        self.assertIsNone(action)
        self.assertFalse(controller.handoff_requested)

    def test_marker_after_file_change_still_triggers_once(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )
        controller.observe_message(checklist_message())
        file_change = {
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x"}],
                }
            },
        }

        self.assertIsNone(controller.observe_message(file_change))
        self.assertEqual(controller.observe_text("plan\n[PREWALK_READY]\n"), "request_interrupt")
        self.assertIsNone(controller.observe_text("[PREWALK_READY]\n"))

    def test_embedded_marker_does_not_mark_checklist_ready(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )
        controller.observe_message(checklist_message())

        self.assertIsNone(controller.observe_text("The marker [PREWALK_READY] is reserved.\n"))
        self.assertFalse(controller.marker_seen)

    def test_agent_message_checklist_can_enable_marker(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )

        controller.observe_text("1. Inspect the code and validate the relevant behavior.\n")
        self.assertFalse(controller.checklist_ready)
        controller.observe_text("[PREWALK_READY]\n")
        self.assertTrue(controller.checklist_ready)

    def test_checklist_requires_validation_in_every_numbered_item(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )

        controller.observe_message(
            checklist_message(
                "1. Inspect the code and validate the relevant behavior.\n"
                "2. Apply the smallest useful change."
            )
        )
        controller.observe_text("[PREWALK_READY]\n")
        action = controller.observe_message(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "fileChange",
                        "status": "completed",
                        "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x"}],
                    }
                },
            }
        )

        self.assertFalse(controller.checklist_ready)
        self.assertFalse(controller.marker_seen)
        self.assertIsNone(action)

    def test_partial_marker_before_checklist_is_discarded(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )

        controller.observe_text("[PREWALK_READY]")
        controller.observe_message(checklist_message())
        controller.observe_text("\n")
        self.assertFalse(controller.marker_seen)

        controller.observe_text("[PREWALK_READY]\n")
        self.assertTrue(controller.marker_seen)

    def test_incomplete_marker_is_not_accepted(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )
        controller.observe_message(checklist_message())

        controller.observe_text("[PREWALK_READY]")

        self.assertFalse(controller.marker_seen)

    def test_marker_before_checklist_is_ignored(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )

        controller.observe_text("[PREWALK_READY]\n")
        controller.observe_message(checklist_message())
        controller.observe_message(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "fileChange",
                        "status": "completed",
                        "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x"}],
                    }
                },
            }
        )

        self.assertFalse(controller.marker_seen)
        self.assertFalse(controller.handoff_requested)

    def test_turn_completion_without_edit_does_not_handoff(self):
        controller = HandoffController(
            thread_id="thread-1",
            turn_id="turn-1",
            executor_model="fast-model",
        )
        controller.observe_message(checklist_message())
        controller.observe_text("[PREWALK_READY]\n")

        action = controller.observe_message(
            {
                "method": "turn/completed",
                "params": {"turn": {"id": "turn-1", "status": "completed"}},
            }
        )

        self.assertIsNone(action)
        self.assertFalse(controller.handoff_requested)


class EventAndPromptTests(unittest.TestCase):
    def test_completed_file_change_requires_nonempty_changes(self):
        message = {
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [{"path": "README.md", "kind": "update", "diff": ""}],
                }
            },
        }
        self.assertFalse(completed_file_change(message))

        message["params"]["item"]["changes"][0]["diff"] = "+line\n"
        self.assertTrue(completed_file_change(message))

    def test_json_line_parser_rejects_non_objects(self):
        self.assertEqual(parse_json_line('{"method":"ping"}')['method'], "ping")
        with self.assertRaises(ValueError):
            parse_json_line("[]")

    def test_prompts_include_task_and_handoff_boundary(self):
        bootstrap = build_bootstrap_prompt("Fix the login test", max_checklist_items=8)
        self.assertEqual(bootstrap, "Fix the login test")

        executor = build_executor_prompt()
        self.assertIn("opening phase is complete", executor.lower())
        self.assertIn("Do not restart planning", executor)

    def test_approval_input_uses_terminal_when_task_input_is_piped(self):
        task_input = StringIO("task from heredoc")
        terminal_input = StringIO("y\n")
        terminal_input.isatty = lambda: True

        selected = choose_approval_input(task_input, lambda: terminal_input)

        self.assertIs(selected, terminal_input)

    def test_default_models_and_efforts(self):
        with patch.dict(os.environ, {}, clear=True):
            args = parse_args([])

        self.assertEqual(args.guide_model, "gpt-5.6-sol")
        self.assertEqual(args.guide_effort, "medium")
        self.assertEqual(args.executor_model, "gpt-5.6-luna")
        self.assertEqual(args.executor_effort, "max")
        self.assertFalse(args.auto_approve_workspace_writes)

    def test_scoped_workspace_write_mode_is_explicit_and_bounded(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_stream = StringIO()
            broker = ApprovalBroker(
                input_stream=StringIO(),
                output_stream=output_stream,
                auto_approve_workspace_writes=True,
                writable_root=root,
            )

            accepted = broker.response(
                "item/fileChange/requestApproval",
                {"grantRoot": str(root)},
                item={"changes": [{"path": "src/app.ts", "diff": "+safe change"}]},
            )
            rejected = broker.response(
                "item/fileChange/requestApproval",
                {"grantRoot": str(root)},
                item={"changes": [{"path": "../outside.ts", "diff": "+unsafe change"}]},
            )
            escaped_grant_root = broker.response(
                "item/fileChange/requestApproval",
                {"grantRoot": str(root.parent / "outside")},
                item={"changes": [{"path": "src/app.ts", "diff": "+unsafe change"}]},
            )
            command = broker.response(
                "item/commandExecution/requestApproval",
                {"command": "npm test"},
            )
            user_input = broker.response("item/tool/requestUserInput", {"questions": []})

        self.assertEqual(accepted, {"decision": "accept"})
        self.assertEqual(rejected, {"decision": "decline"})
        self.assertEqual(escaped_grant_root, {"decision": "decline"})
        self.assertEqual(command, {"decision": "decline"})
        self.assertEqual(user_input, {"answers": {}})
        self.assertIn("auto-approved scoped workspace write", output_stream.getvalue())
        self.assertIn("declined write outside the scoped workspace", output_stream.getvalue())

    def test_scoped_workspace_write_mode_requires_explicit_flag(self):
        args = parse_args(["--auto-approve-workspace-writes"])

        self.assertTrue(args.auto_approve_workspace_writes)

    def test_user_input_request_returns_answers(self):
        input_stream = StringIO("backend\n")
        input_stream.isatty = lambda: True
        output_stream = StringIO()
        broker = ApprovalBroker(input_stream=input_stream, output_stream=output_stream)

        result = broker.response(
            "item/tool/requestUserInput",
            {
                "questions": [
                    {
                        "header": "Scope",
                        "id": "scope",
                        "question": "Which scope should be changed?",
                        "options": [{"label": "backend", "description": "Server code"}],
                    }
                ]
            },
        )

        self.assertEqual(result, {"answers": {"scope": {"answers": ["backend"]}}})
        self.assertIn("Which scope should be changed?", output_stream.getvalue())

    def test_noninteractive_user_input_request_returns_empty_answers(self):
        input_stream = StringIO()
        input_stream.isatty = lambda: False
        output_stream = StringIO()
        broker = ApprovalBroker(input_stream=input_stream, output_stream=output_stream)

        result = broker.response(
            "item/tool/requestUserInput",
            {"questions": [{"id": "scope", "header": "Scope", "question": "Choose scope"}]},
        )

        self.assertEqual(result, {"answers": {}})
        self.assertIn("Declining user input", output_stream.getvalue())


class StartupReliabilityTests(unittest.TestCase):
    def make_fake_codex(self, directory, behavior):
        script = directory / "fake-codex"
        script.write_text(
            "#!/usr/bin/env python3\n"
            "import json\n"
            "import pathlib\n"
            "import sys\n"
            "\n"
            f"state = pathlib.Path({str(directory / 'attempts')!r})\n"
            "attempt = int(state.read_text() or '0') + 1 if state.exists() else 1\n"
            "state.write_text(str(attempt))\n"
            f"{behavior}\n"
        )
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        return script

    def test_startup_retries_transient_app_server_exit_and_preserves_stderr(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            script = self.make_fake_codex(
                directory,
                "if attempt == 1:\n"
                "    print('PATH alias setup failed', file=sys.stderr, flush=True)\n"
                "    raise SystemExit(1)\n"
                "for line in sys.stdin:\n"
                "    message = json.loads(line)\n"
                "    print(json.dumps({'id': message['id'], 'result': {'ready': True}}), flush=True)\n",
            )
            client = AppServerClient(
                str(script),
                directory,
                ApprovalBroker(input_stream=StringIO(), output_stream=StringIO()),
            )

            try:
                with patch("sys.stderr", new_callable=StringIO) as stderr:
                    result = client.start_with_retry(
                        {"method": "initialize"}, retry_delays=(0,)
                    )
            finally:
                client.close()

            self.assertEqual(result, {"ready": True})
            self.assertEqual((directory / "attempts").read_text(), "2")
            self.assertIn("PATH alias setup failed", stderr.getvalue())

    def test_exhausted_startup_retries_raise_with_child_stderr(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            script = self.make_fake_codex(
                directory,
                "print('sqlite state runtime unavailable', file=sys.stderr, flush=True)\n"
                "raise SystemExit(1)",
            )
            client = AppServerClient(
                str(script),
                directory,
                ApprovalBroker(input_stream=StringIO(), output_stream=StringIO()),
            )

            with patch("sys.stderr", new_callable=StringIO) as stderr:
                with self.assertRaisesRegex(RuntimeError, "sqlite state runtime unavailable"):
                    client.start_with_retry({"method": "initialize"}, retry_delays=(0, 0, 0))

            client.close()
            self.assertEqual((directory / "attempts").read_text(), "4")
            self.assertEqual(stderr.getvalue().count("retrying"), 3)

    def test_codex_command_is_resolved_to_absolute_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            executable = directory / "codex"
            executable.write_text("#!/bin/sh\n")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
            with patch.dict(os.environ, {"PATH": temp_dir}, clear=False):
                self.assertEqual(resolve_codex_command("codex"), str(executable))

    def test_only_one_pre_walk_can_hold_the_startup_lock(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            lock_path = Path(temp_dir) / "prewalk.lock"
            with acquire_pre_walk_lock(lock_path):
                with self.assertRaises(PrewalkBusyError):
                    with acquire_pre_walk_lock(lock_path):
                        pass

    def test_file_approval_shows_change_context(self):
        input_stream = StringIO("y\n")
        input_stream.isatty = lambda: True
        output_stream = StringIO()
        broker = ApprovalBroker(input_stream=input_stream, output_stream=output_stream)

        result = broker.response(
            "item/fileChange/requestApproval",
            {"itemId": "item-1", "reason": "Apply the requested fix"},
            item={
                "type": "fileChange",
                "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+safe change\n"}],
            },
        )

        self.assertEqual(result, {"decision": "accept"})
        prompt = output_stream.getvalue()
        self.assertIn("src/app.ts", prompt)
        self.assertIn("+safe change", prompt)

    def test_network_approval_shows_destination(self):
        input_stream = StringIO("n\n")
        input_stream.isatty = lambda: True
        output_stream = StringIO()
        broker = ApprovalBroker(input_stream=input_stream, output_stream=output_stream)

        result = broker.response(
            "item/commandExecution/requestApproval",
            {
                "itemId": "item-2",
                "command": "curl https://example.com",
                "cwd": "/tmp/prewalk",
                "reason": "Fetch the remote fixture",
                "networkApprovalContext": {"host": "example.com", "protocol": "https"},
            },
        )

        self.assertEqual(result, {"decision": "decline"})
        prompt = output_stream.getvalue()
        self.assertIn("example.com", prompt)
        self.assertIn("https", prompt)
        self.assertIn("curl https://example.com", prompt)
        self.assertIn("/tmp/prewalk", prompt)
        self.assertIn("Fetch the remote fixture", prompt)


class CliSmokeTests(unittest.TestCase):
    def test_help_does_not_start_the_agent_server(self):
        script = SKILL_DIR / "scripts" / "run-prewalk"
        result = subprocess.run(
            [sys.executable, str(script), "--help"],
            check=False,
            capture_output=True,
            text=True,
            env={**os.environ, "PREWALK_TEST_MODE": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("guide-model", result.stdout)

    def test_runner_hands_off_to_executor_on_same_thread(self):
        fake_server = """#!/usr/bin/env python3
import json
import os
import sys

log_path = os.environ["FAKE_PREWALK_LOG"]
turn_number = 0

def emit(message):
    print(json.dumps(message), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps(message) + "\\n")
    method = message.get("method")
    if method == "initialize":
        emit({"id": message["id"], "result": {}})
    elif method == "thread/start":
        emit({"id": message["id"], "result": {"thread": {"id": "thread-1"}}})
    elif method == "turn/start":
        turn_number += 1
        turn_id = f"turn-{turn_number}"
        if turn_number == 1:
            emit({"method": "item/completed", "params": {"item": {
                "type": "plan", "text": "1. Inspect the code and validate the relevant behavior."
            }}})
            emit({"method": "item/agentMessage/delta", "params": {"delta": "[PREWALK_READY]\\n"}})
            emit({"method": "item/completed", "params": {"item": {
                "type": "fileChange", "status": "completed",
                "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x\\n"}]
            }}})
            emit({"id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
        else:
            emit({"id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
            emit({"method": "turn/completed", "params": {"turn": {"id": turn_id, "status": "completed"}}})
    elif method == "turn/interrupt":
        if message["params"].get("turnId") != "turn-1":
            emit({"id": message["id"], "error": {"code": -32000, "message": "wrong turn id"}})
            emit({"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}})
        else:
            emit({"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "interrupted"}}})
            emit({"id": message["id"], "result": {}})
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_command = root / "fake-codex"
            fake_command.write_text(fake_server, encoding="utf-8")
            fake_command.chmod(0o755)
            log_path = root / "requests.jsonl"
            script = SKILL_DIR / "scripts" / "run-prewalk"
            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--prompt-stdin",
                    "--guide-model",
                    "guide-model",
                    "--executor-model",
                    "executor-model",
                    "--codex-command",
                    str(fake_command),
                    "--cwd",
                    str(root),
                ],
                input="Fix the task",
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "FAKE_PREWALK_LOG": str(log_path)},
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("switching models", result.stderr)
            requests = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
            initialize = next(request for request in requests if request.get("method") == "initialize")
            self.assertTrue(initialize["params"]["capabilities"]["experimentalApi"])
            turn_starts = [request for request in requests if request.get("method") == "turn/start"]
            self.assertEqual([request["params"]["threadId"] for request in turn_starts], ["thread-1", "thread-1"])
            guide_settings = turn_starts[0]["params"]["collaborationMode"]["settings"]
            self.assertEqual(turn_starts[0]["params"]["input"], [{"type": "text", "text": "Fix the task"}])
            self.assertEqual(turn_starts[0]["params"]["collaborationMode"]["mode"], "default")
            self.assertEqual(guide_settings["model"], "guide-model")
            self.assertEqual(guide_settings["reasoning_effort"], "medium")
            self.assertIn("Opening phase instructions", guide_settings["developer_instructions"])
            self.assertIn("8", guide_settings["developer_instructions"])
            executor_settings = turn_starts[1]["params"]["collaborationMode"]["settings"]
            self.assertEqual(turn_starts[1]["params"]["collaborationMode"]["mode"], "default")
            self.assertEqual(executor_settings["model"], "executor-model")
            self.assertEqual(executor_settings["reasoning_effort"], "max")
            self.assertIsNone(executor_settings["developer_instructions"])
            self.assertEqual(turn_starts[1]["params"]["input"], [{"type": "text", "text": "The opening phase is complete. Continue from the existing checklist,\nconversation context, and working tree. Do not restart planning. Inspect the\ncurrent diff, run the relevant validation, fix any failures, and finish the task.\n"}])
            summary_lines = [line for line in result.stderr.splitlines() if line.startswith("[prewalk] summary ")]
            self.assertEqual(len(summary_lines), 1)
            summary = json.loads(summary_lines[0].removeprefix("[prewalk] summary "))
            self.assertTrue(summary["checklist_ready"])
            self.assertTrue(summary["handoff_triggered"])
            self.assertTrue(summary["interrupt_confirmed"])
            self.assertTrue(summary["executor_started"])
            self.assertEqual(summary["executor_model"], "executor-model")
            self.assertEqual(summary["final_status"], "completed")

    def test_failed_interrupt_does_not_start_executor(self):
        fake_server = """#!/usr/bin/env python3
import json
import os
import sys

log_path = os.environ["FAKE_PREWALK_LOG"]
turn_number = 0

def emit(message):
    print(json.dumps(message), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps(message) + "\\n")
    method = message.get("method")
    if method == "initialize":
        emit({"id": message["id"], "result": {}})
    elif method == "thread/start":
        emit({"id": message["id"], "result": {"thread": {"id": "thread-1"}}})
    elif method == "turn/start":
        turn_number += 1
        turn_id = f"turn-{turn_number}"
        emit({"id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
        emit({"method": "item/completed", "params": {"item": {
            "type": "plan", "text": "1. Inspect the code and validate the relevant behavior."
        }}})
        emit({"method": "item/agentMessage/delta", "params": {"delta": "[PREWALK_READY]\\n"}})
        emit({"method": "item/completed", "params": {"item": {
            "type": "fileChange", "status": "completed",
            "changes": [{"path": "src/app.ts", "kind": "update", "diff": "+x\\n"}]
        }}})
        if turn_number > 1:
            emit({"method": "turn/completed", "params": {"turn": {"id": turn_id, "status": "completed"}}})
    elif method == "turn/interrupt":
        emit({"id": message["id"], "error": {"code": -32000, "message": "interrupt rejected"}})
        emit({"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "completed"}}})
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_command = root / "fake-codex"
            fake_command.write_text(fake_server, encoding="utf-8")
            fake_command.chmod(0o755)
            log_path = root / "requests.jsonl"
            script = SKILL_DIR / "scripts" / "run-prewalk"
            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--prompt-stdin",
                    "--guide-model",
                    "guide-model",
                    "--executor-model",
                    "executor-model",
                    "--codex-command",
                    str(fake_command),
                    "--cwd",
                    str(root),
                ],
                input="Fix the task",
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "FAKE_PREWALK_LOG": str(log_path)},
            )

            self.assertEqual(result.returncode, 1, result.stderr)
            requests = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
            turn_starts = [request for request in requests if request.get("method") == "turn/start"]
            self.assertEqual(len(turn_starts), 1)
            self.assertIn("interrupt rejected", result.stderr)
            summary_lines = [line for line in result.stderr.splitlines() if line.startswith("[prewalk] summary ")]
            summary = json.loads(summary_lines[0].removeprefix("[prewalk] summary "))
            self.assertFalse(summary["interrupt_confirmed"])
            self.assertTrue(summary["handoff_triggered"])
            self.assertFalse(summary["executor_started"])
            self.assertEqual(summary["final_status"], "completed")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Run a two-model coding session with a first-edit handoff."""

from __future__ import annotations

import argparse
import contextlib
import errno
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, TextIO


READY_MARKER = "[PREWALK_READY]"
MAX_APPROVAL_CONTEXT = 4000
CHECKLIST_ITEM_RE = re.compile(r"^(\d+)[.)]\s+(\S.*)$")
VALIDATION_RE = re.compile(
    r"\b(?:validat\w*|test\w*|verif\w*|assert\w*|check\w*|confirm\w*)\b",
    re.IGNORECASE,
)
STARTUP_RETRY_DELAYS = (0.5, 1.5, 3.0)


class PrewalkBusyError(RuntimeError):
    """Raised when another prewalk runner already owns the startup lock."""


class AppServerStartupError(RuntimeError):
    """Raised when the app-server exits before answering a request."""


def resolve_codex_command(command: str) -> str:
    """Resolve PATH commands once so child startup is deterministic."""
    if os.path.sep in command or (os.path.altsep and os.path.altsep in command):
        return command
    return shutil.which(command) or command


@contextlib.contextmanager
def acquire_pre_walk_lock(lock_path: Path | None = None):
    """Allow only one prewalk process to initialize Codex at a time."""
    if lock_path is None:
        lock_path = Path(tempfile.gettempdir()) / f"codex-prewalk-{os.getuid()}.lock"
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EAGAIN):
                raise
            raise PrewalkBusyError(
                f"another prewalk runner is already active (lock: {lock_path})"
            ) from exc
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def parse_json_line(line: str) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON from app-server: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("app-server message must be a JSON object")
    return value


def completed_file_change(message: dict[str, Any]) -> bool:
    if message.get("method") != "item/completed":
        return False
    item = message.get("params", {}).get("item", {})
    if not isinstance(item, dict):
        return False
    if item.get("type") != "fileChange" or item.get("status") != "completed":
        return False
    changes = item.get("changes")
    if not isinstance(changes, list):
        return False
    return any(isinstance(change, dict) and bool(change.get("diff")) for change in changes)


def message_text(message: dict[str, Any]) -> str:
    method = message.get("method")
    params = message.get("params", {})
    if method == "item/agentMessage/delta":
        return str(params.get("delta", ""))
    if method != "item/completed":
        return ""
    item = params.get("item", {})
    if not isinstance(item, dict):
        return ""
    if item.get("type") in {"agentMessage", "plan"}:
        return str(item.get("text", ""))
    return ""


def build_bootstrap_prompt(task: str, max_checklist_items: int) -> str:
    del max_checklist_items
    return task.strip()


def build_guide_instructions(max_checklist_items: int) -> str:
    return f"""Opening phase instructions:

Explore the task deeply before editing. Create no more than {max_checklist_items}
sequentially numbered checklist items, and include a validation step in every
item. After the checklist, emit the exact marker {READY_MARKER} on its own line.
Then make the smallest useful first edit and continue working normally. This
instruction applies only to the opening phase.
"""


def build_collaboration_mode(
    model: str,
    effort: str,
    developer_instructions: str | None,
) -> dict[str, Any]:
    return {
        "mode": "default",
        "settings": {
            "model": model,
            "reasoning_effort": effort,
            "developer_instructions": developer_instructions,
        },
    }


def build_executor_prompt() -> str:
    return """The opening phase is complete. Continue from the existing checklist,
conversation context, and working tree. Do not restart planning. Inspect the
current diff, run the relevant validation, fix any failures, and finish the task.
"""


def choose_approval_input(
    input_stream: TextIO,
    terminal_opener: Callable[[], TextIO] | None = None,
) -> TextIO:
    """Use the task stream when interactive, otherwise fall back to the terminal."""
    if input_stream.isatty():
        return input_stream
    if terminal_opener is None:
        terminal_opener = lambda: open("/dev/tty", "r")
    try:
        return terminal_opener()
    except OSError:
        return input_stream


@dataclass
class HandoffController:
    thread_id: str
    turn_id: str
    executor_model: str
    checklist_ready: bool = False
    file_change_seen: bool = False
    handoff_requested: bool = False
    marker_seen: bool = False
    _marker_buffer: str = ""
    _checklist_buffer: str = ""

    def _maybe_request(self) -> str | None:
        if self.checklist_ready and self.marker_seen and self.file_change_seen and not self.handoff_requested:
            self.handoff_requested = True
            return "request_interrupt"
        return None

    @staticmethod
    def _checklist_is_valid(text: str) -> bool:
        items: list[tuple[int, list[str]]] = []
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            match = CHECKLIST_ITEM_RE.match(line)
            if match:
                items.append((int(match.group(1)), [match.group(2)]))
            elif items:
                items[-1][1].append(line)

        if not items or [number for number, _ in items] != list(range(1, len(items) + 1)):
            return False
        return all(VALIDATION_RE.search(" ".join(content)) for _, content in items)

    def _record_checklist(self, text: str) -> None:
        if self._checklist_is_valid(text):
            self.checklist_ready = True

    def observe_checklist(self, text: str) -> str | None:
        self._record_checklist(text)
        if self.checklist_ready:
            # A marker fragment received before the authoritative plan item is stale.
            self._marker_buffer = ""
        return self._maybe_request()

    def observe_text(self, text: str) -> str | None:
        self._marker_buffer += text
        complete_lines = self._marker_buffer.splitlines(keepends=True)
        self._marker_buffer = ""
        for line in complete_lines:
            if line.endswith(("\n", "\r")):
                if line.strip() == READY_MARKER:
                    if not self.checklist_ready and self._checklist_is_valid(self._checklist_buffer):
                        self.checklist_ready = True
                    if self.checklist_ready:
                        self.marker_seen = True
                elif not self.checklist_ready:
                    self._checklist_buffer += line
            else:
                self._marker_buffer = line
        return self._maybe_request()

    def observe_message(self, message: dict[str, Any]) -> str | None:
        if completed_file_change(message):
            self.file_change_seen = True
        item = message.get("params", {}).get("item", {})
        if message.get("method") == "item/completed" and isinstance(item, dict) and item.get("type") == "plan":
            return self.observe_checklist(str(item.get("text", "")))
        if message.get("method") == "item/agentMessage/delta":
            return self.observe_text(message_text(message))
        return self._maybe_request()


class ApprovalBroker:
    def __init__(
        self,
        input_stream: TextIO | None = None,
        output_stream: TextIO | None = None,
        *,
        auto_approve_workspace_writes: bool = False,
        writable_root: Path | None = None,
    ):
        self.input_stream = choose_approval_input(input_stream or sys.stdin)
        self.output_stream = output_stream or sys.stderr
        self.auto_approve_workspace_writes = auto_approve_workspace_writes
        self.writable_root = writable_root.expanduser().resolve() if writable_root else None

    def _is_within_writable_root(self, value: Any) -> bool:
        if self.writable_root is None or not isinstance(value, str) or not value:
            return False
        path = Path(value).expanduser()
        candidate = (path if path.is_absolute() else self.writable_root / path).resolve()
        try:
            candidate.relative_to(self.writable_root)
        except ValueError:
            return False
        return True

    def _can_auto_approve_file_change(self, params: dict[str, Any], item: dict[str, Any] | None) -> bool:
        if not self.auto_approve_workspace_writes:
            return False
        if not self._is_within_writable_root(params.get("grantRoot")):
            return False
        changes = item.get("changes") if isinstance(item, dict) else None
        return bool(changes) and isinstance(changes, list) and all(
            isinstance(change, dict) and self._is_within_writable_root(change.get("path"))
            for change in changes
        )

    def _ask(self, prompt: str) -> bool:
        if not self.input_stream.isatty():
            print(f"Declining approval because stdin is not interactive: {prompt}", file=self.output_stream)
            return False
        print(f"{prompt} [y/N] ", end="", file=self.output_stream, flush=True)
        return self.input_stream.readline().strip().lower() in {"y", "yes"}

    def _ask_text(self, prompt: str) -> str | None:
        if not self.input_stream.isatty():
            print(f"Declining user input because stdin is not interactive: {prompt}", file=self.output_stream)
            return None
        print(f"{prompt}\nAnswer: ", end="", file=self.output_stream, flush=True)
        answer = self.input_stream.readline()
        if answer == "":
            return None
        return answer.rstrip("\r\n")

    @staticmethod
    def _clip(value: Any, limit: int = MAX_APPROVAL_CONTEXT) -> str:
        text = str(value or "")
        if len(text) <= limit:
            return text
        return f"{text[:limit]}\n… [truncated]"

    def _file_change_prompt(self, params: dict[str, Any], item: dict[str, Any] | None) -> str:
        item_id = params.get("itemId", "unknown")
        details = [f"Accept file change {item_id}?"]
        if params.get("reason"):
            details.append(f"Reason: {params['reason']}")
        if params.get("grantRoot"):
            details.append(f"Requested write root: {params['grantRoot']}")
        changes = item.get("changes") if isinstance(item, dict) else None
        if isinstance(changes, list) and changes:
            for change in changes:
                if not isinstance(change, dict):
                    continue
                path = change.get("path", "unknown path")
                kind = change.get("kind", "change")
                diff = self._clip(change.get("diff", ""))
                details.append(f"{kind}: {path}\n{diff or '[diff unavailable]'}")
        else:
            details.append("Change details unavailable; verify the working tree before accepting.")
        return "\n".join(details)

    def _command_prompt(self, params: dict[str, Any]) -> str:
        command = params.get("command") or "command unavailable"
        details = [f"Run command: {command}"]
        if params.get("cwd"):
            details.append(f"Working directory: {params['cwd']}")
        network = params.get("networkApprovalContext")
        if isinstance(network, dict) and network.get("host") and network.get("protocol"):
            details.append(f"Network destination: {network['protocol']}://{network['host']}")
        if params.get("reason"):
            details.append(f"Reason: {params['reason']}")
        return "\n".join(details)

    def _user_input_response(self, params: dict[str, Any]) -> dict[str, Any]:
        answers: dict[str, dict[str, list[str]]] = {}
        questions = params.get("questions", [])
        if not self.input_stream.isatty():
            print("Declining user input because stdin is not interactive.", file=self.output_stream)
            return {"answers": answers}
        for question in questions:
            if not isinstance(question, dict) or not question.get("id"):
                continue
            options = question.get("options")
            option_text = ""
            if isinstance(options, list) and options:
                rendered = [
                    f"- {option.get('label', 'option')}: {option.get('description', '')}"
                    for option in options
                    if isinstance(option, dict)
                ]
                option_text = "\nOptions:\n" + "\n".join(rendered)
            prompt = f"{question.get('header', 'Question')}: {question.get('question', '')}{option_text}"
            answer = self._ask_text(prompt)
            if answer is None:
                return {"answers": answers}
            answers[str(question["id"])] = {"answers": [answer]}
        return {"answers": answers}

    def response(
        self,
        method: str,
        params: dict[str, Any],
        item: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if method == "item/fileChange/requestApproval":
            if self.auto_approve_workspace_writes:
                accepted = self._can_auto_approve_file_change(params, item)
                message = "auto-approved scoped workspace write" if accepted else "declined write outside the scoped workspace"
                print(f"[prewalk] {message}.", file=self.output_stream, flush=True)
                return {"decision": "accept" if accepted else "decline"}
            return {"decision": "accept" if self._ask(self._file_change_prompt(params, item)) else "decline"}
        if method == "item/commandExecution/requestApproval":
            if self.auto_approve_workspace_writes:
                print("[prewalk] declined command approval in non-interactive workspace-write mode.", file=self.output_stream, flush=True)
                return {"decision": "decline"}
            return {"decision": "accept" if self._ask(self._command_prompt(params)) else "decline"}
        if method == "item/permissions/requestApproval":
            return {"permissions": []}
        if method == "item/tool/requestUserInput":
            if self.auto_approve_workspace_writes:
                print("[prewalk] declined interactive input request in non-interactive workspace-write mode.", file=self.output_stream, flush=True)
                return {"answers": {}}
            return self._user_input_response(params)
        if method == "mcpServer/elicitation/request":
            return {"action": "decline", "content": None}
        raise RuntimeError(f"unsupported app-server request: {method}")


class AppServerClient:
    def __init__(self, executable: str, cwd: Path, broker: ApprovalBroker, verbose: bool = False):
        self.executable = resolve_codex_command(executable)
        self.cwd = cwd
        self.broker = broker
        self.verbose = verbose
        self.process: subprocess.Popen[str] | None = None
        self._stderr_chunks: list[str] = []
        self._stderr_thread: threading.Thread | None = None
        self._next_id = 1
        self._responses: dict[int, dict[str, Any]] = {}
        self._items: dict[str, dict[str, Any]] = {}

    def start(self) -> None:
        if self.process is not None:
            raise RuntimeError("app-server is already running")
        self._stderr_chunks = []
        self.process = subprocess.Popen(
            [self.executable, "app-server", "--stdio"],
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._stderr_thread = threading.Thread(
            target=self._collect_stderr,
            args=(self.process,),
            name="prewalk-app-server-stderr",
            daemon=True,
        )
        self._stderr_thread.start()

    def _collect_stderr(self, process: subprocess.Popen[str]) -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            self._stderr_chunks.append(line)

    def _stderr_text(self) -> str:
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=0.2)
        return "".join(self._stderr_chunks).strip()

    def start_with_retry(
        self,
        initialize_params: dict[str, Any],
        retry_delays: tuple[float, ...] = STARTUP_RETRY_DELAYS,
    ) -> dict[str, Any]:
        """Start and initialize the child, retrying failures before protocol startup."""
        last_error: AppServerStartupError | None = None
        for attempt in range(len(retry_delays) + 1):
            try:
                self.start()
                return self.request("initialize", initialize_params)
            except AppServerStartupError as exc:
                last_error = exc
                self.close()
                if attempt == len(retry_delays):
                    raise
                delay = retry_delays[attempt]
                print(
                    f"[prewalk] app-server startup failed (attempt {attempt + 1}); "
                    f"retrying in {delay:g}s: {exc}",
                    file=sys.stderr,
                )
                time.sleep(delay)
        raise last_error or RuntimeError("app-server startup failed")

    def close(self) -> None:
        if self.process is None:
            return
        process = self.process
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=0.5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()
        self.process = None
        self._stderr_thread = None

    def _send(self, message: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("app-server is not running")
        if self.verbose:
            print(f"→ {json.dumps(message)}", file=sys.stderr)
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def send_request(self, method: str, params: dict[str, Any]) -> int:
        request_id = self._next_id
        self._next_id += 1
        self._send({"method": method, "id": request_id, "params": params})
        return request_id

    def send_notification(self, method: str, params: dict[str, Any]) -> None:
        self._send({"method": method, "params": params})

    def take_response(self, request_id: int) -> dict[str, Any]:
        response = self._responses.pop(request_id, None)
        if response is None:
            raise RuntimeError(f"app-server returned no response for request {request_id}")
        if "error" in response:
            raise RuntimeError(str(response["error"]))
        return response.get("result", {})

    def has_response(self, request_id: int) -> bool:
        return request_id in self._responses

    @staticmethod
    def _response_key(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    def _store_response(self, message: dict[str, Any]) -> None:
        if "id" not in message or "method" in message:
            return
        response_id = self._response_key(message.get("id"))
        if response_id is not None:
            self._responses[response_id] = message

    def _remember_item(self, message: dict[str, Any]) -> None:
        if message.get("method") not in {"item/started", "item/completed"}:
            return
        item = message.get("params", {}).get("item", {})
        if not isinstance(item, dict) or not item.get("id"):
            return
        self._items[str(item["id"])] = item

    def _read(self) -> dict[str, Any]:
        if self.process is None or self.process.stdout is None:
            raise RuntimeError("app-server is not running")
        line = self.process.stdout.readline()
        if not line:
            code = self.process.poll()
            stderr = self._stderr_text()
            details = f"app-server exited unexpectedly (status={code})"
            if stderr:
                details += f"\n{stderr}"
            raise AppServerStartupError(details)
        message = parse_json_line(line)
        if self.verbose:
            print(f"← {json.dumps(message)}", file=sys.stderr)
        return message

    def _handle_server_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params", {})
        item_id = params.get("itemId") if isinstance(params, dict) else None
        item = self._items.get(str(item_id)) if item_id else None
        try:
            result = self.broker.response(str(method), params, item=item)
            self._send({"id": request_id, "result": result})
        except Exception as exc:
            self._send({"id": request_id, "error": {"code": -32000, "message": str(exc)}})

    def request(
        self,
        method: str,
        params: dict[str, Any],
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        request_id = self.send_request(method, params)
        while True:
            message = self._read()
            self._remember_item(message)
            if "method" in message and "id" in message:
                self._handle_server_request(message)
                continue
            if self._response_key(message.get("id")) == request_id:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message.get("result", {})
            if "id" in message:
                self._store_response(message)
                continue
            if on_event:
                on_event(message)

    def run_turn(
        self,
        params: dict[str, Any],
        on_event: Callable[[dict[str, Any]], None],
        on_started: Callable[[str], None] | None = None,
        completion_ready: Callable[[], bool] | None = None,
    ) -> tuple[str, str]:
        pending_events: list[dict[str, Any]] = []
        result = self.request("turn/start", params, on_event=pending_events.append)
        turn = result.get("turn", {})
        turn_id = str(turn.get("id", ""))
        thread_id = str(params["threadId"])
        if not turn_id:
            raise RuntimeError("turn/start returned no turn id")
        if on_started:
            on_started(turn_id)

        completed_status: str | None = None

        def process_event(message: dict[str, Any]) -> None:
            nonlocal completed_status
            on_event(message)
            if message.get("method") != "turn/completed":
                return
            event_params = message.get("params", {})
            event_turn = event_params.get("turn", {})
            if str(event_params.get("turnId", event_turn.get("id", ""))) != turn_id:
                return
            completed_status = str(event_turn.get("status", "unknown"))

        for message in pending_events:
            process_event(message)
            if completed_status is not None and (completion_ready is None or completion_ready()):
                return turn_id, completed_status

        while True:
            message = self._read()
            self._remember_item(message)
            if "method" in message and "id" in message:
                self._handle_server_request(message)
                continue
            if "id" in message:
                self._store_response(message)
            else:
                process_event(message)
            if completed_status is not None and (completion_ready is None or completion_ready()):
                return turn_id, completed_status


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a first-edit model handoff session")
    parser.add_argument("task", nargs="?", help="task to give the coding agent")
    parser.add_argument("--guide-model", default=os.environ.get("PREWALK_GUIDE_MODEL", "gpt-5.6-sol"))
    parser.add_argument("--guide-effort", default=os.environ.get("PREWALK_GUIDE_EFFORT", "medium"))
    parser.add_argument("--executor-model", default=os.environ.get("PREWALK_EXECUTOR_MODEL", "gpt-5.6-luna"))
    parser.add_argument("--executor-effort", default=os.environ.get("PREWALK_EXECUTOR_EFFORT", "max"))
    parser.add_argument("--codex-command", default=os.environ.get("PREWALK_CODEX_COMMAND", "codex"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--max-checklist-items", type=int, default=8)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--auto-approve-workspace-writes",
        action="store_true",
        help="accept only file changes whose grant root and paths resolve under --cwd; decline all other interactive requests",
    )
    parser.add_argument("--prompt-stdin", action="store_true", help="read the task from stdin")
    return parser.parse_args(argv)


def read_task(args: argparse.Namespace) -> str:
    if args.prompt_stdin or not args.task:
        task = sys.stdin.read()
    else:
        task = args.task
    task = task.strip()
    if not task:
        raise SystemExit("a non-empty task is required")
    return task


def emit_summary(
    controller: HandoffController,
    executor_model: str,
    guide_status: str,
    executor_status: str | None,
    interrupt_confirmed: bool,
) -> None:
    executor_started = executor_status is not None
    summary = {
        "checklist_ready": controller.checklist_ready,
        "file_change_seen": controller.file_change_seen,
        "handoff_triggered": controller.handoff_requested,
        "interrupt_confirmed": interrupt_confirmed,
        "executor_started": executor_started,
        "executor_model": executor_model if executor_started else None,
        "guide_status": guide_status,
        "executor_status": executor_status,
        "final_status": executor_status or guide_status,
    }
    print(f"[prewalk] summary {json.dumps(summary, sort_keys=True)}", file=sys.stderr)


def run(args: argparse.Namespace) -> int:
    task = read_task(args)
    cwd = Path(args.cwd).expanduser().resolve()
    with acquire_pre_walk_lock():
        return _run_locked(args, task, cwd)


def _run_locked(args: argparse.Namespace, task: str, cwd: Path) -> int:
    client = AppServerClient(
        args.codex_command,
        cwd,
        ApprovalBroker(
            auto_approve_workspace_writes=args.auto_approve_workspace_writes,
            writable_root=cwd,
        ),
        verbose=args.verbose,
    )

    try:
        client.start_with_retry(
            {
                "clientInfo": {"name": "prewalk", "title": "Prewalk", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        client.send_notification("initialized", {})
        thread_result = client.request("thread/start", {"model": args.guide_model, "cwd": str(cwd)})
        thread_id = str(thread_result.get("thread", {}).get("id", ""))
        if not thread_id:
            raise RuntimeError("thread/start returned no thread id")

        controller: HandoffController | None = None
        interrupt_request_id: int | None = None

        def request_interrupt_if_ready() -> None:
            nonlocal interrupt_request_id
            if (
                controller is None
                or not controller.handoff_requested
                or interrupt_request_id is not None
                or controller.turn_id == "pending"
            ):
                return
            print("\n[prewalk] First accepted edit detected; switching models.\n", file=sys.stderr)
            interrupt_request_id = client.send_request(
                "turn/interrupt", {"threadId": thread_id, "turnId": controller.turn_id}
            )

        def on_event(message: dict[str, Any]) -> None:
            text = message_text(message)
            if message.get("method") == "item/agentMessage/delta" and text:
                print(text, end="", flush=True)
            action = controller.observe_message(message) if controller else None
            if action == "request_interrupt":
                request_interrupt_if_ready()

        def on_started(turn_id: str) -> None:
            assert controller is not None
            controller.turn_id = turn_id
            request_interrupt_if_ready()

        guide_params = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": build_bootstrap_prompt(task, args.max_checklist_items)}],
            "cwd": str(cwd),
            "approvalPolicy": "on-request",
            "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": [str(cwd)]},
            "collaborationMode": build_collaboration_mode(
                args.guide_model,
                args.guide_effort,
                build_guide_instructions(args.max_checklist_items),
            ),
        }
        # The controller is initialized with the turn id returned by turn/start.
        controller = HandoffController(thread_id, "pending", args.executor_model)
        _, guide_status = client.run_turn(
            guide_params,
            on_event,
            on_started=on_started,
            completion_ready=lambda: interrupt_request_id is None or client.has_response(interrupt_request_id),
        )

        interrupt_confirmed = False
        if interrupt_request_id is not None:
            try:
                client.take_response(interrupt_request_id)
                interrupt_confirmed = guide_status == "interrupted"
                if not interrupt_confirmed:
                    print(
                        f"[prewalk] Interrupt response succeeded but guide status was {guide_status!r}; "
                        "not handing off.",
                        file=sys.stderr,
                    )
            except RuntimeError as exc:
                print(f"[prewalk] Interrupt failed; not handing off: {exc}", file=sys.stderr)

        if controller.handoff_requested and controller.file_change_seen and interrupt_confirmed:
            print(f"[prewalk] Continuing with {args.executor_model}.", file=sys.stderr)
            executor_params = {
                "threadId": thread_id,
                "input": [{"type": "text", "text": build_executor_prompt()}],
                "cwd": str(cwd),
                "approvalPolicy": "on-request",
                "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": [str(cwd)]},
                "collaborationMode": build_collaboration_mode(
                    args.executor_model,
                    args.executor_effort,
                    None,
                ),
            }
            _, executor_status = client.run_turn(
                executor_params,
                lambda message: print(message_text(message), end="", flush=True) if message_text(message) else None,
            )
            emit_summary(controller, args.executor_model, guide_status, executor_status, interrupt_confirmed)
            return 0 if executor_status == "completed" else 1

        if controller.handoff_requested and controller.file_change_seen and not interrupt_confirmed:
            emit_summary(controller, args.executor_model, guide_status, None, interrupt_confirmed)
            return 1

        print("\n[prewalk] No handoff occurred; guide session ended.", file=sys.stderr)
        emit_summary(controller, args.executor_model, guide_status, None, interrupt_confirmed)
        return 0 if guide_status == "completed" else 1
    finally:
        client.close()


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except KeyboardInterrupt:
        print("\n[prewalk] Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"[prewalk] Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Real terminal smoke test. Python stdlib + Node only; never hits a real API."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parents[1]
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")

class Terminal:
    def __init__(self, args, env):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 120, 0, 0))
        self.process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=REPO, env=env, start_new_session=True)
        os.close(slave)
        self.output = ''
        self.cursor = 0

    def send(self, value):
        os.write(self.fd, value.encode())
        time.sleep(0.12)

    def expect(self, text, timeout=15):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            clean = ANSI.sub('', self.output)
            found = clean.find(text, self.cursor)
            if found >= 0:
                self.cursor = found + len(text)
                return
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536)
                    if not chunk:
                        break
                    self.output += chunk.decode(errors='replace')
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
        Path('/tmp/tisco-tui-smoke.log').write_text(ANSI.sub('', self.output))
        raise AssertionError(f'Missing terminal text: {text!r}. See /tmp/tisco-tui-smoke.log')

    def finish(self):
        assert self.process.wait(timeout=10) == 0
        os.close(self.fd)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        try:
            os.close(self.fd)
        except OSError:
            pass

with tempfile.TemporaryDirectory(prefix='tisco-tui-') as base:
    root = Path(base) / 'shoot'
    root.mkdir()
    log_path = Path(os.environ.get('TISCO_TUI_LOG', str(Path(base) / 'requests.jsonl')))
    log_path.unlink(missing_ok=True)
    env = {**os.environ, 'TERM': 'xterm-256color', 'XDG_CONFIG_HOME': str(Path(base) / 'config'), 'OPENROUTER_API_KEY': 'test-key-never-real', 'TISCO_DEMO_REQUEST_LOG': str(log_path)}
    args = ['node', '--import', str(REPO / 'test/mock-network.mjs'), str(REPO / 'dist/cli.js'), str(root)]
    # Authorization denial must not inspect/create project state or contact a model.
    terminal = Terminal(args, env)
    try:
        terminal.expect('Authorize this directory?')
        terminal.send('\r')
        terminal.expect('Not authorized. No contents scanned.')
        terminal.finish()
        assert not (root / '.tisco').exists()
        assert not log_path.exists()
    finally:
        terminal.close()

    subprocess.run(['node', 'test/demo.mjs', '--seed', str(root)], cwd=REPO, check=True, capture_output=True)
    terminal = Terminal(args, env)
    try:
        terminal.expect('Authorize this directory?')
        terminal.send('y')
        terminal.expect('workspace')
        # Transcription is offered first, and a folder that is already transcribed says so
        # in one line instead of asking anything.
        terminal.expect('Transcripts ready · 3 clip(s).')

        # 1. request -> accept -> boom. Nothing is applied before the accept.
        terminal.expect('what now?')
        terminal.send('find the prepared takes and put them in falas\r')
        terminal.expect('Request interpreted')
        terminal.expect('spoken-content condition')
        terminal.expect('clip(s) judged')
        terminal.expect('Findings')
        terminal.expect('Transcript opening:')
        assert not (root / 'falas').exists(), 'no change before approval'
        terminal.expect('NOT selected or approved')
        terminal.expect('Folder from your request: falas')
        terminal.expect('Destination folder')
        terminal.send('\r')
        # The unclear row is in the plan but unapproved, so the ready-only option is offered.
        terminal.expect('2 ready · 1 unclear')
        terminal.send('\r')
        terminal.expect('action(s) applied')
        assert (root / 'falas/01-intro.MOV').exists()
        assert (root / 'falas/01-intro.MOV.tisco.json').exists()
        assert not (root / 'falas/02-setup.MOV').exists(), 'a blanket Enter must not take an unclear row'
        assert (root / '02-setup.MOV').exists()
        assert (root / '03-detail.MOV').exists()

        # 2. the same request on unchanged clips reuses the cached judgments.
        terminal.expect('what now?')
        terminal.send('find the prepared takes and put them in falas\r')
        terminal.expect('Request interpreted')
        terminal.expect('Destination folder')
        terminal.send('\r')
        # Same request, unchanged clips: the cached judgment still lands in the unclear band.
        terminal.expect('0 ready · 1 unclear')
        terminal.send('\x1b')
        terminal.expect('Cancelled. Nothing was changed.')
        assert (root / 'falas/01-intro.MOV').exists(), 'a reuse run changes nothing'

        # 3. the same surface undoes it.
        terminal.expect('what now?')
        terminal.send('/undo\r')
        terminal.expect('Restore these files?')
        terminal.send('y')
        terminal.expect('Original paths restored.')
        assert (root / '01-intro.MOV').exists()
        assert not (root / 'falas').exists()

        # 4. a request that only asks for a folder creates the folder and moves nothing.
        terminal.expect('what now?')
        terminal.send('create a folder called drafts\r')
        terminal.expect('Request interpreted')
        terminal.expect('Destination folder')
        terminal.send('drafts\r')
        terminal.expect('Apply these 1 action(s)?')
        terminal.send('\r')
        terminal.expect('action(s) applied')
        assert (root / 'drafts').is_dir()
        assert not any((root / 'drafts').iterdir()), 'a create-only request must not move the clips'
        for name in ['01-intro.MOV', '02-setup.MOV', '03-detail.MOV']:
            assert (root / name).exists(), name

        # 5. a request with no criterion asks Jev nothing per clip.
        terminal.expect('what now?')
        terminal.send('move every clip into selects\r')
        terminal.expect('without content filtering')
        terminal.expect('Destination folder')
        terminal.send('\r')
        terminal.expect('Apply these')
        terminal.send('\r')
        terminal.expect('action(s) applied')
        for name in ['01-intro.MOV', '02-setup.MOV', '03-detail.MOV']:
            assert (root / 'selects' / name).exists(), name

        # 6. a request that asks only for something a transcript cannot decide is refused
        # before any transcript is paid for, and leaves every file where it was.
        before = sorted(path.name for path in (root / 'selects').iterdir())
        terminal.expect('what now?')
        terminal.send('separate the clips where he is smiling into selects\r')
        terminal.expect('Request interpreted')
        terminal.expect('Nothing was judged and nothing was changed')
        terminal.expect('how the footage looks')
        assert sorted(path.name for path in (root / 'selects').iterdir()) == before, 'a refused request moves nothing'
        assert not (root / 'falas').exists(), 'a refused request plans nothing'

        # 7. a request that mixes a sound request into a spoken one is still judged, on its
        # words, and the clip call carries the part that was set aside.
        terminal.expect('what now?')
        terminal.send('find the clips with clean audio where they explain the price and put them in falas\r')
        terminal.expect('Request interpreted')
        terminal.expect('how the footage sounds')
        # Everything moved into selects/ earlier, so the top level is empty and the scope
        # prompt asks which clips to use.
        terminal.expect('NOT search results')
        terminal.expect('Where should I look?')
        terminal.send('\r')
        terminal.expect('clip(s) judged')
        terminal.expect('Findings')
        terminal.expect('Destination folder')
        terminal.send('\r')
        terminal.expect('ready · 1 unclear')
        terminal.send('\r')
        terminal.expect('action(s) applied')
        assert (root / 'falas/01-intro.MOV').exists(), 'the spoken part is still judged and moved'

        terminal.expect('what now?')
        terminal.send('/quit\r')
        terminal.expect('Nothing moves without your say-so.')
        terminal.finish()

        calls = [json.loads(line) for line in log_path.read_text().splitlines()]
        assert all(call['model'] == 'typesafe/jev-1.13' for call in calls)
        assert len(calls) == 12, len(calls)
        instruction = lambda call: call['state']['instruction']
        routes = [call for call in calls if 'target_set' in call['questions']]
        clips = [call for call in calls if 'current_video' in call['state']]
        assert len(routes) == 6 and len(clips) == 6, (len(routes), len(clips))

        first = routes[0]['questions']
        for question in ['ops_find', 'ops_create', 'ops_move', 'ops_rename', 'criterion_requested', 'target_set']:
            assert question in first, question
        assert 'ops_extract' not in first, 'a never-gated question is not sent'
        # Feasibility reads the same instruction independently, so it fans out with route
        # instead of adding a second network round trip.
        for question in ['spoken_content_decides', 'needs_picture', 'needs_sound', 'needs_measurement', 'needs_external_record']:
            assert question in first, question
        # Only gate-admitted questions reach a clip.
        for call in [call for call in clips if instruction(call).startswith('find the prepared takes')]:
            assert sorted(call['questions']) == ['has_scripted_segment', 'matches_request', 'speech_kind'], sorted(call['questions'])
        # The reference gate follows the folders that exist, in both directions.
        has_reference = lambda call: 'reference_set' in call['questions']
        assert not has_reference(routes[0]) and has_reference(routes[1]), 'the reference gate opens once falas/ exists'
        assert not has_reference(routes[2]) and not has_reference(routes[3]), 'undo removed falas/, so the gate closes again'
        assert len([call for call in routes if 'create a folder called drafts' in instruction(call)]) == 1
        # A refused request is judged on nothing at all, and route itself takes one call.
        refused = [call for call in calls if instruction(call).endswith('smiling into selects')]
        assert len(refused) == 1 and not any('current_video' in call['state'] for call in refused), 'a refused request judges no clip'
        # A mixed request is judged on what was said, and carries every set-aside part.
        mixed = [call for call in clips if 'clean audio' in instruction(call)]
        assert len(mixed) == 3 and all(call['state']['unjudgeable'] == ['sound'] for call in mixed), 'the set-aside part travels with the evidence'
        assert all('unjudgeable' not in call['state'] for call in clips if 'clean audio' not in instruction(call)), 'a plain request carries no limitation'
        assert not (root / '.tisco/lock.json').exists()
        assert 'test-never-real' not in terminal.output
        assert 'test-key-never-real' not in terminal.output
    finally:
        Path('/tmp/tisco-tui-smoke.log').write_text(ANSI.sub('', terminal.output))
        terminal.close()

    # Findings are automatic, not a selection prompt. Uncertainty survives follow-ups,
    # and naming edits rebuild the exact preview before any side effect.
    ux_root = Path(base) / 'ux-shoot'
    subprocess.run(['node', 'test/demo.mjs', '--seed', str(ux_root)], cwd=REPO, check=True, capture_output=True)
    terminal = Terminal(args[:-1] + [str(ux_root)], env)
    try:
        terminal.expect('Authorize this directory?')
        terminal.send('y')
        terminal.expect('what now?')
        terminal.send('which clips have prepared takes?\r')
        terminal.expect('Find only: show results')
        terminal.expect('1 match · 1 review · 1 no match · 0 not judged')
        terminal.expect('Transcript opening:')
        terminal.expect('Find only · 1 selected match(es), 1 review candidate(s). No files changed.')
        terminal.expect('what now?')
        calls_before = len(log_path.read_text().splitlines())
        terminal.send('/results\r')
        terminal.expect('Last search: which clips have prepared takes?')
        terminal.expect('what now?')
        terminal.send('/details\r')
        terminal.expect('Inspect evidence · not an action approval')
        terminal.send('\r')
        terminal.expect('Full transcript used for this finding')
        terminal.expect('what now?')
        terminal.send('/select\r')
        terminal.expect('Choose findings')
        terminal.send('\x1b')
        terminal.expect('Cancelled. Nothing was changed.')
        terminal.expect('what now?')
        assert len(log_path.read_text().splitlines()) == calls_before, 'inspection must be local'
        terminal.send('find the results with a broader match\r')
        terminal.expect('1 match · 1 review · 0 no match · 0 not judged')
        terminal.expect('previous result still needed review')
        terminal.expect('what now?')

        terminal.send('move the results into "approved picks" and rename with _final\r')
        terminal.expect('previous result (review rows still need approval)')
        terminal.expect('Folder from your request: approved picks')
        terminal.expect('Destination folder')
        terminal.send('\r')
        terminal.expect('How should files be named?')
        terminal.send('\r')
        terminal.expect('Suffix before extension')
        terminal.send('\r')
        terminal.expect('Action preview · 3 ready · 2 unclear')
        terminal.expect('01-intro.MOV → approved picks/01-intro.MOV')
        terminal.expect('approved picks/01-intro.MOV → approved picks/01-intro_final.MOV')
        terminal.expect('Apply these 3 action(s)?')
        assert not (ux_root / 'approved picks').exists()
        terminal.send('\x1b[B\x1b[B\r')  # edit, after apply-ready and choose-rows
        terminal.expect('Edit naming')
        terminal.send('\r')  # folder
        terminal.expect('Destination folder')
        terminal.send('final picks\r')
        terminal.expect('Edit naming')
        terminal.send('\x1b[B\x1b[B\r')  # done
        terminal.expect('01-intro.MOV → final picks/01-intro.MOV')
        terminal.expect('Apply these 3 action(s)?')
        terminal.send('\r')
        terminal.expect('3 action(s) applied')
        assert not (ux_root / 'approved picks').exists()
        assert (ux_root / 'final picks/01-intro_final.MOV').exists()
        assert (ux_root / 'final picks/01-intro_final.MOV.tisco.json').exists()
        assert (ux_root / '02-setup.MOV').exists(), 'review cannot become approved through a follow-up'
        assert (ux_root / '03-detail.MOV').exists()

        # The next selection contains final renamed paths, never stale intermediate ones.
        terminal.expect('what now?')
        terminal.send('rename the selected clips\r')
        terminal.expect('1 input clip(s) from the current selection')
        terminal.expect('How should files be named?')
        terminal.send('\r')  # numbered, default when no explicit suffix
        terminal.expect('Shared name after the number')
        terminal.send('intro\r')
        terminal.expect('final picks/01-intro_final.MOV → final picks/01-intro.MOV')
        terminal.expect('Apply these 1 action(s)?')
        terminal.send('\x1b[B\x1b[B\r')  # edit, after apply and choose-rows
        terminal.expect('Edit naming')
        terminal.send('\r')
        terminal.expect('New name for final picks/01-intro_final.MOV')
        terminal.send('01-opening\r')
        terminal.expect('Edit naming')
        terminal.send('\x1b[B\r')
        terminal.expect('final picks/01-intro_final.MOV → final picks/01-opening.MOV')
        terminal.expect('Apply these 1 action(s)?')
        terminal.send('\r')
        terminal.expect('1 action(s) applied')
        assert (ux_root / 'final picks/01-opening.MOV.tisco.json').exists()

        terminal.expect('what now?')
        terminal.send('/undo\r')
        terminal.expect('Restore these files?')
        terminal.send('y')
        terminal.expect('Original paths restored.')
        terminal.expect('what now?')
        terminal.send('find clips where nothing matches in this folder and subfolders\r')
        terminal.expect('0 match · 0 review · 3 no match · 0 not judged')
        terminal.expect('No matching candidates')
        terminal.expect('what now?')
        terminal.send('move the results into nope\r')
        terminal.expect('That selection is empty or no longer exists. Nothing was retargeted.')
        terminal.expect('what now?')
        assert not (ux_root / 'nope').exists()

        # A human can explicitly include a nonmatch; choosing clips itself moves nothing.
        terminal.send('/select\r')
        terminal.expect('Choose findings')
        terminal.send(' \r')
        terminal.expect('1 clip(s) explicitly selected. Files unchanged')
        terminal.expect('what now?')
        terminal.send('rename the selected clips\r')
        terminal.expect('How should files be named?')
        terminal.send('\x1b[B\r')  # transcript opening, after default numbered
        terminal.expect('Uses cached transcript openings only')
        terminal.expect('Action preview')
        terminal.expect('Apply these 1 action(s)?')
        terminal.send('\x1b')
        terminal.expect('Cancelled. Nothing was changed.')
        terminal.expect('what now?')
        terminal.send('/quit\r')
        terminal.finish()
    finally:
        Path('/tmp/tisco-tui-ux.log').write_text(ANSI.sub('', terminal.output))
        terminal.close()

    # A folder with nothing transcribed yet is offered transcription up front. Declining
    # uploads nothing and leaves the request loop reachable.
    untranscribed = Path(base) / 'untranscribed'
    untranscribed.mkdir()
    (untranscribed / 'A001_09191200_D001.MOV').write_bytes(b'\x00' * 4096)
    terminal = Terminal(args[:-1] + [str(untranscribed)], env)
    try:
        terminal.expect('Authorize this directory?')
        terminal.send('y')
        terminal.expect('1 of 1 clip(s) have no transcript yet')
        terminal.expect('Transcribe 1 clip(s) now?')
        terminal.send('n')
        terminal.expect('The first request that needs a judgment asks again.')
        terminal.expect('what now?')
        terminal.send('/quit\r')
        terminal.expect('Nothing moves without your say-so.')
        terminal.finish()
        assert not list(untranscribed.glob('*.tisco.json')), 'declining wrote no transcript'
        assert 'Demo blocks all network requests' not in terminal.output, 'declining uploaded nothing'
    finally:
        Path('/tmp/tisco-tui-smoke-untranscribed.log').write_text(ANSI.sub('', terminal.output))
        terminal.close()

print('PASS: denial, startup transcription offer, request->accept->boom, gate-admitted questions only, undo, quit; no real API calls.')

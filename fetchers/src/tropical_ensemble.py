"""tropical_ensemble task: ensemble member tracks from NOAA and ECMWF (S9).

Design: docs/tropical-cyclone/design.md 1.8, 1.9, 2.4, 3.5, 3.6, 5.1, 5.4, 6.1, 6.2, 11g.
Every decision function takes ``now`` (and the run clock); only
``update_tropical_ensemble`` reads the wall clock. The task writes only
``tropical/ensemble/``. It reads the official index, the official
``analysis.json`` files (positions, 11e E5) and the models index (the
tcvitals bridge, 1.8) and never writes them.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time

from .http_client import HttpPolicy, http_scope
from .publication import atomic_write_compact_json, atomic_write_json
from .services import tropical_ecmwf, tropical_noaa
from .services.tropical_common import SourceFailure
from .tropical_contract import (ENSEMBLE_INDEX_PATH, ENSEMBLE_PROVIDER, ENSEMBLES,
                                MAX_ENSEMBLE_CHECKED, MAX_ENSEMBLE_CYCLES, MAX_MEMBERS, MEMBER_ID,
                                MEMBERS_EXPECTED, MODEL_MATCH, MODELS_INDEX_PATH, OFFICIAL_INDEX_PATH, WIND_UNIT,
                                cycle_time, format_cycle, format_stamp, member_order, validate_ensemble_file,
                                validate_ensemble_index, validate_models_index, validate_official_index)
from .tropical_models import (CYCLE_STEP, NOT_PUBLISHED, OVERDUE_AFTER_WAIT, AllSourcesFailed, ModelClient,
                              _bridges, _read_valid, _size, _source_state, known_positions, match_basis,
                              match_ecmwf, match_noaa)
from .tropical_official import read_previous_files as read_previous_official

SOURCE_OF = {'gefs': 'noaa', 'aigefs': 'noaa', 'ifs-ens': 'ecmwf', 'aifs-ens': 'ecmwf'}
# ECMWF first: two downloads, so NOAA's 62 requests never push them out of time (5.4).
ORDER = ('ifs-ens', 'aifs-ens', 'gefs', 'aigefs')
# Initial values of design.md 5.4 ([初值]).
EARLIEST_WAIT = {'aigefs': timedelta(hours=4.5), 'gefs': timedelta(hours=5.25),
                 'ifs-ens': timedelta(hours=7), 'aifs-ens': timedelta(hours=7)}
ABANDON_AFTER = {'aigefs': timedelta(hours=24), 'gefs': timedelta(hours=24),
                 'ifs-ens': timedelta(hours=48), 'aifs-ens': timedelta(hours=48)}
# Task time limit (design.md 5.4, 5.5 [初值]): no request starts after it; NOAA
# member files not requested yet go to ``missing_files`` and follow next run.
TIME_LIMIT_SECONDS = 240
# Attempts (retries included) per source in this task's own scope: the noaa
# limit of design.md 5.4 (62 member files need far fewer).
TASK_MAX_REQUESTS = 200
# In this scope a ``timeout`` code comes from the shared window (SourceBudgetExceeded):
# no time left, the chunk deadline, or a retry wait that would cross it. Within
# this margin of the limit it is the limit, not an outage (11g G5, review S1).
LIMIT_GRACE_SECONDS = 60
# Byte limits of design.md 6.1, measured in the published layouts.
MAX_INDEX_BYTES = 16 * 1024
MAX_FILE_BYTES = 192 * 1024
MAX_PREFIX_BYTES = 2560 * 1024
STORMS_DIR = 'tropical/ensemble/storms'


def empty_index(now):
    return {'schema_version': 1, 'fetched_at': format_stamp(now),
            'sources': {source: {'state': 'idle', 'error_code': None} for source in ('noaa', 'ecmwf')},
            'match_basis': [], 'checked': {}, 'storms': {}}


def file_path(identity, cycle, model):
    return f'{STORMS_DIR}/{identity}/{cycle}/{model}.json'


def read_previous_files(data_root, previous):
    """Saved member files the previous valid ensemble index lists; others are never read."""
    files = {}
    for identity, storm in (previous or {}).get('storms', {}).items():
        for item in storm['cycles']:
            for model in item['models']:
                path = file_path(identity, item['cycle'], model)
                try:
                    files[(identity, item['cycle'], model)] = validate_ensemble_file(
                        path, json.loads((Path(data_root) / path).read_bytes()))
                except Exception:  # noqa: BLE001 - unreadable means "not saved".
                    continue
    return files


def window(model, now):
    """The two latest cycles whose earliest wait has passed, newest first (11g G4)."""
    latest = now - EARLIEST_WAIT[model]
    latest = latest.replace(hour=latest.hour - latest.hour % 6, minute=0, second=0, microsecond=0)
    return [latest - CYCLE_STEP * back for back in range(MAX_ENSEMBLE_CYCLES)]


def abandon_stale(checked, now):
    """Mark ``complete`` every unfinished (cycle, model) older than the model's
    window (design.md 5.4: once a newer cycle is due, an older unfinished one is
    given up) or past its abandon time. ``missing_files`` stays as a record."""
    for cycle, models in checked.items():
        moment = cycle_time(cycle)
        for model, entry in models.items():
            if not entry['complete'] and (moment < window(model, now)[-1] or now > moment + ABANDON_AFTER[model]):
                entry['complete'] = True


def ecmwf_members(tracks, active, positions, cycle, model):
    """``{member: (type, {cyclone_id: [(match, source_id, track)]})}`` for one ENS file.

    Each member is matched on its own with the deterministic rules (2.4); a
    subset without a usable member number is dropped."""
    by_member = {}
    for track in tracks:
        member = track['member']
        name = str(member) if type(member) is int else None
        if name is None or not MEMBER_ID[model].fullmatch(name):
            continue
        by_member.setdefault(name, []).append(track)
    found = {}
    for name, items in sorted(by_member.items()):
        kinds = {item['type'] for item in items}
        kind = kinds.pop() if len(kinds) == 1 else None
        if kind is not None and (type(kind) is not int or not 0 <= kind <= 255):
            kind = None
        found[name] = (kind, match_ecmwf(items, active, positions, cycle))
    return found


def _group(entries, provider):
    """The (match, source_id) most members share (11g G7); ties go to the
    stronger match, then to the smaller source_id."""
    counts = Counter((how, source_id) for how, source_id, _, _ in entries.values())
    rank = MODEL_MATCH[provider]
    return min(counts, key=lambda key: (-counts[key], rank.index(key[0]), key[1]))


def build_file(identity, cycle, model, entries, stamp):
    provider = ENSEMBLE_PROVIDER[model]
    how, source_id = _group(entries, provider)
    members = [{'m': name, 'type': entries[name][2], 'track': entries[name][3]}
               for name in sorted(entries, key=member_order)
               if entries[name][:2] == (how, source_id)][:MAX_MEMBERS]
    return {'schema_version': 1, 'cyclone_id': identity, 'model': model, 'cycle': cycle,
            'init_time': format_stamp(cycle_time(cycle)), 'fetched_at': stamp, 'provider': provider,
            'source_id': source_id, 'match': how, 'wind_unit': WIND_UNIT[provider],
            'members_expected': MEMBERS_EXPECTED[model], 'members': members}


def run_ensemble(official, previous, saved, official_files, models_index, now, get, clock=time.monotonic,
                 time_limit=TIME_LIMIT_SECONDS, started=None):
    """Return ``(index, outputs)``; ``outputs`` maps changed member-file paths to data.

    ``get(url)`` returns ``(status, body)`` or raises ``SourceFailure``.
    Raises ``AllSourcesFailed`` when both sources failed.
    """
    previous = previous or empty_index(now)
    stamp_now = format_stamp(now)
    listed = {storm['cyclone_id']: storm for storm in official['storms']}
    active = [storm for storm in official['storms'] if storm['status'] == 'active']
    # The bridge of the models task, read only (1.8); this task never asks tcvitals.
    bridges = _bridges(official, models_index)
    positions = {storm['cyclone_id']: known_positions(storm, official_files) for storm in active}
    basis = match_basis(active, bridges)
    known_numbers = frozenset(number for storm in official['storms'] for number in
                              (storm['ids']['jtwc'], bridges.get(storm['cyclone_id'])) if number)
    checked = {} if set(basis) - set(previous['match_basis']) else {
        cycle: {model: dict(entry, missing_files=list(entry['missing_files'])) for model, entry in models.items()}
        for cycle, models in previous['checked'].items()}
    abandon_stale(checked, now)
    stats = {source: {'requests': 0, 'ok': 0, 'not_yet': 0, 'overdue': 0, 'failure': None, 'stopped': False}
             for source in ('noaa', 'ecmwf')}
    per_model = {model: {'ok': 0, 'overdue': 0} for model in SOURCE_OF}
    started = clock() if started is None else started  # the same instant as the HTTP window (11g G5)

    def request(source, url):
        """``(status, body)``; ``(None, b'')`` when skipped: after a failure other
        than 200/403/404 (11e E13) or once the task time limit has passed.

        A ``timeout`` that ends within ``LIMIT_GRACE_SECONDS`` of the limit is the
        limit itself (an in-flight request cut by the shared window), not a source
        failure: the source just stops and the rest follows next run (5.4, 11g G5)."""
        if stats[source]['stopped'] or clock() - started >= time_limit:
            return None, b''
        stats[source]['requests'] += 1
        try:
            return get(url)
        except SourceFailure as failure:
            stats[source]['stopped'] = True
            at_limit = failure.code == 'timeout' and clock() - started >= time_limit - LIMIT_GRACE_SECONDS
            if not at_limit and stats[source]['failure'] is None:
                stats[source]['failure'] = failure.code
            return None, b''

    def not_published(model, moment):
        overdue = now >= moment + EARLIEST_WAIT[model] + OVERDUE_AFTER_WAIT
        stats[SOURCE_OF[model]]['overdue' if overdue else 'not_yet'] += 1
        per_model[model]['overdue'] += overdue

    def parse_failed(source):
        stats[source]['failure'] = stats[source]['failure'] or 'parse_error'

    def noaa_member(model, code, cycle, moment, body):
        tracks = tropical_noaa.parse_atcf_code(body, code, cycle)
        return code, (None, match_noaa(tracks, active, bridges, positions, moment, known_numbers))

    results = {}  # (cycle, model) -> {member: (type, {cyclone_id: [(match, source_id, track)]})}
    if active:
        for model in ORDER:
            source = SOURCE_OF[model]
            for moment in window(model, now):
                cycle = format_cycle(moment)
                entry = checked.get(cycle, {}).get(model)
                if entry is not None and entry['complete']:
                    continue  # Newest first: an older cycle is filled only once the newer is complete.
                if source == 'ecmwf':
                    status, body = request(source, tropical_ecmwf.track_url(model, cycle))
                    if status in NOT_PUBLISHED:
                        not_published(model, moment)
                        continue  # The older cycle of the window may still be missing.
                    if status != 200:
                        break
                    try:
                        tracks = [track for track in tropical_ecmwf.decode_tracks(body) if track['init_time'] == moment]
                    except ValueError:
                        parse_failed(source)
                        break  # Not recorded: tried again next run.
                    stats[source]['ok'] += 1
                    per_model[model]['ok'] += 1
                    results[(cycle, model)] = ecmwf_members(tracks, active, positions, cycle, model)
                    checked.setdefault(cycle, {})[model] = {'complete': True, 'missing_files': []}
                    break
                codes = tropical_noaa.ENSEMBLE[model][1]
                found, missing = {}, []
                if entry is None:
                    status, body = request(source, tropical_noaa.member_url(model, codes[0], cycle))
                    if status in NOT_PUBLISHED:
                        not_published(model, moment)
                        continue
                    if status != 200:
                        break
                    stats[source]['ok'] += 1
                    per_model[model]['ok'] += 1
                    try:
                        name, value = noaa_member(model, codes[0], cycle, moment, body)
                        found[name] = value
                    except ValueError:
                        parse_failed(source)
                        missing.append(codes[0])
                    pending = list(codes[1:])
                else:
                    pending = [code for code in codes if code in entry['missing_files']]
                for code in pending:
                    status, body = request(source, tropical_noaa.member_url(model, code, cycle))
                    if status != 200:
                        missing.append(code)  # 403/404 after the probe, a failure or the time limit.
                        continue
                    stats[source]['ok'] += 1
                    per_model[model]['ok'] += 1
                    try:
                        name, value = noaa_member(model, code, cycle, moment, body)
                        found[name] = value
                    except ValueError:
                        parse_failed(source)
                        missing.append(code)
                if found:
                    results[(cycle, model)] = found
                checked.setdefault(cycle, {})[model] = {'complete': not missing,
                                                        'missing_files': sorted(missing)}
                break

    sources = {source: _source_state(stats[source], [per_model[model] for model in SOURCE_OF
                                                     if SOURCE_OF[model] == source])
               for source in ('noaa', 'ecmwf')}
    if all(value['state'] == 'failed' for value in sources.values()):
        raise AllSourcesFailed('Both ensemble sources failed')

    # Merge: saved member files of systems still in the official index, then new members.
    entries = {}  # (cyclone_id, cycle, model) -> {member: (match, source_id, type, track)}
    for (identity, cycle, model), data in saved.items():
        if identity in listed:
            entries[(identity, cycle, model)] = {
                member['m']: (data['match'], data['source_id'], member['type'], member['track'])
                for member in data['members']}
    changed = set()
    for (cycle, model), members in sorted(results.items()):
        for name, (kind, found) in members.items():
            for identity, paths in found.items():
                if len(paths) != 1:
                    continue  # Two tracks of one member for one system: use neither (2.4).
                how, source_id, track = paths[0]
                key = (identity, cycle, model)
                entries.setdefault(key, {})[name] = (how, source_id, kind, track)
                changed.add(key)
    files = {key: saved[key] for key in entries if key in saved and key not in changed}
    for key in sorted(changed):
        data = build_file(*key, entries[key], stamp_now)
        if _size(data, True) <= MAX_FILE_BYTES:
            files[key] = data
        else:
            changed.discard(key)  # Not written; the saved file (if any) stays as it was.
            if key in saved:
                files[key] = saved[key]

    def cycles_of(identity):
        return sorted({cycle for (owner, cycle, _) in files if owner == identity})

    def drop(identity, cycle, model=None):
        for key in [key for key in files if key[:2] == (identity, cycle) and model in (None, key[2])]:
            files.pop(key)
            changed.discard(key)

    for identity in listed:
        for cycle in cycles_of(identity)[:-MAX_ENSEMBLE_CYCLES]:
            drop(identity, cycle)

    def build_index():
        storms = {}
        for identity in sorted(listed):
            cycles = cycles_of(identity)
            if cycles:
                storms[identity] = {'cycles': [
                    {'cycle': cycle, 'models': {
                        model: {'members': len(files[(identity, cycle, model)]['members']),
                                'members_expected': MEMBERS_EXPECTED[model]}
                        for model in ENSEMBLES if (identity, cycle, model) in files}}
                    for cycle in cycles]}
        newest = sorted(checked)[-MAX_ENSEMBLE_CHECKED:]
        return {'schema_version': 1, 'fetched_at': stamp_now, 'sources': sources, 'match_basis': basis,
                'checked': {cycle: {model: checked[cycle][model] for model in sorted(checked[cycle])}
                            for cycle in newest},
                'storms': storms}

    def total(index):
        return _size(index, False) + sum(_size(data, True) for data in files.values())

    # Prefix limit (6.1): cycles of ended systems (oldest first), then the older
    # cycle of active systems, then this run's new files are not written.
    index = build_index()
    while total(index) > MAX_PREFIX_BYTES:
        ended = sorted((cycle, identity) for identity in listed if listed[identity]['status'] == 'ended'
                       for cycle in cycles_of(identity))
        older = sorted((cycle, identity) for identity in listed if listed[identity]['status'] != 'ended'
                       for cycle in cycles_of(identity)[:-1])
        if ended or older:
            cycle, identity = (ended or older)[0]
            drop(identity, cycle)
        elif changed:
            key = sorted(changed)[0]
            changed.discard(key)
            if key in saved:
                files[key] = saved[key]
            else:
                files.pop(key)
            if key in saved and total(build_index()) > MAX_PREFIX_BYTES:
                files.pop(key)  # The saved version alone is still too much: list neither.
        else:
            raise ValueError('tropical/ensemble prefix exceeds its size limit')
        index = build_index()
    if _size(index, False) > MAX_INDEX_BYTES:
        raise ValueError('tropical/ensemble index exceeds its size limit')
    outputs = {file_path(*key): files[key] for key in sorted(changed)}
    return index, outputs


def update_tropical_ensemble(data_root, *, now=None, transport=None, wait=time.sleep,
                             clock=time.monotonic, policy=None):
    """Write changed member files (compact) and then ``tropical/ensemble/index.json``.

    An unreadable or invalid official index changes nothing (and writes an empty
    index only when none exists yet). Never deletes a file: removal is the prune
    step's job (design.md 3.6). Raises ``AllSourcesFailed`` when both sources failed.
    """
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    root = Path(data_root)
    path = root / ENSEMBLE_INDEX_PATH
    previous = _read_valid(path, validate_ensemble_index)
    official = _read_valid(root / OFFICIAL_INDEX_PATH, validate_official_index)
    if official is None:
        if previous is not None:
            return previous
        return atomic_write_json(validate_ensemble_index(empty_index(now)), path, prefix='.tropical-ensemble-')
    models_index = _read_valid(root / MODELS_INDEX_PATH, validate_models_index)
    saved = read_previous_files(root, previous)
    official_files = read_previous_official(root, official)
    started = clock()
    if policy is None:
        # One window for both sources from the task start (11g G5): no new request,
        # retry or chunk read of this task starts after the time limit.
        policy = HttpPolicy(max_requests=TASK_MAX_REQUESTS, max_seconds=TIME_LIMIT_SECONDS, wait=wait,
                            clock=clock, window_start=started)
    with http_scope(policy):
        client = ModelClient(transport, wait=wait, clock=clock)
        index, outputs = run_ensemble(official, previous, saved, official_files, models_index, now,
                                      client.get, clock, started=started)
    index = validate_ensemble_index(index)
    for name, data in sorted(outputs.items()):
        try:
            validate_ensemble_file(name, data)
        except ValueError:
            continue  # Should not happen; the saved file (if any) stays.
        atomic_write_compact_json(data, root / name, prefix='.tropical-ensemble-')
    return atomic_write_json(index, path, prefix='.tropical-ensemble-')


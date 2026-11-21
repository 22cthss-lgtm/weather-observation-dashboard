"""tropical_ensemble (S9): contract, parsers, task, limits, prune and pipeline isolation.

Real NOAA/ECMWF ensemble samples (fixtures/tropical/README.md) and synthetic
cases; fixed instants; fake transport and clock; the network is blocked
(design.md 9.2, 9.3).
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tropical_testing as tt
from tropical_testing import FakeTransport, fixture, quiet_policy, record, result

from src import tropical_ensemble as ens
from src import tropical_official as official
from src.services import tropical_ecmwf, tropical_noaa
from src.snapshot_runner import _prune_tropical, belongs
from src.snapshots import REQUIRED, allowed_path, validate_resource
from src.tropical_contract import (ENSEMBLE_INDEX_PATH, MODELS_INDEX_PATH, OFFICIAL_INDEX_PATH,
                                   validate_ensemble_file, validate_ensemble_index, validate_official_index)
from src.tropical_models import AllSourcesFailed

UTC = timezone.utc
NOW = datetime(2026, 11, 11, 6, 0, tzinfo=UTC)  # GEFS 00Z and IFS-ENS 18Z samples are due
CEMPAKA = '2026-jtwc-31w'
PENA = '2026-jtwc-04c'
GEFS = json.loads(fixture('noaa_gefs_2026111100_members.json'))['files']
AIGEFS = json.loads(fixture('noaa_aigefs_2026111106_members.json'))['files']


REAL_DECODE = tropical_ecmwf.decode_tracks
_decoded = {}
_decode_patch = None


def cached_decode(body):
    """The decoder is pure; decoding the same 0.3 MB sample once keeps the
    suite (run by every publishing round) short. ParserTests use the real one."""
    key = bytes(body)
    if key not in _decoded:
        try:
            _decoded[key] = REAL_DECODE(body)
        except ValueError:
            _decoded[key] = None
    if _decoded[key] is None:
        raise ValueError('Invalid ECMWF tropical cyclone BUFR')
    return deepcopy(_decoded[key])


def setUpModule():
    global _decode_patch
    tt.block_network()
    _decode_patch = patch.object(tropical_ecmwf, 'decode_tracks', cached_decode)
    _decode_patch.start()


def tearDownModule():
    _decode_patch.stop()
    tt.unblock_network()


def official_index(*records, now, previous=None):
    by = {agency: [item for item in records if item['agency'] == agency] for agency in ('cwa', 'jma', 'jtwc')}
    index = official.build_index(previous, tt.results(cwa=result(*by['cwa']), jma=result(*by['jma']),
                                                   jtwc=result(*by['jtwc'])), now)
    return validate_official_index(index)


def cempaka(when, lat=27.7, lon=146.8, **options):
    return record('jtwc', when=when, name='CEMPAKA', lat=lat, lon=lon, **options)


def pena(when, lat=10.5, lon=-165.8, **options):
    return record('jtwc', when=when, name='PENA', number='04C', lat=lat, lon=lon, origin_basin='CP', **options)


def cycle_of(moment):
    return moment.strftime('%Y%m%d%H')


def routes_at(now, status=404):
    """Every URL the task may request at ``now`` (both window cycles of every ensemble)."""
    routes = {}
    for model in ens.ORDER:
        for moment in ens.window(model, now):
            cycle = cycle_of(moment)
            if ens.SOURCE_OF[model] == 'ecmwf':
                routes[tropical_ecmwf.track_url(model, cycle)] = status
            else:
                for code in tropical_noaa.ENSEMBLE[model][1]:
                    routes[tropical_noaa.member_url(model, code, cycle)] = status
    return routes


def gefs_routes(routes, cycle='2026111100', skip=()):
    for code, text in GEFS.items():
        if code not in skip:
            routes[tropical_noaa.member_url('gefs', code, cycle)] = text.replace('2026111100', cycle).encode()
    return routes


def sample_routes(now=NOW):
    routes = gefs_routes(routes_at(now))
    routes[tropical_ecmwf.track_url('ifs-ens', '2026111018')] = fixture('ecmwf_ifs_2026111018_enfo.bufr')
    return routes


def write_json(root, name, data):
    path = Path(root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def run(root, routes, now, clock=lambda: 0.0):
    transport = FakeTransport(routes)
    index = ens.update_tropical_ensemble(root, now=now, transport=transport, wait=lambda s: None,
                                         clock=clock, policy=quiet_policy())
    return index, transport


def member_file(identity=CEMPAKA, cycle='2026111100', model='gefs', members=None):
    provider = 'NOAA' if model in ('gefs', 'aigefs') else 'ECMWF'
    first = 'ac00' if model == 'gefs' else 'a000' if model == 'aigefs' else '1'
    return {'schema_version': 1, 'cyclone_id': identity, 'model': model, 'cycle': cycle,
            'init_time': datetime.strptime(cycle, '%Y%m%d%H').strftime('%Y-%m-%dT%H:00:00Z'),
            'fetched_at': '2026-11-11T06:00:00Z', 'provider': provider,
            'source_id': 'WP31' if provider == 'NOAA' else '38W',
            'match': 'jtwc_id' if provider == 'NOAA' else 'name', 'wind_unit': 'kt' if provider == 'NOAA' else 'm/s',
            'members_expected': {'gefs': 31, 'aigefs': 31, 'ifs-ens': 51, 'aifs-ens': 52}[model],
            'members': members if members is not None else [
                {'m': first, 'type': None if provider == 'NOAA' else 4,
                 'track': [[0, 27.7, 146.8, 984, 60], [6, 28.6, 149.5, 986, 58]]}]}


def ensemble_index(storms=None, checked=None, basis=None):
    return {'schema_version': 1, 'fetched_at': '2026-11-11T06:00:00Z',
            'sources': {'noaa': {'state': 'ok', 'error_code': None}, 'ecmwf': {'state': 'idle', 'error_code': None}},
            'match_basis': basis or [], 'checked': checked or {},
            'storms': storms if storms is not None else {
                CEMPAKA: {'cycles': [{'cycle': '2026111100',
                                      'models': {'gefs': {'members': 1, 'members_expected': 31}}}]}}}


def edit(path, value):
    def change(data):
        target = data
        for key in path[:-1]:
            target = target[key]
        if value is DELETE:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        return data
    return change


DELETE = object()


class ContractTests(unittest.TestCase):
    def test_valid_files_pass_and_are_allowed_but_never_required(self):
        name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        self.assertEqual(validate_ensemble_index(ensemble_index()), ensemble_index())
        self.assertEqual(validate_ensemble_file(name, member_file()), member_file())
        for model in ('aigefs', 'ifs-ens', 'aifs-ens'):
            path = f'tropical/ensemble/storms/2026-jtwc-31w/2026111100/{model}.json'
            validate_ensemble_file(path, member_file(model=model))
            self.assertTrue(allowed_path(path))
            self.assertTrue(belongs(path, 'tropical_ensemble'))
            self.assertFalse(belongs(path, 'tropical_models'))
        validate_resource(ENSEMBLE_INDEX_PATH, ensemble_index())
        validate_resource(name, member_file())
        for path in (ENSEMBLE_INDEX_PATH, name):
            self.assertTrue(allowed_path(path))
            self.assertNotIn(path, REQUIRED)
        for path in ('tropical/ensemble/storms/2026-jtwc-31w/2026111100/gfs.json',
                     'tropical/ensemble/storms/2026-jtwc-31w/2026111103/gefs.json',
                     'tropical/ensemble/storms/2026-jtwc-31w/gefs.json', 'tropical/ensemble/index.json.bak',
                     'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json/x'):
            self.assertFalse(allowed_path(path), path)

    def test_each_violation_is_rejected_with_value_error_only(self):
        name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        noaa_member = {'m': 'ap01', 'type': None, 'track': [[0, 1.0, 2.0, None, None]]}
        file_cases = {
            'extra field': edit(('extra',), 1),
            'model differs from path': edit(('model',), 'aigefs'),
            'cycle differs from path': edit(('cycle',), '2026111106'),
            'init time': edit(('init_time',), '2026-11-11T06:00:00Z'),
            'provider': edit(('provider',), 'ECMWF'),
            'wind unit': edit(('wind_unit',), 'm/s'),
            'source id': edit(('source_id',), '31W'),
            'match': edit(('match',), 'name'),
            'members expected': edit(('members_expected',), 30),
            'no members': edit(('members',), []),
            'unknown member code': edit(('members', 0, 'm'), 'ap31'),
            'mean file': edit(('members', 0, 'm'), 'aemn'),
            'noaa type': edit(('members', 0, 'type'), 4),
            'duplicate member': lambda data: data['members'].append(deepcopy(data['members'][0])) or data,
            'unsorted members': lambda data: data['members'].insert(0, noaa_member) or data,
            'tau not increasing': edit(('members', 0, 'track', 1, 0), 0),
            'tau not multiple of 6': edit(('members', 0, 'track', 1, 0), 7),
            'too many points': edit(('members', 0, 'track'), [[6 * i, 1.0, 2.0, None, None] for i in range(82)]),
            'bad pressure': edit(('members', 0, 'track', 0, 3), 800),
            'bool wind': edit(('members', 0, 'track', 0, 4), True),
            'longitude 180': edit(('members', 0, 'track', 0, 2), 180.0),
        }
        for label, change in file_cases.items():
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    validate_ensemble_file(name, change(member_file()))
        ecmwf = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/ifs-ens.json'
        for label, change in {'member 52 of ifs-ens': edit(('members', 0, 'm'), '52'),
                              'member 0': edit(('members', 0, 'm'), '0'),
                              'padded member': edit(('members', 0, 'm'), '01'),
                              'type out of range': edit(('members', 0, 'type'), 256),
                              'numeric member id': edit(('members', 0, 'm'), 1)}.items():
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    validate_ensemble_file(ecmwf, change(member_file(model='ifs-ens')))
        # ECMWF ids sort as numbers: "2" before "10" (11g G9).
        members = [{'m': str(n), 'type': 4, 'track': [[0, 1.0, 2.0, None, None]]} for n in (2, 10)]
        validate_ensemble_file(ecmwf, member_file(model='ifs-ens', members=members))
        with self.assertRaises(ValueError):
            validate_ensemble_file(ecmwf, member_file(model='ifs-ens', members=members[::-1]))
        validate_ensemble_file(ecmwf, edit(('members', 0, 'type'), None)(member_file(model='ifs-ens')))
        storm = (('storms', CEMPAKA, 'cycles'))
        index_cases = {
            'extra field': edit(('bridge',), {}),
            'empty cycles': edit((*storm,), []),
            'three cycles': edit((*storm,), [{'cycle': c, 'models': {'gefs': {'members': 1, 'members_expected': 31}}}
                                             for c in ('2026111012', '2026111018', '2026111100')]),
            'cycles not increasing': edit((*storm,), [{'cycle': c, 'models': {'gefs': {'members': 1,
                                                                                       'members_expected': 31}}}
                                                      for c in ('2026111100', '2026111018')]),
            'unknown model': edit((*storm, 0, 'models'), {'gfs': {'members': 1, 'members_expected': 31}}),
            'empty models': edit((*storm, 0, 'models'), {}),
            'zero members': edit((*storm, 0, 'models', 'gefs', 'members'), 0),
            'too many members': edit((*storm, 0, 'models', 'gefs', 'members'), 32),
            'wrong expected': edit((*storm, 0, 'models', 'gefs', 'members_expected'), 51),
            'unsorted models': edit((*storm, 0, 'models'), {'gefs': {'members': 1, 'members_expected': 31},
                                                            'aigefs': {'members': 1, 'members_expected': 31}}),
            'five checked cycles': edit(('checked',), {c: {'gefs': {'complete': True, 'missing_files': []}} for c in
                                                       ('2026111006', '2026111012', '2026111018', '2026111100',
                                                        '2026111106')}),
            'checked as list': edit(('checked',), {'2026111100': ['gefs']}),
            'ecmwf missing files': edit(('checked',), {'2026111100': {'ifs-ens': {'complete': False,
                                                                                  'missing_files': ['1']}}}),
            'unknown missing code': edit(('checked',), {'2026111100': {'gefs': {'complete': False,
                                                                                'missing_files': ['a000']}}}),
            'unsorted missing': edit(('checked',), {'2026111100': {'gefs': {'complete': False,
                                                                            'missing_files': ['ap02', 'ap01']}}}),
            'complete as int': edit(('checked',), {'2026111100': {'gefs': {'complete': 1, 'missing_files': []}}}),
            'failed without code': edit(('sources', 'noaa', 'state'), 'failed'),
            'idle with code': edit(('sources', 'ecmwf', 'error_code'), 'timeout'),
            'unsafe code': edit(('sources', 'noaa'), {'state': 'failed', 'error_code': 'boom'}),
        }
        for label, change in index_cases.items():
            with self.subTest(label):
                with self.assertRaises(ValueError):
                    validate_ensemble_index(change(ensemble_index()))
        with self.assertRaises(ValueError):
            validate_resource(ENSEMBLE_INDEX_PATH, edit(('storms', CEMPAKA, 'cycles'), [])(ensemble_index()))


class ParserTests(unittest.TestCase):
    def test_member_urls_codes_and_ensemble_steps(self):
        self.assertEqual(len(tropical_noaa.ENSEMBLE['gefs'][1]), 31)
        self.assertEqual(tropical_noaa.ENSEMBLE['gefs'][1][:2], ('ac00', 'ap01'))
        self.assertEqual(tropical_noaa.ENSEMBLE['aigefs'][1][::30], ('a000', 'a030'))
        self.assertEqual(tropical_noaa.member_url('gefs', 'ac00', '2026111100'),
                         'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/gefs.20261111/00/'
                         'tctrack/ac00.t00z.cyclone.trackatcfunix')
        self.assertEqual(tropical_noaa.member_url('aigefs', 'a030', '2026123118'),
                         'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/aigefs.20261231/18/'
                         'tctrack/a030.t18z.cyclone.trackatcfunix')
        for bad in ('aemn', 'aimn', 'a000p', 'ap31', 'a000'):
            with self.assertRaises(ValueError):
                tropical_noaa.member_url('gefs', bad, '2026111100')
        self.assertEqual(tropical_ecmwf.track_url('ifs-ens', '2026111018'),
                         'https://data.ecmwf.int/forecasts/20261110/18z/ifs/0p25/enfo/20261110180000-144h-enfo-tf.bufr')
        self.assertEqual(tropical_ecmwf.track_url('ifs-ens', '2026111012'),
                         'https://data.ecmwf.int/forecasts/20261110/12z/ifs/0p25/enfo/20261110120000-360h-enfo-tf.bufr')
        self.assertEqual(tropical_ecmwf.track_url('aifs-ens', '2026111018'),
                         'https://data.ecmwf.int/forecasts/20261110/18z/aifs-ens/0p25/enfo/'
                         '20261110180000-360h-enfo-tf.bufr')
        # The deterministic URLs are unchanged (S8).
        self.assertEqual(tropical_ecmwf.track_url('ifs', '2026111018'),
                         'https://data.ecmwf.int/forecasts/20261110/18z/ifs/0p25/oper/20261110180000-144h-oper-tf.bufr')

    def test_real_member_files_parse_by_their_own_code(self):
        tracks = tropical_noaa.parse_atcf_code(GEFS['ac00'].encode(), 'ac00', '2026111100')
        self.assertEqual(sorted(tracks), [('CP', '04'), ('WP', '31')])
        self.assertEqual(tracks[('WP', '31')][0], [0, 27.7, 146.8, 988, 66])
        # Another member's code is a different file: its lines are not read.
        self.assertEqual(tropical_noaa.parse_atcf_code(GEFS['ac00'].encode(), 'ap01', '2026111100'), {})
        aigefs = tropical_noaa.parse_atcf_code(AIGEFS['a000'].encode(), 'a000', '2026111106')
        self.assertEqual(aigefs[('WP', '31')][0][:3], [0, 28.9, 150.0])

    def test_real_ensemble_bufr_keeps_members_and_types(self):
        tracks = REAL_DECODE(fixture('ecmwf_ifs_2026111018_enfo.bufr'))
        self.assertEqual({(t['id'], t['name']) for t in tracks}, {('38W', 'CEMPAKA')})
        self.assertEqual(len(tracks), 50)
        self.assertEqual({t['type'] for t in tracks}, {0, 4})
        self.assertEqual(max(t['member'] for t in tracks), 51)
        first = min(tracks, key=lambda t: t['member'])
        self.assertEqual(first['track'][:2], [[0, 26.9, 144.3, 988.0, 30.9], [6, 27.1, 146.4, 987.0, 25.7]])


class WindowTests(unittest.TestCase):
    def test_window_is_two_due_cycles_newest_first_across_the_year(self):
        self.assertEqual(ens.window('gefs', datetime(2027, 1, 1, 5, 14, tzinfo=UTC)),
                         [datetime(2026, 12, 31, 18, tzinfo=UTC), datetime(2026, 12, 31, 12, tzinfo=UTC)])
        self.assertEqual(ens.window('gefs', datetime(2027, 1, 1, 5, 15, tzinfo=UTC))[0],
                         datetime(2027, 1, 1, 0, tzinfo=UTC))
        self.assertEqual(ens.window('aigefs', NOW)[0], datetime(2026, 11, 11, 0, tzinfo=UTC))
        self.assertEqual(ens.window('ifs-ens', NOW), [datetime(2026, 11, 10, 18, tzinfo=UTC),
                                                      datetime(2026, 11, 10, 12, tzinfo=UTC)])

    def test_unfinished_cycles_older_than_the_window_are_given_up(self):
        checked = {'2026111012': {'gefs': {'complete': False, 'missing_files': ['ap01']}},
                   '2026111018': {'gefs': {'complete': False, 'missing_files': ['ap02']},
                                  'ifs-ens': {'complete': False, 'missing_files': []}}}
        ens.abandon_stale(checked, NOW)  # GEFS window: 00Z and 18Z; IFS-ENS: 18Z and 12Z
        self.assertEqual(checked['2026111012']['gefs'], {'complete': True, 'missing_files': ['ap01']})
        self.assertFalse(checked['2026111018']['gefs']['complete'])
        self.assertFalse(checked['2026111018']['ifs-ens']['complete'])


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def official(self, *records, now=NOW, previous=None):
        index = official_index(*records, now=now, previous=previous)
        write_json(self.root, OFFICIAL_INDEX_PATH, index)
        return index

    def saved(self, name):
        return json.loads((self.root / name).read_bytes())

    def test_real_members_of_both_sources_are_matched_and_written_compact(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t), pena(t))
        index, transport = run(self.root, sample_routes(), NOW)
        urls = transport.urls
        # ECMWF first; the newest IFS-ENS is published, AIFS-ENS falls back to the older cycle.
        self.assertEqual(urls[:3], [tropical_ecmwf.track_url('ifs-ens', '2026111018'),
                                    tropical_ecmwf.track_url('aifs-ens', '2026111018'),
                                    tropical_ecmwf.track_url('aifs-ens', '2026111012')])
        self.assertEqual(urls[3:34], [tropical_noaa.member_url('gefs', code, '2026111100')
                                      for code in tropical_noaa.ENSEMBLE['gefs'][1]])
        # AIGEFS: the probe of both window cycles is 404; no other member is asked.
        self.assertEqual(urls[34:], [tropical_noaa.member_url('aigefs', 'a000', c) for c in ('2026111100', '2026111018')])
        self.assertTrue(all(options['headers']['User-Agent'].startswith('weather-integration-static/')
                            for _, options in transport.calls))
        self.assertEqual(index['sources'], {s: {'state': 'ok', 'error_code': None} for s in ('noaa', 'ecmwf')})
        self.assertEqual(index['checked'], {'2026111018': {'ifs-ens': {'complete': True, 'missing_files': []}},
                                            '2026111100': {'gefs': {'complete': True, 'missing_files': []}}})
        expected = {code: bool(tropical_noaa.parse_atcf_code(text.encode(), code, '2026111100').get(('WP', '31')))
                    for code, text in GEFS.items()}
        gefs_name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        raw = (self.root / gefs_name).read_bytes()
        data = json.loads(raw)
        self.assertEqual(raw, (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
        self.assertEqual([m['m'] for m in data['members']], sorted(code for code, has in expected.items() if has))
        self.assertEqual((data['provider'], data['source_id'], data['match'], data['wind_unit'],
                          data['members_expected']), ('NOAA', 'WP31', 'jtwc_id', 'kt', 31))
        self.assertTrue(all(m['type'] is None for m in data['members']))
        self.assertEqual(data['members'][0]['track'][0], [0, 27.7, 146.8, 988, 66])
        ifs = self.saved('tropical/ensemble/storms/2026-jtwc-31w/2026111018/ifs-ens.json')
        self.assertEqual((ifs['source_id'], ifs['match'], ifs['wind_unit'], ifs['members_expected']),
                         ('38W', 'name', 'm/s', 51))
        self.assertEqual(len(ifs['members']), 50)
        self.assertEqual([m['m'] for m in ifs['members']][:3], ['1', '2', '3'])
        self.assertEqual({m['type'] for m in ifs['members']}, {0, 4})
        self.assertEqual(self.saved('tropical/ensemble/storms/2026-jtwc-04c/2026111100/gefs.json')['source_id'], 'CP04')
        self.assertEqual(index['storms'][CEMPAKA]['cycles'], [
            {'cycle': '2026111018', 'models': {'ifs-ens': {'members': 50, 'members_expected': 51}}},
            {'cycle': '2026111100', 'models': {'gefs': {'members': len(data['members']), 'members_expected': 31}}}])
        self.assertNotIn('2026111018', [c['cycle'] for c in index['storms'][PENA]['cycles']])  # PENA is not in it
        self.assertEqual(self.saved(ENSEMBLE_INDEX_PATH), index)
        self.assertIn(b'\n  "sources"', (self.root / ENSEMBLE_INDEX_PATH).read_bytes())
        # Same hour again: complete combinations are not asked; the older cycles are filled now.
        routes = gefs_routes(sample_routes(), cycle='2026111018')
        routes[tropical_ecmwf.track_url('ifs-ens', '2026111012')] = fixture('ecmwf_ifs_2026111018_enfo.bufr')
        index, again = run(self.root, routes, NOW)
        self.assertEqual(index['checked']['2026111018']['gefs'], {'complete': True, 'missing_files': []})
        # The 18Z BUFR asked as 12Z has no 12Z track: published, nothing for this system.
        self.assertEqual(index['checked']['2026111012'], {'ifs-ens': {'complete': True, 'missing_files': []}})
        self.assertEqual([c['cycle'] for c in index['storms'][CEMPAKA]['cycles']], ['2026111018', '2026111100'])
        self.assertNotIn(tropical_ecmwf.track_url('ifs-ens', '2026111018'), again.urls)
        self.assertNotIn(tropical_noaa.member_url('gefs', 'ap01', '2026111100'), again.urls)
        self.assertIn(tropical_ecmwf.track_url('ifs-ens', '2026111012'), again.urls)
        self.assertEqual(again.urls.count(tropical_noaa.member_url('gefs', 'ac00', '2026111018')), 1)

    def test_probe_not_published_costs_one_request_per_cycle(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        index = self.official(cempaka(t))
        active = [storm for storm in index['storms'] if storm['status'] == 'active']
        previous = ens.empty_index(NOW)
        previous['match_basis'] = ens.match_basis(active, {CEMPAKA: None})
        for model in ens.ORDER:  # the older cycle of every window is already complete
            older = cycle_of(ens.window(model, NOW)[1])
            previous['checked'].setdefault(older, {})[model] = {'complete': True, 'missing_files': []}
        asked = []
        result_index, outputs = ens.run_ensemble(index, previous, {}, {}, None, NOW,
                                                 lambda url: asked.append(url) or (403, b''))
        # Only the newest cycle of each ensemble is probed, once, and none is overdue yet.
        self.assertEqual(asked, [tropical_ecmwf.track_url('ifs-ens', '2026111018'),
                                 tropical_ecmwf.track_url('aifs-ens', '2026111018'),
                                 tropical_noaa.member_url('gefs', 'ac00', '2026111100'),
                                 tropical_noaa.member_url('aigefs', 'a000', '2026111100')])
        self.assertEqual(result_index['sources'], {s: {'state': 'ok', 'error_code': None} for s in ('noaa', 'ecmwf')})
        self.assertEqual(result_index['checked'], previous['checked'])
        self.assertEqual(outputs, {})
        # The older cycle is always past its overdue time (wait + 6 h): when it is
        # missing too for every product, both sources failed and the task fails.
        with self.assertRaises(AllSourcesFailed):
            run(self.root, routes_at(NOW, status=404), NOW)
        self.assertFalse((self.root / 'tropical/ensemble').exists())
        # One product published keeps its source ok (11e E14).
        routes = routes_at(NOW)
        routes[tropical_ecmwf.track_url('ifs-ens', '2026111018')] = fixture('ecmwf_ifs_2026111018_enfo.bufr')
        index, _ = run(self.root, routes, NOW)
        self.assertEqual(index['sources'], {'noaa': {'state': 'failed', 'error_code': 'http_error'},
                                            'ecmwf': {'state': 'ok', 'error_code': None}})

    def test_missing_members_are_recorded_and_only_they_are_asked_again(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        routes = gefs_routes(routes_at(NOW), skip=('ap05', 'ap17'))  # those two stay 404
        index, _ = run(self.root, routes, NOW)
        entry = index['checked']['2026111100']['gefs']
        self.assertEqual(entry, {'complete': False, 'missing_files': ['ap05', 'ap17']})
        name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        first = self.saved(name)
        self.assertNotIn('ap05', [m['m'] for m in first['members']])
        later = NOW + timedelta(hours=1)
        routes = gefs_routes(routes_at(later))
        index, transport = run(self.root, routes, later)
        gefs = [url for url in transport.urls if '/gefs.' in url]
        self.assertEqual(gefs, [tropical_noaa.member_url('gefs', code, '2026111100') for code in ('ap05', 'ap17')])
        self.assertEqual(index['checked']['2026111100']['gefs'], {'complete': True, 'missing_files': []})
        members = [m['m'] for m in self.saved(name)['members']]
        self.assertEqual(len(members), len(first['members']) + 2)
        self.assertEqual(members, sorted(members))

    def test_time_limit_stops_new_requests_and_leaves_the_rest_for_later(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        ticks = iter(range(0, 10_000, 4))
        index, transport = run(self.root, sample_routes(), NOW, clock=lambda: float(next(ticks)))
        asked = [url for url in transport.urls if '/gefs.' in url]
        self.assertLess(len(asked), 31)
        self.assertGreater(len(asked), 1)
        entry = index['checked']['2026111100']['gefs']
        self.assertFalse(entry['complete'])
        self.assertEqual(len(entry['missing_files']), 31 - len(asked))
        self.assertFalse(any('aigefs' in url for url in transport.urls))  # nothing starts after the limit
        self.assertEqual(index['sources']['noaa'], {'state': 'ok', 'error_code': None})

    def test_a_failure_stops_the_source_and_keeps_what_was_fetched(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        routes = sample_routes()
        routes[tropical_noaa.member_url('gefs', 'ap10', '2026111100')] = 500
        index, transport = run(self.root, routes, NOW)
        self.assertEqual(index['sources']['noaa']['state'], 'failed')
        self.assertEqual(index['sources']['ecmwf'], {'state': 'ok', 'error_code': None})
        self.assertFalse(any('aigefs' in url or 'ap11' in url for url in transport.urls))
        entry = index['checked']['2026111100']['gefs']
        self.assertEqual(entry['missing_files'], [f'ap{n:02d}' for n in range(10, 31)])
        members = [m['m'] for m in self.saved('tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json')['members']]
        self.assertTrue(set(members) <= {'ac00', *(f'ap{n:02d}' for n in range(1, 10))})
        # A broken member file is a parse error and stays missing.
        routes = sample_routes()
        routes[tropical_noaa.member_url('gefs', 'ap03', '2026111100')] = b'WP, 31\n'
        index = ens.run_ensemble(official_index(cempaka(t), now=NOW), None, {}, {}, None, NOW,
                                 lambda url: (200, routes[url]) if not isinstance(routes[url], int) else (routes[url], b''))[0]
        self.assertEqual(index['sources']['noaa'], {'state': 'failed', 'error_code': 'parse_error'})
        self.assertEqual(index['checked']['2026111100']['gefs']['missing_files'], ['ap03'])
        # A broken ECMWF file is not recorded: it is asked again next run.
        routes = sample_routes()
        routes[tropical_ecmwf.track_url('ifs-ens', '2026111018')] = b'BUFR broken'
        index = ens.run_ensemble(official_index(cempaka(t), now=NOW), None, {}, {}, None, NOW,
                                 lambda url: (200, routes[url]) if not isinstance(routes[url], int) else (routes[url], b''))[0]
        self.assertEqual(index['sources']['ecmwf'], {'state': 'failed', 'error_code': 'parse_error'})
        self.assertNotIn('2026111018', index['checked'])

    def test_both_sources_failed_writes_nothing(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        for failure in (500, tt_connection_error()):
            with self.subTest(repr(failure)):
                with self.assertRaises(AllSourcesFailed):
                    run(self.root, {url: failure for url in routes_at(NOW)}, NOW)
                self.assertFalse((self.root / 'tropical/ensemble').exists())

    def test_invalid_official_index_changes_nothing(self):
        index, transport = run(self.root, {}, NOW)
        self.assertEqual(transport.urls, [])
        self.assertEqual(index, ens.empty_index(NOW))
        before = (self.root / ENSEMBLE_INDEX_PATH).read_bytes()
        write_json(self.root, OFFICIAL_INDEX_PATH, {'schema_version': 99})
        index, transport = run(self.root, {}, NOW + timedelta(hours=1))
        self.assertEqual(transport.urls, [])
        self.assertEqual((self.root / ENSEMBLE_INDEX_PATH).read_bytes(), before)

    def test_no_active_system_requests_nothing_keeps_ended_and_drops_removed(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        first = self.official(cempaka(t), pena(t))
        run(self.root, sample_routes(), NOW)
        later = t + timedelta(hours=16)
        ended = self.official(cempaka(t), pena(t), now=later, previous=first)
        self.assertEqual({s['status'] for s in ended['storms']}, {'ended'})
        index, transport = run(self.root, {}, later)
        self.assertEqual(transport.urls, [])
        self.assertEqual(index['sources'], {s: {'state': 'idle', 'error_code': None} for s in ('noaa', 'ecmwf')})
        self.assertEqual(set(index['storms']), {CEMPAKA, PENA})
        # PENA leaves the official index: its entry goes, its files are left to the prune step.
        only = dict(ended, storms=[s for s in ended['storms'] if s['cyclone_id'] == CEMPAKA])
        write_json(self.root, OFFICIAL_INDEX_PATH, validate_official_index(only))
        index, _ = run(self.root, {}, later)
        self.assertEqual(set(index['storms']), {CEMPAKA})
        self.assertTrue((self.root / 'tropical/ensemble/storms/2026-jtwc-04c/2026111100/gefs.json').exists())
        self.assertEqual(_prune_tropical(self.root), ['tropical/ensemble/storms/2026-jtwc-04c/2026111100/gefs.json'])
        self.assertFalse((self.root / 'tropical/ensemble/storms/2026-jtwc-04c').exists())

    def test_bridge_of_the_models_index_is_used_and_tcvitals_never_asked(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        jma = record('jma', when=t, name='CEMPAKA', lat=27.7, lon=146.8)
        self.official(jma)
        identity = '2026-jma-tc2638'
        write_json(self.root, MODELS_INDEX_PATH, {
            'schema_version': 1, 'fetched_at': '2026-11-11T05:00:00Z',
            'sources': {'noaa': {'state': 'ok', 'error_code': None}, 'ecmwf': {'state': 'ok', 'error_code': None}},
            'match_basis': [f'{identity}|31W|CEMPAKA'], 'checked': {},
            'storms': {identity: {'bridge': {'jtwc': '31W'}, 'cycles': []}}})
        index, transport = run(self.root, sample_routes(), NOW)
        self.assertFalse(any('tcvitals' in url for url in transport.urls))
        self.assertEqual(index['match_basis'], [f'{identity}|31W|CEMPAKA'])
        data = self.saved(f'tropical/ensemble/storms/{identity}/2026111100/gefs.json')
        self.assertEqual((data['match'], data['source_id']), ('tcvitals', 'WP31'))
        # Without a readable models index the same system is matched by position instead.
        (self.root / MODELS_INDEX_PATH).write_text('{}', encoding='utf-8')
        index = ens.run_ensemble(official_index(jma, now=NOW), None, {}, {}, None, NOW,
                                 lambda url: (200, sample_routes()[url]) if not isinstance(sample_routes()[url], int)
                                 else (404, b''))[0]
        self.assertEqual(index['match_basis'], [f'{identity}||CEMPAKA'])

    def test_new_match_basis_clears_checked(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        run(self.root, sample_routes(), NOW)
        self.official(cempaka(t), pena(t))
        index, transport = run(self.root, sample_routes(), NOW)
        self.assertIn(tropical_noaa.member_url('gefs', 'ap01', '2026111100'), transport.urls)
        self.assertIn(PENA, index['storms'])

    def test_two_cycles_are_kept_and_the_prune_step_removes_older_files(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        run(self.root, sample_routes(), NOW)
        later = NOW + timedelta(hours=6)
        self.official(cempaka(later - timedelta(hours=1)), now=later)
        routes = gefs_routes(routes_at(later), cycle='2026111106')
        index, _ = run(self.root, routes, later)
        self.assertEqual([c['cycle'] for c in index['storms'][CEMPAKA]['cycles']], ['2026111100', '2026111106'])
        old = 'tropical/ensemble/storms/2026-jtwc-31w/2026111018/ifs-ens.json'
        self.assertTrue((self.root / old).exists())  # the task never deletes
        self.assertEqual(_prune_tropical(self.root), [old])
        self.assertFalse((self.root / 'tropical/ensemble/storms/2026-jtwc-31w/2026111018').exists())
        self.assertTrue((self.root / 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json').exists())

    def test_file_and_prefix_size_limits(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        self.official(cempaka(t))
        with patch.object(ens, 'MAX_FILE_BYTES', 1000):  # every real file is larger
            index, _ = run(self.root, sample_routes(), NOW)
        self.assertEqual(index['storms'], {})
        self.assertTrue(index['checked']['2026111018']['ifs-ens']['complete'])
        self.assertTrue(index['checked']['2026111100']['gefs']['complete'])
        self.assertFalse((self.root / 'tropical/ensemble/storms').exists())
        # A too large new version keeps the saved one (and its count in the index).
        (self.root / ENSEMBLE_INDEX_PATH).unlink()
        skip = tuple(f'ap{n:02d}' for n in range(5, 31))
        index, _ = run(self.root, gefs_routes(routes_at(NOW), skip=skip), NOW)
        name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        before = (self.root / name).read_bytes()
        later = NOW + timedelta(hours=1)
        with patch.object(ens, 'MAX_FILE_BYTES', len(before) + 10):
            index, _ = run(self.root, gefs_routes(routes_at(later)), later)
        self.assertEqual((self.root / name).read_bytes(), before)
        self.assertEqual(index['storms'][CEMPAKA]['cycles'][0]['models']['gefs']['members'],
                         len(json.loads(before)['members']))
        self.assertTrue(index['checked']['2026111100']['gefs']['complete'])

    def test_prefix_limit_drops_ended_systems_first_then_older_cycles(self):
        t = datetime(2026, 11, 11, 0, tzinfo=UTC)
        both = official_index(cempaka(t), pena(t), now=NOW)
        index, outputs = ens.run_ensemble(both, None, {}, {}, None, NOW,
                                          lambda url: (200, sample_routes()[url])
                                          if not isinstance(sample_routes()[url], int) else (404, b''))
        saved = {tuple(name.split('/')[3:5]) + (name.split('/')[5][:-5],): data for name, data in outputs.items()}
        later = t + timedelta(hours=16)
        mixed = official_index(cempaka(later - timedelta(hours=1)), pena(t), now=later,
                               previous=official_index(cempaka(t), pena(t), now=NOW))
        self.assertEqual({s['cyclone_id']: s['status'] for s in mixed['storms']}, {CEMPAKA: 'active', PENA: 'ended'})
        sizes = {key: ens._size(data, True) for key, data in saved.items()}
        pena_size = sum(size for key, size in sizes.items() if key[0] == PENA)
        full, _ = ens.run_ensemble(mixed, index, saved, {}, None, later, lambda url: (404, b''))
        total = ens._size(full, False) + sum(sizes.values())
        with patch.object(ens, 'MAX_PREFIX_BYTES', total - 1):
            limited, _ = ens.run_ensemble(mixed, index, saved, {}, None, later, lambda url: (404, b''))
        self.assertNotIn(PENA, limited['storms'])
        self.assertEqual(len(limited['storms'][CEMPAKA]['cycles']), 2)
        with patch.object(ens, 'MAX_PREFIX_BYTES', total - pena_size - 1000):  # the 18Z file is larger
            limited, _ = ens.run_ensemble(mixed, index, saved, {}, None, later, lambda url: (404, b''))
        self.assertEqual([c['cycle'] for c in limited['storms'][CEMPAKA]['cycles']], ['2026111100'])


class VirtualClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += max(0.0, seconds)


class TimeBoundTests(unittest.TestCase):
    """The default policy of the task: one 240 s window for both sources (11g G5)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        write_json(self.root, OFFICIAL_INDEX_PATH, official_index(cempaka(datetime(2026, 11, 11, 0, tzinfo=UTC)),
                                                                 now=NOW))

    def tearDown(self):
        self.temp.cleanup()

    def elapsed(self, behaviour):
        clock = VirtualClock()
        routes = sample_routes()

        def transport(url, **options):
            return behaviour(url, options, clock, routes)
        try:
            ens.update_tropical_ensemble(self.root, now=NOW, transport=transport, wait=clock.sleep, clock=clock)
        except AllSourcesFailed:
            pass
        return clock.t

    def test_window_start_fixes_every_source_window(self):
        from src.http_client import HttpPolicy, SourceBudgetExceeded
        clock = VirtualClock()
        policy = HttpPolicy(max_seconds=240, clock=clock, window_start=0.0)
        clock.sleep(200)
        self.assertEqual(policy.reserve('https://nomads.ncep.noaa.gov/x'), 40)
        clock.sleep(41)
        with self.assertRaises(SourceBudgetExceeded):
            policy.reserve('https://data.ecmwf.int/y')  # its first request, but the window has passed
        default = HttpPolicy(max_seconds=240, clock=clock)
        self.assertEqual(default.reserve('https://data.ecmwf.int/y'), 240)  # unchanged without it

    def test_slow_or_hanging_sources_never_run_past_the_limit(self):
        import requests

        def hang(url, options, clock, routes):
            clock.sleep(options['timeout'])
            raise requests.Timeout('virtual')

        def slow(url, options, clock, routes):
            clock.sleep(min(14.0, options['timeout']))  # each answer takes (almost) its whole timeout
            route = routes[url]
            return tt.FakeResponse(route) if isinstance(route, int) else tt.FakeResponse(200, route)

        def ecmwf_hangs(url, options, clock, routes):
            return (hang if 'ecmwf' in url else slow)(url, options, clock, routes)
        for behaviour in (hang, slow, ecmwf_hangs):
            with self.subTest(behaviour.__name__):
                self.assertLessEqual(self.elapsed(behaviour), ens.TIME_LIMIT_SECONDS + 1)

    def test_reaching_the_limit_is_not_a_source_failure(self):
        """Review S1: slow NOAA answers cut by the shared window, ECMWF broken.
        NOAA stays ok, what it fetched is written, the rest is left for next run."""
        def ecmwf_down_noaa_slow(url, options, clock, routes):
            if 'ecmwf' in url:
                clock.sleep(1.0)
                return tt.FakeResponse(503)
            clock.sleep(min(9.0, options['timeout']))
            route = routes[url]
            return tt.FakeResponse(route) if isinstance(route, int) else tt.FakeResponse(200, route)
        clock = VirtualClock()
        routes = sample_routes()
        index = ens.update_tropical_ensemble(
            self.root, now=NOW, transport=lambda url, **options: ecmwf_down_noaa_slow(url, options, clock, routes),
            wait=clock.sleep, clock=clock)
        self.assertEqual(index['sources']['noaa'], {'state': 'ok', 'error_code': None})
        self.assertEqual(index['sources']['ecmwf']['state'], 'failed')
        entry = index['checked']['2026111100']['gefs']
        self.assertFalse(entry['complete'])
        self.assertTrue(entry['missing_files'])
        self.assertIn(CEMPAKA, index['storms'])
        self.assertLessEqual(clock.t, ens.TIME_LIMIT_SECONDS + 1)
        # A real hang early in the run is still a failure of that source.
        clock = VirtualClock()

        def early_hang(url, options, clock_, routes_):
            import requests
            clock.sleep(options['timeout'])
            raise requests.Timeout('virtual')
        with self.assertRaises(AllSourcesFailed):
            ens.update_tropical_ensemble(self.root, now=NOW,
                                         transport=lambda url, **options: early_hang(url, options, clock, routes),
                                         wait=clock.sleep, clock=clock)


def tt_connection_error():
    import requests
    return requests.ConnectionError('offline')


class PruneTests(unittest.TestCase):
    def test_only_unlisted_ensemble_files_are_removed_and_other_prefixes_are_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = 'tropical/ensemble/storms/2026-jtwc-31w'
            listed, other_model = f'{base}/2026111100/gefs.json', f'{base}/2026111100/aigefs.json'
            old_cycle, gone = f'{base}/2026111018/ifs-ens.json', 'tropical/ensemble/storms/2026-jtwc-04c/2026111100/gefs.json'
            odd = f'{base}/2026111100/notes.txt'
            models_file = 'tropical/models/storms/2026-jtwc-04c/2026111100.json'
            for name in (listed, other_model, old_cycle, gone):
                parts = name.split('/')
                write_json(root, name, member_file(parts[3], parts[4], parts[5][:-5]))
            (root / odd).write_text('x')
            (root / models_file).parent.mkdir(parents=True)
            (root / models_file).write_text('{}')  # no models index: nothing under models is touched
            write_json(root, ENSEMBLE_INDEX_PATH, ensemble_index())
            self.assertEqual(sorted(_prune_tropical(root)), sorted([other_model, old_cycle, gone]))
            self.assertTrue((root / listed).exists() and (root / odd).exists() and (root / models_file).exists())
            self.assertFalse((root / f'{base}/2026111018').exists())
            self.assertFalse((root / 'tropical/ensemble/storms/2026-jtwc-04c').exists())
            self.assertTrue((root / 'tropical/ensemble/storms').is_dir())
            # An invalid ensemble index removes nothing under the prefix.
            write_json(root, gone, member_file('2026-jtwc-04c'))
            (root / ENSEMBLE_INDEX_PATH).write_text('{"schema_version": 2}', encoding='utf-8')
            self.assertEqual(_prune_tropical(root), [])
            self.assertTrue((root / gone).exists())


class PipelineTests(unittest.TestCase):
    """The ensemble task inside prepare_due beside image, official and models tasks."""

    def test_ensemble_failure_leaves_everything_else_unchanged(self):
        from test_tropical_pipeline import FEW, image_view, make_update, package, prepare, subset
        from src.snapshots import read_resources
        name = 'tropical/ensemble/storms/2026-jtwc-31w/2026111100/gefs.json'
        compact = (json.dumps(member_file(), separators=(',', ':')) + '\n').encode()

        def writer(kind, images):
            if kind != 'tropical_ensemble':
                raise RuntimeError('private official failure')
            root = Path(images).parent
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(compact)
            write_json(root, ENSEMBLE_INDEX_PATH, ensemble_index())

        def broken(kind, images):
            raise RuntimeError('private ensemble failure')

        def half(kind, images):
            if kind == 'tropical_ensemble':
                writer(kind, images)
                raise RuntimeError('private ensemble failure')
            raise RuntimeError('private official failure')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            sha = package(root)['sha256']
            tasks = subset(*FEW, 'tropical_official', 'tropical_models', 'tropical_ensemble')
            done = prepare(root, 'ok', make_update(writer), tasks=tasks, sha=sha)
            self.assertEqual(done['checks']['tropical_ensemble']['state'], 'updated')
            site = root / 'ok/site-data'
            self.assertEqual((site / name).read_bytes(), compact)
            files, _ = read_resources(site)
            self.assertIn(ENSEMBLE_INDEX_PATH, files)
            for label, update in (('ensemble fails', make_update(broken)), ('fails after writing', make_update(half))):
                with self.subTest(label):
                    out, ctl = f'failed-{len(label)}', f'control-{len(label)}'
                    failed = prepare(root, out, update, tasks=tasks, sha=sha)
                    control = prepare(root, ctl, make_update(broken), tasks=subset(*FEW), sha=sha)
                    self.assertEqual(image_view(failed, root, out, FEW), image_view(control, root, ctl, FEW))
                    for field in ('deploy', 'save_snapshot', 'deployment_reason'):
                        self.assertEqual(failed[field], control[field], field)
                    self.assertEqual(failed['checks']['tropical_ensemble']['state'], 'retained_after_failure')
                    self.assertEqual(failed['products']['tropical_ensemble'], 'failed')
                    self.assertNotIn('private ensemble failure', json.dumps(failed))
                    data = root / out / ('site-data' if (root / out / 'site-data').exists() else 'seed')
                    self.assertFalse((data / 'tropical/ensemble').exists())


if __name__ == '__main__':
    unittest.main()

"""Reference implementation of the Bedah Dapil calculations, and generator of test fixtures.

The TypeScript implementation in e-Partai must reproduce fixtures.json exactly.

Usage:
    python3 reference_calc.py export fixtures.json
"""
import collections
import csv
import json
import math
import os
import re
import sys

NATIONAL_THRESHOLD = 0.04
STANDOUT_LIMIT = 10
PARTY_PILLAR_SHARE = 0.4
TITLE_TOKENS = {
    'H', 'HJ', 'HAJI', 'HAJJAH', 'DR', 'DRS', 'DRA', 'IR', 'PROF', 'KH', 'K', 'TGK', 'TEUNGKU', 'USTADZ', 'UST', 'DRG', 'APT', 'NS',
    'RADEN', 'RA', 'RM', 'ANDI', 'SE', 'SH', 'ST', 'SS', 'SIP', 'SSOS', 'SPD', 'SPDI', 'SAG', 'SKOM', 'SKM', 'SIKOM', 'SPT', 'SP', 'SHI',
    'SKEP', 'SSI', 'STP', 'SHUT', 'SPSI', 'SPI', 'SEI', 'STHI', 'SFARM', 'SKED', 'AMD', 'AMDKEB', 'AMDKEP', 'AMK', 'MM', 'MH', 'MSI',
    'MPD', 'MPDI', 'MAP', 'MKES', 'MKN', 'MAG', 'MT', 'MBA', 'MA', 'MSC', 'MHUM', 'MIKOM', 'ME', 'MSOS', 'MIP', 'MHI', 'MKOM', 'MAK',
    'MSM', 'LC', 'BA', 'BSC', 'PHD', 'SPOG', 'SPA', 'SPB', 'SPPD', 'CA', 'AK',
}


def normalize_person_name(name):
    """Upper case; delete dots and apostrophes; every other non-letter becomes a space; drop title tokens."""
    tokens = re.sub(r'[^A-Z]', ' ', name.upper().replace('.', '').replace("'", '')).split()
    kept = [token for token in tokens if token not in TITLE_TOKENS]
    return ' '.join(kept)


def allocate_seats(votes_by_party, seats):
    """Sainte-Laguë with divisors 1, 3, 5, ... Returns (seats per party, winning quotients, highest first).

    Ties are broken by more party votes, then by lower partai_id.
    """
    quotients = []
    for party_id, votes in votes_by_party.items():
        if votes <= 0:
            continue
        for index in range(seats):
            quotients.append((votes / (2 * index + 1), votes, -party_id, party_id))
    quotients.sort(reverse=True)
    seats_by_party = collections.Counter()
    for _, _, _, party_id in quotients[:seats]:
        seats_by_party[party_id] += 1
    return seats_by_party, [entry[0] for entry in quotients[:seats]]


def votes_needed_for_seats(votes_by_party, seats, party_id, wanted_seats):
    """Smallest party total that wins `wanted_seats` seats, all other parties unchanged. None if impossible."""
    if wanted_seats < 1 or wanted_seats > seats:
        return None
    other_quotients = sorted(
        (votes / (2 * index + 1) for other_id, votes in votes_by_party.items() if other_id != party_id and votes > 0 for index in range(seats)),
        reverse=True,
    )
    # The party's n-th quotient must beat the (seats - n + 1)-th best quotient of everyone else.
    position = seats - wanted_seats
    if position >= len(other_quotients):
        return 1
    return math.floor(other_quotients[position] * (2 * wanted_seats - 1)) + 1


def analyse_dapil(dapil, votes_by_party, candidates, eligible_party_ids, own_party_id):
    seats = int(dapil['jumlah_kursi']) if dapil['jumlah_kursi'] else None
    total_votes = sum(votes_by_party.values())
    result = {
        'pemilu': int(dapil['pemilu']), 'tingkat': dapil['tingkat'], 'kode_dapil': dapil['kode_dapil'], 'nama_dapil': dapil['nama_dapil'],
        'jumlah_kursi': seats, 'total_suara_sah': total_votes, 'dapat_dihitung': seats is not None and total_votes > 0,
    }
    if not result['dapat_dihitung']:
        return result
    counted = {party_id: votes for party_id, votes in votes_by_party.items() if eligible_party_ids is None or party_id in eligible_party_ids}
    seats_by_party, winning = allocate_seats(counted, seats)
    result['harga_kursi_terakhir'] = math.ceil(winning[-1]) if winning else None
    result['partai'] = [
        {'partai_id': party_id, 'suara': votes, 'kursi': seats_by_party.get(party_id, 0), 'lolos_ambang_batas': eligible_party_ids is None or party_id in eligible_party_ids}
        for party_id, votes in sorted(votes_by_party.items(), key=lambda item: (-item[1], item[0]))
    ]

    own_votes = votes_by_party.get(own_party_id, 0)
    own_seats = seats_by_party.get(own_party_id, 0)
    own_candidates = sorted((row for row in candidates if int(row['partai_id']) == own_party_id), key=lambda row: (-int(row['suara']), int(row['nomor_urut'])))
    own_eligible = eligible_party_ids is None or own_party_id in eligible_party_ids
    target_first_seat = votes_needed_for_seats(counted, seats, own_party_id, 1)
    target_next_seat = votes_needed_for_seats(counted, seats, own_party_id, own_seats + 1)
    # The personal bar: the party's last seated candidate, or its top candidate when it holds no seat.
    bar_index = max(own_seats, 1) - 1
    personal_bar = int(own_candidates[bar_index]['suara']) if len(own_candidates) > bar_index else None
    result['partai_sendiri'] = {
        'partai_id': own_party_id, 'suara': own_votes, 'kursi': own_seats, 'lolos_ambang_batas': own_eligible,
        'target_suara_kursi_pertama': target_first_seat,
        'selisih_kursi_pertama': own_votes - target_first_seat if target_first_seat is not None else None,
        'target_suara_kursi_berikutnya': target_next_seat,
        'kekurangan_kursi_berikutnya': max(target_next_seat - own_votes, 0) if target_next_seat is not None else None,
        'suara_caleg_batas': personal_bar,
    }

    seated_votes = [int(row['suara']) for row in candidates if int(row['kursi_ke']) > 0]
    lowest_seated = min(seated_votes) if seated_votes else None
    rank_in_party = {}
    by_party = collections.defaultdict(list)
    for row in candidates:
        by_party[int(row['partai_id'])].append(row)
    for rows in by_party.values():
        for rank, row in enumerate(sorted(rows, key=lambda row: (-int(row['suara']), int(row['nomor_urut']))), start=1):
            rank_in_party[(int(row['partai_id']), int(row['nomor_urut']))] = rank
    standouts = []
    not_seated = sorted((row for row in candidates if int(row['kursi_ke']) == 0 and int(row['suara']) > 0), key=lambda row: (-int(row['suara']), int(row['partai_id']), int(row['nomor_urut'])))
    for row in not_seated[:STANDOUT_LIMIT]:
        party_id, number, votes = int(row['partai_id']), int(row['nomor_urut']), int(row['suara'])
        party_total = votes_by_party.get(party_id, 0)
        rank = rank_in_party[(party_id, number)]
        standouts.append({
            'partai_id': party_id, 'nomor_urut': number, 'nama': row['nama'], 'suara': votes,
            'persen_suara_dapil': round(votes / total_votes * 100, 2),
            'rasio_terhadap_terpilih_terendah': round(votes / lowest_seated, 2) if lowest_seated else None,
            'penopang_partai': party_total > 0 and votes / party_total >= PARTY_PILLAR_SHARE,
            'melampaui_nomor_urut': number >= 3 and rank <= 2,
            'partai_sendiri': party_id == own_party_id,
        })
    result['tokoh_menonjol'] = standouts
    return result


def main():
    export_dir, fixture_path = os.path.expanduser(sys.argv[1]), os.path.expanduser(sys.argv[2])
    read = lambda name: list(csv.DictReader(open(os.path.join(export_dir, name), encoding='utf-8')))
    key = lambda row: (row['pemilu'], row['tingkat'], row['kode_dapil'])
    party_code = {(row['pemilu'], int(row['partai_id'])): row['kode_partai'] for row in read('partai.csv')}
    own_party = {election: next(party_id for (year, party_id), code in party_code.items() if year == election and code == 'pan') for election in ('2024', '2019')}
    votes = collections.defaultdict(dict)
    for row in read('suara_partai.csv'):
        votes[key(row)][int(row['partai_id'])] = int(row['suara'])
    candidates = collections.defaultdict(list)
    for row in read('caleg.csv'):
        candidates[key(row)].append(row)
    national = collections.defaultdict(collections.Counter)
    for (election, level, _), by_party in votes.items():
        if level == 'dpr_ri':
            national[election].update(by_party)
    eligible = {election: sorted(party for party, total in totals.items() if total / sum(totals.values()) >= NATIONAL_THRESHOLD) for election, totals in national.items()}

    dapil_rows = read('dapil.csv')
    analysed = {}
    for dapil in dapil_rows:
        eligible_ids = set(eligible[dapil['pemilu']]) if dapil['tingkat'] == 'dpr_ri' else None
        analysed[key(dapil)] = analyse_dapil(dapil, votes.get(key(dapil), {}), candidates.get(key(dapil), []), eligible_ids, own_party[dapil['pemilu']])

    # A spread of cases: own party with 1 seat, several seats, no seat, and a dapil that cannot be computed.
    picks = [('2024', 'dpr_ri', '1101'), ('2019', 'dpr_ri', '1101')]
    def first(predicate):
        return next(k for k, value in sorted(analysed.items()) if predicate(k, value))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dpr_ri' and v['dapat_dihitung'] and v['partai_sendiri']['kursi'] == 0))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dpr_ri' and v['dapat_dihitung'] and v['partai_sendiri']['kursi'] >= 2))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dprd_provinsi' and v['dapat_dihitung'] and v['partai_sendiri']['kursi'] >= 2))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dprd_kabupaten_kota' and v['dapat_dihitung'] and v['partai_sendiri']['kursi'] == 0 and v['partai_sendiri']['suara'] > 0))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dprd_kabupaten_kota' and v['dapat_dihitung'] and v['partai_sendiri']['kursi'] == 1))
    picks.append(first(lambda k, v: k[0] == '2024' and k[1] == 'dprd_kabupaten_kota' and not v['dapat_dihitung']))

    summary = collections.Counter()
    for (election, level, _), value in analysed.items():
        summary[f'{election}/{level} dapil'] += 1
        if value['dapat_dihitung']:
            summary[f'{election}/{level} computable'] += 1
            summary[f'{election}/{level} own party seats'] += value['partai_sendiri']['kursi']
            summary[f'{election}/{level} dapil where own party has a seat'] += 1 if value['partai_sendiri']['kursi'] > 0 else 0

    fixtures = {
        'own_party_code': 'pan',
        'national_threshold': NATIONAL_THRESHOLD,
        'dpr_ri_parties_passing_threshold': eligible,
        'summary': dict(sorted(summary.items())),
        'dapil': [{'input': {'suara_partai': votes.get(k, {}), 'caleg': candidates.get(k, [])}, 'expected': analysed[k]} for k in picks],
        'person_name_normalisation': [[name, normalize_person_name(name)] for name in (
            'H. IRMAWAN S.Sos. M.M.', 'H. IRMAWAN, S.Sos, MM', 'Dr. Ir. H. NASIR DJAMIL, M.Si.', "MUHAMMAD NASIR DJAMIL, M.Si", 'Hj. ILLIZA SA\'ADUDDIN DJAMAL, S.E.', 'T. RIEFKY HARSYA')],
    }
    with open(fixture_path, 'w', encoding='utf-8') as fixture_file:
        json.dump(fixtures, fixture_file, ensure_ascii=False, indent=1)
    print(json.dumps(fixtures['summary'], indent=1))
    for item in fixtures['dapil']:
        expected = item['expected']
        print(expected['pemilu'], expected['tingkat'], expected['kode_dapil'], expected['nama_dapil'], '|', {k: v for k, v in expected.items() if k in ('jumlah_kursi', 'total_suara_sah', 'harga_kursi_terakhir', 'dapat_dihitung')}, expected.get('partai_sendiri'))
    print(fixtures['person_name_normalisation'])


if __name__ == '__main__':
    main()

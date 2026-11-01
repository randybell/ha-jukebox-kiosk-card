// Mock Music Assistant players for the 0.5.0 Speakers panel (dev harness only; every id is a placeholder).
// Reached through mass_queue.send_command (players/all, players/cmd/set_members, players/cmd/stop, player_queues/transfer).
// Topology: Everywhere = STATIC sync group (garage, living, kitchen; leader garage), Indoor = DYNAMIC (preset living, kitchen),
// Outdoor = DYNAMIC (preset garage). Speakers are WiiM-like players (provider 'wiim', hide_in_ui, not exposed to HA).
// Rules modelled on MA 2.10 (see the 0.5.0 plan): groups can't nest; groups may overlap and the newest one to start takes
// the speakers; set_members moves a speaker between playing groups (each keeps its own queue); moving a group's leader stops
// it and it re-forms after a gap; moving its last speaker dissolves it; a member of a playing STATIC group can't be taken
// alone: the whole static group stops; a speaker leading a playing native group is refused by set_members; a dynamic group
// powering on (transfer / play) takes its preset speakers from wherever they are, and if its would-be leader leads another
// group that whole group is hijacked. can_group_with is empty while another group holds a speaker.
// Live MA 2.10.9 (measured, see the plan §17): config/players/get gives a dynamic group's default members
// (values.group_members, dynamic_members); players/all lists an idle dynamic group's members too; set_members on an idle
// dynamic group answers 200 and the group stays idle; on a static group it is a 500 "Player X does not support group commands";
// dropping the leader keeps the group 'playing' while the next member re-forms it after ~5.9 s of silence; a transfer is
// ~4.7 s of silence and stops the source; player_queues/get has index_in_buffer (move_item at or before it: 500
// "<n> is already played/buffered"; delete_item there: 200, ignored). HA entities carry mass_player_id null.
// URL params: ma=split (Indoor plays living+kitchen with its own queue, Garage plays a radio station alone, Everywhere idle),
// ma=busy (Everywhere plays, Indoor idle: the default), grp=fail|slow|timeout (set_members), xfer=fail|slow|timeout (transfer),
// gap=<ms> (leader re-form gap, default 1200), malat=<ms> (players/* latency, default 40), xgap=<ms> (transfer silence,
// default 0), live=1 (live timings: gap 5900 with the group left 'playing' and the new leader silent, xgap 4700, set_members
// ~1 s, idle groups report a stale active_queue), qbuf=1 (MA buffered the next track: index_in_buffer = current + 1),
// macfg=deny (config/players/get refused, like a token without the config read scope).
export function createMa({ params, st, setState, commit, sleep, QS, syncNowPlaying, EVERY, libTracks, qItem }) {
  const INDOOR = 'media_player.indoor', OUTDOOR = 'media_player.outdoor';
  const SP = { living: 'wiim_mock_living', kitchen: 'wiim_mock_kitchen', garage: 'wiim_mock_garage' };
  const ROOM_OF = { [SP.living]: 'media_player.living_room', [SP.kitchen]: 'media_player.kitchen', [SP.garage]: 'media_player.garage' };
  const NAME = { [SP.living]: 'Living Room Speaker', [SP.kitchen]: 'Kitchen Speaker', [SP.garage]: 'Garage Speaker' };
  const G = {
    syncgroup_everywhere: { entity: EVERY, name: 'Everywhere', kind: 'static', preset: [SP.garage, SP.living, SP.kitchen], members: [SP.garage, SP.living, SP.kitchen] },
    syncgroup_mock_indoor: { entity: INDOOR, name: 'Indoor', kind: 'dynamic', preset: [SP.living, SP.kitchen], members: [] },
    syncgroup_mock_outdoor: { entity: OUTDOOR, name: 'Outdoor', kind: 'dynamic', preset: [SP.garage], members: [] },
  };
  const gidOf = (entity) => Object.keys(G).find((k) => G[k].entity === entity);
  const solo = {}; // speaker -> {state, title}
  const log = (window.__maLog = []);
  const events = (window.__maEvents = []);
  const LIVE = params.get('live') === '1';
  const GAP = Number(params.get('gap') ?? (LIVE ? 5900 : 1200));
  const XGAP = Number(params.get('xgap') ?? (LIVE ? 4700 : 0));
  const JOIN = LIVE ? 1000 : 0;
  const STALEAQ = LIVE || params.get('staleaq') === '1';
  const silent = {}; // group -> until (live re-form: the group says 'playing', its new leader is silent)
  const isSilent = (g) => (silent[g] ?? 0) > Date.now();
  const MALAT = Number(params.get('malat') ?? 40);
  const GRP = params.get('grp') ?? '', XFER = params.get('xfer') ?? '';

  const gState = (g) => st(G[g].entity)?.state ?? 'idle';
  const active = (g) => ['playing', 'paused', 'buffering'].includes(gState(g));
  const membersNow = (g) => (G[g].kind === 'static' ? (active(g) ? G[g].members : []) : active(g) ? G[g].members : []);
  const holder = (s, except) => Object.keys(G).find((g) => g !== except && active(g) && membersNow(g).includes(s));
  const leader = (g) => membersNow(g)[0];

  function players() {
    const out = [];
    for (const s of Object.values(SP)) {
      const h = holder(s);
      const isLead = h && leader(h) === s;
      const ms = h ? membersNow(h) : [];
      const free = Object.values(SP).filter((x) => x !== s && !holder(x));
      const vol = st(ROOM_OF[s])?.attributes?.volume_level ?? 0.5;
      out.push({
        player_id: s, provider: 'wiim', type: 'player', name: NAME[s], available: true, powered: true, hide_in_ui: true, expose_to_ha: false,
        playback_state: h ? (isSilent(h) && isLead ? 'idle' : gState(h)) : solo[s]?.state ?? 'idle',
        group_members: isLead ? [...ms] : [], static_group_members: [],
        can_group_with: h && !isLead ? [] : free, synced_to: h && !isLead ? leader(h) : null, active_group: h ?? null,
        supported_features: ['volume_set', 'volume_mute', 'pause', 'set_members'], volume_level: vol,
        current_media: h ? { title: st(G[h].entity)?.attributes?.media_title ?? null } : solo[s] ? { title: solo[s].title } : null,
      });
    }
    for (const [g, d] of Object.entries(G)) {
      out.push({
        player_id: g, provider: 'sync_group', type: 'group', name: d.name, available: true, powered: active(g), hide_in_ui: false, expose_to_ha: true,
        playback_state: active(g) ? gState(g) : 'idle',
        // live: an idle dynamic group still lists its (default / last set) members
        group_members: d.kind === 'static' ? [...d.members] : active(g) ? [...d.members] : [...(d.idle ?? d.preset)],
        static_group_members: d.kind === 'static' ? [...d.preset] : [], can_group_with: [], synced_to: null, active_group: null,
        supported_features: d.kind === 'static' ? ['volume_set', 'volume_mute', 'pause'] : ['volume_set', 'volume_mute', 'pause', 'set_members'],
        volume_level: st(d.entity)?.attributes?.volume_level ?? 0.5,
        current_media: active(g) ? { title: st(d.entity)?.attributes?.media_title ?? null } : null,
      });
    }
    return out;
  }
  /** HA side: group + room entities follow MA */
  function syncHa() {
    for (const [g, d] of Object.entries(G)) if (d.kind === 'dynamic') setState(d.entity, null, { group_members: membersNow(g).map((s) => ROOM_OF[s]),
      // live: an idle MA group entity reports another group's queue as active_queue
      active_queue: STALEAQ && !active(g) ? 'syncgroup_everywhere' : g });
    for (const s of Object.values(SP)) {
      const h = holder(s), room = ROOM_OF[s];
      if (h) setState(room, gState(h), { media_title: st(G[h].entity).attributes.media_title, media_artist: st(G[h].entity).attributes.media_artist, group_members: membersNow(h).map((x) => ROOM_OF[x]) });
      else if (solo[s]?.state === 'playing') setState(room, 'playing', { media_title: solo[s].title, media_artist: solo[s].artist ?? '', group_members: [] });
      else setState(room, 'idle', { media_title: undefined, media_artist: undefined, group_members: [] });
    }
  }
  function stopGroup(g, why) {
    setState(G[g].entity, 'idle');
    if (G[g].kind === 'dynamic') G[g].members = [];
    events.push({ ev: 'stop', group: g, why });
  }
  /** take speaker s out of whatever holds it (not `except`) */
  function release(s, except, how) {
    const h = holder(s, except);
    if (h) {
      if (G[h].kind === 'static') { stopGroup(h, `static member ${s} taken (${how})`); return; }
      const wasLead = leader(h) === s;
      G[h].members = G[h].members.filter((x) => x !== s);
      if (!G[h].members.length) { stopGroup(h, `last speaker ${s} left`); events.push({ ev: 'dissolve', group: h }); return; }
      if (wasLead) reform(h);
      return;
    }
    if (solo[s]?.state === 'playing') { solo[s] = { ...solo[s], state: 'idle' }; events.push({ ev: 'solo-stop', speaker: s }); }
  }
  function reform(g) {
    const ent = G[g].entity;
    events.push({ ev: 'reform', group: g, leader: G[g].members[0] });
    if (LIVE) {
      // live 2.10.9: the group stays 'playing'; the next member leads after ~5.9 s of silence
      silent[g] = Date.now() + GAP; syncHa();
      setTimeout(() => { delete silent[g]; events.push({ ev: 'reformed', group: g }); syncHa(); commit(); }, GAP);
      return;
    }
    setState(ent, 'buffering'); syncHa();
    setTimeout(() => { if (st(ent).state === 'buffering') { setState(ent, 'playing'); events.push({ ev: 'reformed', group: g }); syncHa(); commit(); } }, GAP);
  }
  /** a group powers on with its preset (dynamic) or fixed list (static): takes the speakers, hijacks a group its leader leads */
  function powerOn(g) {
    const want = [...(G[g].idle ?? G[g].preset)];
    delete G[g].idle;
    const lead = want[0];
    const h = lead && holder(lead, g);
    if (h && leader(h) === lead) {
      // leader keeps its native group: everything it leads now plays this group (hijack)
      for (const s of membersNow(h)) if (!want.includes(s)) want.push(s);
      events.push({ ev: 'hijack', group: h, by: g });
      setState(G[h].entity, 'idle'); if (G[h].kind === 'dynamic') G[h].members = [];
    }
    for (const s of want) release(s, g, `power-on ${g}`);
    G[g].members = want;
  }
  const failMode = async (mode, what) => {
    if (mode === 'fail') { await sleep(150); throw new Error(`${what}: player unavailable`); }
    if (mode === 'timeout') await new Promise(() => {});
    if (mode === 'slow') await sleep(1500);
  };

  const strict = (d, keys) => { for (const k of Object.keys(d)) if (!keys.includes(k)) throw new Error(`unexpected argument ${k}`); if (!d.queue_id) throw new Error('queue_id required'); };
  /** MA index_in_buffer: Q.buf when set, else current (+1 with ?qbuf=1) */
  const bufOf = (Q) => (typeof Q.buf === 'number' ? Q.buf : Q.index + (params.get('qbuf') === '1' ? 1 : 0));
  const boundary = (Q) => Math.max(Q.index, bufOf(Q));
  const qEnt = (qid) => { if (G[qid] && QS[G[qid].entity]) return G[qid].entity; const e = Object.keys(QS).find((x) => st(x)?.attributes?.active_queue === qid); if (!e) throw new Error(`PlayerUnavailableError: queue ${qid}`); return e; };
  async function command(cmd, d) {
    log.push({ t: Math.round(performance.now()), command: cmd, data: structuredClone(d) });
    if (cmd !== 'players/all' && cmd !== 'config/players/get' && cmd !== 'player_queues/get') window.__calls.push({ t: Math.round(performance.now()), domain: 'mass_queue', service: 'send_command', data: { command: cmd, data: structuredClone(d) } });
    await sleep(MALAT);
    switch (cmd) {
      case 'players/all': return players();
      // config/players/get (scope CONFIG_PLAYERS_READ: guest / user / service tokens have it). ?macfg=deny: refused
      case 'config/players/get': {
        if (params.get('macfg') === 'deny') throw new Error('Unauthorized: insufficient scope');
        const d0 = G[d.player_id];
        if (!d0 && !NAME[d.player_id]) throw new Error(`Player ${d.player_id} not found`);
        return { player_id: d.player_id, provider: d0 ? 'sync_group' : 'wiim', name: d0?.name ?? NAME[d.player_id],
          values: d0 ? { group_members: { key: 'group_members', value: [...d0.preset] }, dynamic_members: { key: 'dynamic_members', value: d0.kind === 'dynamic' } } : {} };
      }
      // player_queues/get(queue_id) -> PlayerQueue (index_in_buffer is MA's, HA's get_queue doesn't carry it)
      case 'player_queues/get': {
        const e = qEnt(d.queue_id), Q = QS[e];
        return { queue_id: d.queue_id, active: true, items: Q.items.length, current_index: Q.index < 0 ? null : Q.index,
          index_in_buffer: Q.index < 0 ? null : bufOf(Q), current_item: Q.items[Q.index] ? { queue_item_id: Q.items[Q.index].queue_item_id } : null };
      }
      case 'players/cmd/set_members': {
        await failMode(GRP, 'set_members');
        const g = d.target_player, add = d.player_ids_to_add ?? [], rem = d.player_ids_to_remove ?? [];
        if (!G[g]) throw new Error(`Player ${g} does not support group commands`);
        if (G[g].kind === 'static') throw new Error(`Player ${G[g].name} does not support group commands`); // live: 500
        for (const s of add) if (G[s]) throw new Error('Nesting groups is not allowed');
        for (const s of [...add, ...rem]) if (!NAME[s]) throw new Error(`Unknown player ${s}`);
        if (JOIN) await sleep(JOIN);
        if (!active(g)) {
          // live: 200, the group stays idle with the new member list (it takes the speakers when it starts)
          const cur = [...(G[g].idle ?? G[g].preset)];
          G[g].idle = [...cur.filter((x) => !rem.includes(x)), ...add.filter((x) => !cur.includes(x))];
          events.push({ ev: 'idle-members', group: g, members: [...G[g].idle] });
          commit();
          return null;
        }
        for (const s of add) {
          const h = holder(s, g);
          if (h && G[h].kind === 'static' && leader(h) === s && gState(h) === 'playing') throw new Error(`${NAME[s]} leads a playing group`);
        }
        for (const s of add) { if (G[g].members.includes(s)) continue; release(s, g, `set_members ${g}`); G[g].members.push(s); }
        for (const s of rem) {
          if (!G[g].members.includes(s)) continue;
          const wasLead = leader(g) === s;
          G[g].members = G[g].members.filter((x) => x !== s);
          if (!G[g].members.length) { stopGroup(g, `last speaker ${s} removed`); events.push({ ev: 'dissolve', group: g }); }
          else if (wasLead) reform(g);
        }
        syncHa(); commit();
        return null;
      }
      // MA 2.10.9 controllers/player_queues: play_index(queue_id, index: int | queue_item_id, seek_position=0, fade_in=False)
      case 'player_queues/play_index': {
        strict(d, ['queue_id', 'index', 'seek_position', 'fade_in']);
        const e = qEnt(d.queue_id), Q = QS[e];
        const i = typeof d.index === 'number' ? d.index : Q.items.findIndex((x) => x.queue_item_id === d.index);
        if (i < 0 || i >= Q.items.length) throw new Error(`IndexError: ${d.index} not in queue`);
        Q.index = i; syncNowPlaying(true, e); setState(e, 'playing'); commit();
        return null;
      }
      // move_item(queue_id, queue_item_id, pos_shift=1): + down, - up, 0 = next. Played / buffered items raise;
      // a target before the buffer or past the end returns silently (?qbuf=1 models "next track already buffered")
      case 'player_queues/move_item': {
        strict(d, ['queue_id', 'queue_item_id', 'pos_shift']);
        const e = qEnt(d.queue_id), Q = QS[e];
        const i = Q.items.findIndex((x) => x.queue_item_id === d.queue_item_id);
        if (i < 0) throw new Error(`KeyError: ${d.queue_item_id}`);
        const buf = boundary(Q);
        if (i <= buf) throw new Error(`${i} is already played/buffered`); // live 2.10.9: 500
        const ps = d.pos_shift ?? 1;
        const ni = ps === 0 ? buf + 1 : i + ps;
        if (ni <= buf || ni > Q.items.length - 1) return null;
        const [x] = Q.items.splice(i, 1); Q.items.splice(ni, 0, x); commit();
        return null;
      }
      // delete_item(queue_id, item_id_or_index: int | str): an unknown id raises InvalidDataError; an item at or before
      // the buffer is ignored silently (MA logs a warning). ?qbuf=1 = next track already buffered.
      case 'player_queues/delete_item': {
        strict(d, ['queue_id', 'item_id_or_index']);
        const e = qEnt(d.queue_id), Q = QS[e];
        const i = typeof d.item_id_or_index === 'number' ? d.item_id_or_index : Q.items.findIndex((x) => x.queue_item_id === d.item_id_or_index);
        if (i < 0 || i >= Q.items.length) throw new Error(`InvalidDataError: Item ${d.item_id_or_index} not found in queue`);
        if (i <= boundary(Q)) return null; // live: 200, ignored
        Q.items.splice(i, 1); commit();
        return null;
      }
      // play_media(queue_id, media: item(s) | uri(s), option: 'play'|'replace'|'next'|'replace_next'|'add', radio_mode, start_item, ...)
      // option add appends (new queue_item_id). ?qadd=fail makes it raise.
      case 'player_queues/play_media': {
        strict(d, ['queue_id', 'media', 'option', 'radio_mode', 'start_item']);
        if (params.get('qadd') === 'fail') throw new Error('MusicAssistantError: play_media failed');
        const e = qEnt(d.queue_id), Q = QS[e];
        const uris = Array.isArray(d.media) ? d.media : [d.media];
        const ts = uris.map((u) => libTracks.find((t) => t.uri === (typeof u === 'string' ? u : u?.uri)));
        if (ts.some((t) => !t)) throw new Error('MediaNotFoundError: no playable items');
        if (d.option !== 'add') throw new Error(`mock: only option add is modelled (got ${d.option})`);
        Q.items.push(...ts.map(qItem)); commit();
        return null;
      }
      // items(queue_id, limit=500, offset=0) -> QueueItem dicts (media_item.uri); ?qitems=fail makes it raise
      case 'player_queues/items': {
        strict(d, ['queue_id', 'limit', 'offset']);
        if (params.get('qitems') === 'fail') throw new Error('mock: items failed');
        const ent = G[d.queue_id] && QS[G[d.queue_id].entity] ? G[d.queue_id].entity : Object.keys(QS).find((k) => st(k)?.attributes?.active_queue === d.queue_id);
        if (!ent) return [];
        const off = d.offset ?? 0, lim = d.limit ?? 500;
        return QS[ent].items.slice(off, off + lim).map((x) => ({ queue_id: d.queue_id, queue_item_id: x.queue_item_id, name: x._t.name, media_item: { uri: x._t.uri, name: x._t.name } }));
      }
      case 'player_queues/transfer': {
        await failMode(XFER, 'transfer');
        const a = d.source_queue_id, b = d.target_queue_id;
        if (!G[a] || !G[b]) throw new Error(`Queue ${G[a] ? b : a} not found`);
        if (a === b) throw new Error('Source and target are the same queue');
        const qa = QS[G[a].entity], qb = QS[G[b].entity];
        qb.items = qa.items.map((it) => qItem(it._t)); qb.index = qa.index;
        const pos = st(G[a].entity).attributes.media_position ?? 0;
        stopGroup(a, `transferred to ${b}`);
        if (d.auto_play !== false) {
          powerOn(b); syncNowPlaying(true, G[b].entity);
          const go = () => { setState(G[b].entity, 'playing', { media_position: pos, media_position_updated_at: new Date().toISOString() }); syncHa(); commit(); };
          // live: ~4.7 s of silence on the target (the source already stopped)
          if (XGAP) { setState(G[b].entity, 'buffering'); setTimeout(() => { if (st(G[b].entity).state === 'buffering') { events.push({ ev: 'transferred', group: b }); go(); } }, XGAP); }
          else go();
        }
        syncHa(); commit();
        return null;
      }
      case 'players/cmd/stop': {
        const p = d.player_id;
        if (G[p]) stopGroup(p, 'stop');
        else if (NAME[p]) release(p, undefined, 'stop');
        else throw new Error(`Unknown player ${p}`);
        syncHa(); commit();
        return null;
      }
      default: throw new Error(`mock-ma: unhandled ${cmd}`);
    }
  }
  /** HA media_play / play_media on a group entity: an idle group powers on first */
  function willPlay(entity) {
    const g = gidOf(entity);
    if (!g || active(g)) return false;
    const n = events.length;
    powerOn(g);
    return events.length > n || G[g].kind === 'dynamic';
  }
  function afterHa() { syncHa(); }
  /** a group entity changed state: refresh its live active_queue (own queue while it plays, a stale one when idle) */
  function groupStateChanged(entity) {
    const g = gidOf(entity);
    if (!g || G[g].kind !== 'dynamic' || !STALEAQ) return;
    const aq = active(g) ? g : 'syncgroup_everywhere';
    if (st(entity).attributes.active_queue !== aq) setState(entity, null, { active_queue: aq });
  }

  // HA entities for the dynamic test groups (sf 8320575 = MA group with GROUPING)
  for (const [g, d] of Object.entries(G)) {
    if (d.entity === EVERY) continue;
    QS[d.entity] = { items: [], index: -1 };
    setState(d.entity, 'idle', { friendly_name: d.name, group_members: [], app_id: 'music_assistant', active_queue: STALEAQ ? 'syncgroup_everywhere' : g, mass_player_id: null, volume_level: 0.5, is_volume_muted: false,
      shuffle: false, repeat: 'off', supported_features: 8320575, mass_player_type: 'group' });
  }
  if (params.get('ma') === 'split') {
    setState(EVERY, 'idle');
    G.syncgroup_mock_indoor.members = [SP.kitchen, SP.living];
    const qi = QS[INDOOR]; qi.items = ['Teardrop', 'Porcelain', 'Angel'].map((n) => qItem(libTracks.find((t) => t.name === n))); qi.index = 0;
    syncNowPlaying(true, INDOOR); setState(INDOOR, 'playing');
    solo[SP.garage] = { state: 'playing', title: 'Mock Radio FM', artist: '' };
    syncHa();
  }
  /** test hook: force a group's state (and dynamic members), e.g. an overlap MA can reach but the mock flows don't */
  function force(g, state, members) { if (members && G[g].kind === 'dynamic') G[g].members = [...members]; setState(G[g].entity, state); syncHa(); commit(); }
  window.__ma = { G, SP, solo, players, events, force, silent };
  return { command, willPlay, afterHa, groupStateChanged, isGroup: (e) => !!gidOf(e), INDOOR, OUTDOOR };
}

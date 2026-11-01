// Unit checks for the 0.5.0 speaker model (src/speakers/model.ts) and the queue-row Play now / Play next calls
// (src/queue-model.ts). Bundled on the fly with the project's rollup setup. Every id below is a placeholder.
// Usage: node test/unit/speakers.unit.mjs     (no browser, no network)
import { rollup } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../tmp/unit-speakers/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const bundle = await rollup({ input: ['src/speakers/model.ts', 'src/queue-model.ts'], plugins: [resolve(), typescript({ tsconfig: './tsconfig.json', outDir: OUT, noEmitOnError: true })] });
await bundle.write({ dir: OUT, format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' });
await bundle.close();

// minimal browser shims (queue-model pulls lit in through shared.ts)
globalThis.window = globalThis;
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get: () => undefined, define: () => {} };
globalThis.document ??= { createElement: () => ({}), createComment: () => ({}), createTreeWalker: () => ({}), importNode: () => ({}) };
const origWarn = console.warn; console.warn = () => {};

const M = await import(OUT + 'model.mjs');
const Q = await import(OUT + 'queue-model.mjs');

let failures = 0, total = 0;
function check(name, ok, info = '') { total++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); }
const J = JSON.stringify;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------- MA players (placeholder ids) ----------------
const P = (id, o = {}) => ({ player_id: id, provider: 'wiim', type: 'player', name: id, available: true, playback_state: 'idle', group_members: [], static_group_members: [], supported_features: [], ...o });
const raw = [
  P('spk_living', { name: 'Living Room', playback_state: 'playing', group_members: ['spk_living', 'spk_kitchen'] }),
  P('spk_kitchen', { name: 'Kitchen', playback_state: 'playing', synced_to: 'spk_living' }),
  P('spk_garage', { name: 'Garage' }),
  P('syncgroup_indoor', { type: 'group', provider: 'player_group', name: 'Indoor', playback_state: 'playing', group_members: ['spk_living', 'spk_kitchen'], supported_features: ['set_members'] }),
  P('syncgroup_static', { type: 'group', provider: 'player_group', name: 'Fixed', static_group_members: ['spk_garage', 'spk_living'], supported_features: ['set_members'] }),
  { nope: true },
];
const players = M.parsePlayers({ items: raw });
check('U1 parsePlayers: list or {items}, junk dropped', players.size === 5 && M.parsePlayers(raw).size === 5 && M.parsePlayers(null).size === 0);
check('U2 kindOf: set_members + no static list = dynamic; static list = static (shown as fixed); speaker = player',
  M.kindOf(players.get('syncgroup_indoor')) === 'dynamic' && M.kindOf(players.get('syncgroup_static')) === 'static' && M.kindOf(players.get('spk_garage')) === 'player');
check('U3 membersOf / leaderOf follow MA (leader = unsynced member with group_members)',
  J(M.membersOf(players.get('syncgroup_indoor'), players)) === J(['spk_living', 'spk_kitchen']) && M.leaderOf(players.get('syncgroup_indoor'), players) === 'spk_living');
check('U4 a stopped static group still lists its fixed members', J(M.membersOf(players.get('syncgroup_static'), players)) === J(['spk_garage', 'spk_living']));
check('U5 holderOf: the playing group that holds a speaker', M.holderOf('spk_kitchen', players)?.player_id === 'syncgroup_indoor' && !M.holderOf('spk_garage', players));

// ---------------- permissions (UI lock) ----------------
const admin = { id: 'u-admin', name: 'Owner', is_admin: true }, guest = { id: 'u-guest', name: 'Kitchen Tablet', is_admin: false };
const fixed = { type: 'custom:jukebox-card', entity: 'media_player.everywhere' }, dyn = { ...fixed, speaker_mode: 'dynamic' };
check('U6 fixed (0.4 default): nobody groups', !M.canGroup(fixed, admin) && !M.canGroup(fixed, guest));
check('U7 dynamic: admins group, guests do not; grouping_users by name or id', M.canGroup(dyn, admin) && !M.canGroup(dyn, guest)
  && M.canGroup({ ...dyn, grouping_users: ['kitchen tablet'] }, guest) && M.canGroup({ ...dyn, grouping_users: ['u-guest'] }, guest));
check('U8 grouping everyone / nobody', M.canGroup({ ...dyn, grouping: 'everyone' }, guest) && !M.canGroup({ ...dyn, grouping: 'nobody' }, admin));
check('U9 guest_access volume (default) / none', M.canVolume(fixed, guest) && !M.canVolume({ ...fixed, guest_access: 'none' }, guest) && M.canVolume({ ...fixed, guest_access: 'none' }, admin));
check('U10 queue Play now / Play next: admins and grouping_users in either mode; guests never; grouping nobody hides them',
  M.canJumpQueue(fixed, admin) && M.canJumpQueue(dyn, admin) && !M.canJumpQueue(fixed, guest) && M.canJumpQueue({ ...fixed, grouping_users: ['Kitchen Tablet'] }, guest)
    && M.canJumpQueue({ ...fixed, grouping: 'everyone' }, guest) && !M.canJumpQueue({ ...fixed, grouping: 'nobody' }, admin));

// ---------------- quiet hours ----------------
const at = (h, m = 0) => { const d = new Date(2026, 9, 31, h, m); return d; };
const qh = { start: '22:00', end: '07:00', max_volume: 30 };
check('U11 quiet hours wrap midnight', M.inQuiet(qh, at(23)) && M.inQuiet(qh, at(6, 59)) && !M.inQuiet(qh, at(7)) && !M.inQuiet(qh, at(12)));
check('U12 cap applies to guests only by default; everyone when applies: everyone',
  M.volumeCap({ ...fixed, quiet_hours: qh }, guest, at(23)) === 0.3 && M.volumeCap({ ...fixed, quiet_hours: qh }, admin, at(23)) === undefined
    && M.volumeCap({ ...fixed, quiet_hours: { ...qh, applies: 'everyone' } }, admin, at(23)) === 0.3 && M.volumeCap({ ...fixed, quiet_hours: qh }, guest, at(12)) === undefined);
check('U13 invalid quiet_hours are ignored', !M.validQuiet({ start: '25:00', end: '07:00', max_volume: 30 }) && !M.validQuiet({ start: '22:00', end: '07:00', max_volume: 130 }) && M.capVol(0.8, 0.3) === 0.3);

// ---------------- presets / plans ----------------
const rooms = [{ entity: 'media_player.living_room', name: 'Living Room', ma: 'spk_living' }, { entity: 'media_player.kitchen', name: 'Kitchen', ma: 'spk_kitchen' }, { entity: 'media_player.garage', name: 'Garage' }];
check('U14 presetSpeakers skips unmapped rooms; validPreset', J(M.presetSpeakers({ name: 'Dinner', members: ['media_player.kitchen', 'media_player.garage'] }, rooms)) === J(['spk_kitchen'])
  && M.validPreset({ name: 'Dinner', members: ['media_player.kitchen'], volumes: { 'media_player.kitchen': 40 } }) && !M.validPreset({ name: 'x', members: ['light.x'] }));
const p1 = M.planMembers(['spk_living', 'spk_kitchen'], ['spk_kitchen', 'spk_garage'], 'spk_living', false);
check('U15 planMembers keeps the leader when leader_drop is block', J(p1) === J({ add: ['spk_garage'], remove: [], kept: ['spk_living'] }), J(p1));
const p2 = M.planMembers(['spk_living', 'spk_kitchen'], [], 'spk_living', true);
check('U16 planMembers never removes the last speaker', p2.remove.length === 1 && p2.kept.length === 1, J(p2));
check('U17 dropBlock: leader (block) / last / allowed',
  M.dropBlock(players.get('syncgroup_indoor'), 'spk_living', players, false) === 'leader' && M.dropBlock(players.get('syncgroup_indoor'), 'spk_kitchen', players, false) === ''
    && M.dropBlock(players.get('syncgroup_indoor'), 'spk_living', players, true) === '' && M.dropBlock(players.get('spk_garage'), 'spk_garage', players, false) === 'last');
const tk = M.takeovers('syncgroup_static', ['spk_kitchen'], players);
check('U18 takeovers: taking a member of a playing dynamic group', tk.length === 1 && tk[0].kind === 'dynamic' && tk[0].group === 'syncgroup_indoor' && !tk[0].last && !tk[0].leader, J(tk));
check('U19 takeoverText for a leader is the re-form warning', /restarts/.test(M.takeoverText({ speaker: 'spk_living', kind: 'dynamic', group: 'syncgroup_indoor', leader: true }, (x) => players.get(x)?.name ?? x)));

// ---------------- queue rows: Play now / Play next ----------------
check('U20 nextShift: (current + 1) - index; 0 for the playing, already-next and played rows',
  Q.nextShift(1, 5) === -3 && Q.nextShift(1, 3) === -1 && Q.nextShift(1, 2) === 0 && Q.nextShift(1, 1) === 0 && Q.nextShift(1, 0) === 0 && Q.nextShift(-1, 4) === 0 && Q.nextShift(0, 4) === -3);

function fakeHass(withQueueId = true, { buf, curIdx = 7, ignoreDelete = false, moveErr = '' } = {}) {
  const calls = [];
  const items = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'].map((id, i) => ({ queue_item_id: id, media_title: `Song ${i}`, media_content_id: `apple_music://track/${i}` }));
  return { calls, hass: {
    states: { 'media_player.everywhere': { entity_id: 'media_player.everywhere', state: 'playing', attributes: { active_queue: 'syncgroup_placeholder' } } },
    user: admin,
    callService: async (d, s, data, target) => {
      calls.push({ d, s, data, target });
      if (s === 'get_queue_items') return { response: { 'media_player.everywhere': items } };
      if (s === 'get_queue') return { response: { 'media_player.everywhere': { ...(withQueueId ? { queue_id: 'syncgroup_placeholder_q' } : {}), current_index: 7, items: 40, current_item: { queue_item_id: 'q1' } } } };
      // MA PlayerQueue (live 2.10.9 shape): index_in_buffer next to current_index; absent unless the test sets buf
      if (s === 'send_command' && data.command === 'player_queues/get') return { response: buf === undefined ? null : { queue_id: data.data.queue_id, current_index: curIdx, index_in_buffer: buf } };
      if (s === 'send_command' && data.command === 'player_queues/move_item' && moveErr) throw new Error(moveErr);
      if (s === 'send_command' && data.command === 'player_queues/delete_item' && !ignoreDelete) { const j = items.findIndex((x) => x.queue_item_id === data.data.item_id_or_index); if (j >= 0) items.splice(j, 1); }
      return { response: null };
    } } };
}
{
  const { hass, calls } = fakeHass();
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh();
  check('U21 refresh keeps MA queue_id from get_queue', qm.snap.queueId === 'syncgroup_placeholder_q' && qm.snap.current === 1, J({ q: qm.snap.queueId, c: qm.snap.current }));
  calls.length = 0;
  await qm.playNow('q4');
  const c1 = calls.find((c) => c.s === 'send_command');
  check('U22 playNow → mass_queue.send_command player_queues/play_index {queue_id, index: queue_item_id}',
    c1 && J(c1.data) === J({ config_entry_id: 'mq_entry_placeholder', command: 'player_queues/play_index', data: { queue_id: 'syncgroup_placeholder_q', index: 'q4' } }), J(c1));
  check('U23 playNow is optimistic (q4 becomes current at once)', qm.snap.items[qm.snap.current].queue_item_id === 'q4');
  await qm.refresh(); calls.length = 0;
  await qm.playNext('q5');
  const c2 = calls.find((c) => c.s === 'send_command');
  check('U24 playNext → player_queues/move_item {queue_id, queue_item_id, pos_shift: (1 + 1) - 5 = -3}',
    c2 && J(c2.data.data) === J({ queue_id: 'syncgroup_placeholder_q', queue_item_id: 'q5', pos_shift: -3 }) && c2.data.command === 'player_queues/move_item', J(c2));
  check('U25 playNext is optimistic (q5 right after the playing row)', qm.snap.items[qm.snap.current + 1].queue_item_id === 'q5', J(qm.snap.items.map((x) => x.queue_item_id)));
  await qm.refresh(); calls.length = 0;
  await qm.playNext('q2'); await qm.playNext('q1'); await qm.playNext('q0');
  check('U26 playNext on the already-next, playing or played row sends nothing', calls.filter((c) => c.s !== 'get_queue_items' && c.s !== 'get_queue' && c.data?.command !== 'player_queues/get').length === 0, J(calls));
}
{
  const { hass, calls } = fakeHass(false);
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh();
  check('U27 no queue_id in get_queue → the entity\'s active_queue', qm.snap.queueId === 'syncgroup_placeholder');
  const qn = new Q.QueueModel(); qn.hass = hass; await qn.refresh(); calls.length = 0;
  await qn.playNow('q3'); await qn.playNext('q5');
  const svc = calls.filter((c) => c.d === 'mass_queue' && !c.s.startsWith('get_')).map((c) => `${c.s}:${J(c.data)}`);
  check('U28 no mass_queue entry → the 0.4 services (play_queue_item / move_queue_item_next)',
    J(svc) === J([`play_queue_item:${J({ entity: 'media_player.everywhere', queue_item_id: 'q3' })}`, `move_queue_item_next:${J({ entity: 'media_player.everywhere', queue_item_id: 'q5' })}`]), J(svc));
}
// ---------------- queue rows: Remove + Undo ----------------
function undoHass({ addFail = false, itemsFail = false } = {}) {
  const f = fakeHass(), base = f.hass.callService;
  const rows = ['q0', 'q1', 'q2', 'q4', 'q5', 'qnew'].map((id) => ({ queue_item_id: id, media_item: { uri: id === 'qnew' ? 'apple_music://track/3' : `apple_music://track/${id.slice(1)}` } }));
  f.hass.callService = async (d, s, data, target, ...rest) => {
    if (s === 'send_command' && data.command === 'player_queues/play_media' && addFail) { f.calls.push({ d, s, data }); throw new Error('play_media refused'); }
    if (s === 'send_command' && data.command === 'player_queues/items') { f.calls.push({ d, s, data }); if (itemsFail) throw new Error('items failed'); return { response: rows.slice(data.data.offset - 6) }; }
    return base(d, s, data, target, ...rest);
  };
  return f;
}
{
  const { hass, calls } = undoHass();
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh(); calls.length = 0;
  check('U29 removedInfo: nothing for the playing row', qm.removedInfo('q1') === undefined && (await qm.removeRow('q1')) === undefined && calls.length === 0);
  const r = await qm.removeRow('q3');
  const c = calls.find((x) => x.s === 'send_command');
  check('U30 removeRow → player_queues/delete_item {queue_id, item_id_or_index: queue_item_id}; optimistic; remembers uri + the row before',
    J(c?.data) === J({ config_entry_id: 'mq_entry_placeholder', command: 'player_queues/delete_item', data: { queue_id: 'syncgroup_placeholder_q', item_id_or_index: 'q3' } })
      && !qm.snap.items.some((x) => x.queue_item_id === 'q3') && r.uri === 'apple_music://track/3' && r.prevId === 'q2' && r.title === 'Song 3', J({ c, r }));
  calls.length = 0;
  const where = await qm.undoRemove(r);
  const cmds = calls.filter((x) => x.s === 'send_command' && x.data.command !== 'player_queues/get').map((x) => ({ c: x.data.command, d: x.data.data }));
  check('U31 undoRemove: play_media {media: uri, option: add} → items {limit, offset: current_index - 1} → move_item {new id, pos_shift -2}',
    where === 'ok' && J(cmds) === J([
      { c: 'player_queues/play_media', d: { queue_id: 'syncgroup_placeholder_q', media: 'apple_music://track/3', option: 'add' } },
      { c: 'player_queues/items', d: { queue_id: 'syncgroup_placeholder_q', limit: 1000, offset: 6 } },
      { c: 'player_queues/move_item', d: { queue_id: 'syncgroup_placeholder_q', queue_item_id: 'qnew', pos_shift: -2 } }]), J(cmds));
}
{
  const { hass } = undoHass({ addFail: true });
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder'; await qm.refresh();
  const r = await qm.removeRow('q3');
  let threw = false; try { await qm.undoRemove(r); } catch { threw = true; }
  let noUri = false; try { await qm.undoRemove({ ...r, uri: undefined }); } catch { noUri = true; }
  check('U32 undoRemove throws when MA refuses the re-add or there is no URI (the view says it couldn\'t)', threw && noUri);
}
{
  const { hass } = undoHass({ itemsFail: true });
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder'; await qm.refresh();
  const r = await qm.removeRow('q3');
  check('U33 re-added but the lookup / move fails → \'end\' (added at the end, place not restored)', (await qm.undoRemove(r)) === 'end');
  const r2 = { ...r, before: true };
  check('U34 a removed played row comes back at the end (MA won\'t move into the played part)', (await qm.undoRemove(r2)) === 'end');
}
{
  const { hass, calls } = fakeHass();
  const qn = new Q.QueueModel(); qn.hass = hass; await qn.refresh(); calls.length = 0;
  await qn.removeRow('q4');
  const svc = calls.filter((c) => c.d === 'mass_queue' && !c.s.startsWith('get_')).map((c) => c.s);
  let threw = false; try { await qn.undoRemove({ id: 'q4', title: 'x', uri: 'u', before: false }); } catch { threw = true; }
  check('U35 no mass_queue entry → Remove uses the 0.4 remove_queue_item; Undo is unavailable (throws)', J(svc) === J(['remove_queue_item']) && threw, J(svc));
}
// ---------------- live MA 2.10.9: buffer boundary, mapping, group config ----------------
check('U36 lockedRow: current + (index_in_buffer - current_index); unknown buffer → current',
  Q.lockedRow(1, 7, 8) === 2 && Q.lockedRow(1, 7, 7) === 1 && Q.lockedRow(1, 7, undefined) === 1 && Q.lockedRow(-1, 7, 8) === -1 && Q.lockedRow(0, 0, 3) === 3);
check('U37 isBufferedError matches MA\'s "<n> is already played/buffered"', Q.isBufferedError(new Error('31 is already played/buffered')) && !Q.isBufferedError(new Error('player unavailable')));
{
  const { hass, calls } = fakeHass(true, { buf: 8 });
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh();
  check('U38 refresh reads player_queues/get: bufferIndex 8 → locked row 2 (the buffered q2)', qm.snap.bufferIndex === 8 && qm.locked === 2 && qm.isLocked('q2') && !qm.isLocked('q3'), J({ b: qm.snap.bufferIndex, l: qm.locked }));
  calls.length = 0;
  await qm.playNext('q5');
  const c = calls.find((x) => x.s === 'send_command' && x.data.command === 'player_queues/move_item');
  check('U39 playNext with a buffered next track: pos_shift lands right after the buffered row ((2 + 1) - 5 = -2)', c?.data.data.pos_shift === -2 && qm.snap.items[3].queue_item_id === 'q5', J(c?.data));
  await qm.refresh(); calls.length = 0;
  let busy = false; try { await qm.removeRow('q2'); } catch (e) { busy = e instanceof Q.QueueBusy; }
  check('U40 removeRow on the buffered row: refused before any call (QueueBusy)', busy && !calls.some((x) => x.data?.command === 'player_queues/delete_item'));
}
{
  const { hass } = fakeHass(true, { ignoreDelete: true });
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh();
  let busy = false; try { await qm.removeRow('q4'); } catch (e) { busy = e instanceof Q.QueueBusy; }
  check('U41 delete answered 200 but ignored (row still there after a re-read) → QueueBusy and the row is back', busy && qm.snap.items.some((x) => x.queue_item_id === 'q4'));
}
{
  const { hass } = fakeHass(true, { moveErr: '4 is already played/buffered' });
  const qm = new Q.QueueModel(); qm.hass = hass; qm.entryId = 'mq_entry_placeholder';
  await qm.refresh();
  let busy = false; try { await qm.playNext('q4'); } catch (e) { busy = e instanceof Q.QueueBusy; }
  check('U42 move_item 500 "already played/buffered" → QueueBusy (the view says \'That track is already loading\')', busy);
}
{
  // live 2.10.9 entity shapes: mass_player_id null everywhere, idle groups point active_queue at another group's queue
  const lp = M.parsePlayers([
    P('spk_a', { name: 'Speaker A' }), P('spk_b', { name: 'Speaker B' }),
    P('grp_all', { type: 'group', name: 'All Rooms', playback_state: 'playing', group_members: ['spk_a', 'spk_b'], static_group_members: ['spk_a', 'spk_b'], supported_features: [] }),
    P('grp_in', { type: 'group', name: 'Inside', group_members: ['spk_a', 'spk_b'], supported_features: ['set_members'] }),
  ]);
  const st = (e, state, a) => ({ entity_id: e, state, attributes: { mass_player_id: null, ...a } });
  const lh = { states: {
    'media_player.inside': st('media_player.inside', 'idle', { friendly_name: 'Inside', active_queue: 'grp_all', mass_player_type: 'group', group_members: [] }),
    'media_player.all_rooms': st('media_player.all_rooms', 'playing', { friendly_name: 'All Rooms', active_queue: 'grp_all', mass_player_type: 'group' }),
    'media_player.x': st('media_player.x', 'idle', { friendly_name: 'Unknown', active_queue: 'grp_all' }),
    'media_player.y': st('media_player.y', 'playing', { friendly_name: 'Unknown', active_queue: 'grp_all' }),
  } };
  check('U43 targetMa: mass_player_id null + stale active_queue on an idle group → the group with that name',
    M.targetMa('media_player.inside', lh, lp) === 'grp_in' && M.targetMa('media_player.all_rooms', lh, lp) === 'grp_all', J([M.targetMa('media_player.inside', lh, lp)]));
  check('U44 targetMa: active_queue only counts while the entity itself plays', M.targetMa('media_player.x', lh, lp) === undefined && M.targetMa('media_player.y', lh, lp) === 'grp_all');
  const cfgIn = M.parseGroupConfig({ values: { group_members: { value: ['spk_a', 'spk_b'] }, dynamic_members: { value: true } } });
  const cfgAll = M.parseGroupConfig({ values: { group_members: { value: ['spk_a', 'spk_b'] }, dynamic_members: { value: false } } });
  check('U45 parseGroupConfig reads values.<key>.value; junk → undefined',
    J(cfgIn) === J({ members: ['spk_a', 'spk_b'], dynamic: true }) && cfgAll.dynamic === false && M.parseGroupConfig(null) === undefined && M.parseGroupConfig({}) === undefined);
  check('U46 kindOf: dynamic_members false → static even with set_members; static_group_members [] + set_members → dynamic',
    M.kindOf(lp.get('grp_in'), cfgAll) === 'static' && M.kindOf(lp.get('grp_in'), cfgIn) === 'dynamic' && M.kindOf(lp.get('grp_in')) === 'dynamic' && M.kindOf(lp.get('grp_all')) === 'static');
  const lrooms = [{ entity: 'media_player.a', name: 'A', ma: 'spk_a' }, { entity: 'media_player.b', name: 'B', ma: 'spk_b' }];
  const tg = [{ entity: 'media_player.all_rooms', name: 'All Rooms' }, { entity: 'media_player.inside', name: 'Inside' }];
  const cf = new Map([['grp_in', cfgIn], ['grp_all', cfgAll]]);
  const own = [{ name: 'Mine', members: ['media_player.a'] }];
  const ps = M.maPresets(cf, lp, lrooms, tg, lh, own);
  check('U47 maPresets: card presets + "<Group> default" for dynamic groups only (static Everywhere-like group skipped)',
    J(ps) === J([...own, { name: 'Inside default', members: ['media_player.a', 'media_player.b'], target: 'media_player.inside' }]), J(ps));
  check('U48 maPresets: no MA config (unreadable / non-admin) → card presets only; same target + members as a card preset → not doubled',
    J(M.maPresets(new Map(), lp, lrooms, tg, lh, own)) === J(own)
      && M.maPresets(cf, lp, lrooms, tg, lh, [{ name: 'X', members: ['media_player.b', 'media_player.a'], target: 'media_player.inside' }]).length === 1);
}
await tick(700); // let refreshSoon timers drain
console.warn = origWarn;
console.log(`\n${total - failures}/${total} speakers unit checks passed`);
process.exit(failures ? 1 : 0);

import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { tokens, base } from './styles';
import { icon } from './icons';
import { mediaStyles, noFocus, roomsOf, fire } from './shared';
import { throttle } from './slider';
import './slider';
import type { HomeAssistant, JukeboxCardConfig, PresetConfig } from './types';
import { SpeakerError, timeouts, type SpeakerStore } from './speakers/ma';
import {
  mapRooms, targetMa, targetsOf, canGroup, canVolume, volumeCap, capVol, kindOf, isActive, membersOf, leaderOf, holderOf,
  takeovers, takeoverText, dropBlock, planMembers, presetSpeakers, maPresets, type MaPlayer, type Players, type Room, type Takeover, type Target,
} from './speakers/model';

/**
 * Speakers panel (0.5.0). Opened from the header status.
 * fixed mode (default): a volume / mute mixer for the configured rooms, nothing else (no Music Assistant calls).
 * dynamic mode: pick the group the card plays on (Move = player_queues/transfer), join / drop / take speakers
 * (players/cmd/set_members), room presets. Grouping is a UI lock for allowed users only; guests get the mixer.
 * Changes are optimistic, time out, show a toast on failure and offer Undo for a few seconds.
 */
interface Ask { title: string; sub?: string; lines: string[]; ok: string; danger?: boolean; resolve: (ok: boolean) => void }
interface Undo { label: string; run: () => Promise<void> }
interface Pending<T> { v: T; t: number }
const UNDO_MS = 5000;
const HOLD_MS = 4000;
const REGROUP_MS = 15000;
const VOL_THROTTLE_MS = 200;

export class JbSpeakers extends LitElement {
  static properties = {
    hass: { attribute: false }, config: { attribute: false }, store: { attribute: false }, open: { type: Boolean, reflect: true },
    _ask: { state: true }, _toast: { state: true }, _undo: { state: true }, _busy: { state: true }, _tick: { state: true }, _regroup: { state: true },
  };
  hass?: HomeAssistant;
  config!: JukeboxCardConfig;
  store?: SpeakerStore;
  open = false;
  private _ask: Ask | null = null;
  private _toast = '';
  private _undo: Undo | null = null;
  /** optimistic grouping: speaker (MA id) → 'in' | 'out', target entity → 'move' */
  private _busy = new Map<string, string>();
  private _tick = 0;
  /** after the leader is dropped MA re-forms the group on the next member after ~5.9 s of silence (live 2.10.9): 'Regrouping…' */
  private _regroup: { group: string; old: string; until: number } | null = null;
  private _regroupTimer?: number;
  private _unsub?: () => void;
  private _toastTimer?: number;
  private _undoTimer?: number;
  private vol = new Map<string, Pending<number>>();
  private mute = new Map<string, Pending<boolean>>();
  private senders = new Map<string, ReturnType<typeof throttle<[number]>>>();

  private get dynamic() { return this.config?.speaker_mode === 'dynamic'; }
  private get mayGroup() { return canGroup(this.config, this.hass?.user); }

  protected willUpdate(ch: PropertyValues) {
    if (ch.has('open') || ch.has('store')) {
      if (this.open && this.dynamic && this.store) {
        this._unsub?.(); this._unsub = this.store.onChange(() => this._tick++) as any; this.store.start();
      } else if (!this.open) { this.store?.stopPolling(); this._unsub?.(); this._unsub = undefined; }
    }
  }
  disconnectedCallback() { super.disconnectedCallback(); window.clearTimeout(this._regroupTimer); this.store?.stopPolling(); this._unsub?.(); this._unsub = undefined; }

  /* ---------------- public: start confirmation (used by the card's start guard, panel open or not) ---------------- */
  ask(a: Omit<Ask, 'resolve'>): Promise<boolean> {
    this._ask?.resolve(false);
    return new Promise((resolve) => { this._ask = { ...a, resolve }; });
  }
  private answer(ok: boolean) { const a = this._ask; this._ask = null; a?.resolve(ok); }

  /** Lines for starting `target` (idle) with its starting speakers; [] when nothing is taken. */
  startTakeovers(entity: string, players: Players): { lines: string[]; list: Takeover[] } {
    const c = this.config, hass = this.hass;
    const t = targetsOf(c, hass).find((x) => x.entity === entity);
    const ma = targetMa(entity, hass, players);
    const g = ma ? players.get(ma) : undefined;
    if (!g || isActive(g)) return { lines: [], list: [] };
    const rooms = mapRooms(roomsOf(c, hass), hass, players);
    // starting speakers: the card's target members, else what players/all lists for the idle group (live 2.10.9: its current
    // members), else MA's configured defaults (config/players/get); static groups: their fixed list
    const cfg = this.store?.configs.get(ma!);
    const would = t?.members?.length ? t.members.map((e) => rooms.find((r) => r.entity === e)?.ma).filter((x): x is string => !!x)
      : kindOf(g, cfg) === 'static' ? (g.static_group_members.length ? g.static_group_members : cfg?.members ?? g.group_members)
      : (() => { const now = g.group_members.filter((id) => players.get(id) && players.get(id)!.type !== 'group'); return now.length ? now : cfg?.members ?? []; })();
    const list = takeovers(ma, would, players, true);
    return { list, lines: list.map((x) => takeoverText(x, (id) => this.nameOf(id, players, rooms))) };
  }

  /* ---------------- helpers ---------------- */
  private nameOf(id: string, players: Players, rooms: Room[]) {
    const r = rooms.find((x) => x.ma === id);
    if (r) return r.name;
    const t = targetsOf(this.config, this.hass).find((x) => targetMa(x.entity, this.hass, players) === id);
    return t?.name ?? players.get(id)?.name ?? id;
  }
  private toast(t: string, ms = 3200) {
    this._toast = t; window.clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => (this._toast = ''), ms);
  }
  private offerUndo(u: Undo | null) {
    window.clearTimeout(this._undoTimer); this._undo = u;
    if (u) this._undoTimer = window.setTimeout(() => (this._undo = null), Number((window as any).__jbUndoMs ?? UNDO_MS));
  }
  private async doUndo() {
    const u = this._undo; this.offerUndo(null);
    if (!u) return;
    try { await u.run(); this.toast('Undone'); } catch (e) { this.toast(`Undo did not work: ${errText(e)}`); }
  }
  private setBusy(k: string, v?: string) { const m = new Map(this._busy); if (v) m.set(k, v); else m.delete(k); this._busy = m; }
  private close = () => fire(this, 'jukebox-speakers', { open: false });

  /* ---------------- volume (same optimistic pattern as Now playing) ---------------- */
  private held<T>(m: Map<string, Pending<T>>, k: string, a: T, eq: (x: T, y: T) => boolean): T {
    const p = m.get(k);
    if (!p) return a;
    if (Date.now() - p.t > HOLD_MS || eq(a, p.v)) { m.delete(k); return a; }
    return p.v;
  }
  private volOf(id: string) { return this.held(this.vol, id, Number(this.hass?.states[id]?.attributes?.volume_level ?? 0), (x, y) => Math.abs(x - y) < 0.011); }
  private mutedOf(id: string) { return this.held(this.mute, id, !!this.hass?.states[id]?.attributes?.is_volume_muted, (x, y) => x === y); }
  private cap() { return volumeCap(this.config, this.hass?.user); }
  private callVol(id: string, service: string, data: Record<string, any>) {
    return this.hass!.callService('media_player', service, data, { entity_id: id }).catch(() => this.toast('That did not work. Check the speaker.'));
  }
  private sender(id: string) {
    let s = this.senders.get(id);
    if (!s) { s = throttle((v: number) => { void this.callVol(id, 'volume_set', { volume_level: v }); }, VOL_THROTTLE_MS); this.senders.set(id, s); }
    return s;
  }
  private onVol(id: string, e: CustomEvent, final: boolean) {
    const v = capVol(e.detail.value, this.cap());
    this.vol.set(id, { v, t: Date.now() });
    if (final) { this.sender(id).flush(v); this.requestUpdate(); } else { this.sender(id)(v); const el = this.renderRoot.querySelector(`[data-room="${id}"] .vv, [data-main="${id}"] .vv`) as HTMLElement | null; if (el) el.dataset.v = String(Math.round(v * 100)); }
  }
  private toggleMute(id: string) {
    const v = !this.mutedOf(id);
    this.mute.set(id, { v, t: Date.now() }); this.requestUpdate();
    void this.callVol(id, 'volume_mute', { is_volume_muted: v });
  }

  /* ---------------- grouping ---------------- */
  private ctx() {
    const c = this.config, hass = this.hass, players = this.store?.players ?? new Map();
    const rooms = mapRooms(roomsOf(c, hass), hass, players);
    const tMa = this.dynamic ? targetMa(c.entity!, hass, players) : undefined;
    const tP = tMa ? players.get(tMa) : undefined;
    const active = isActive(tP);
    const members = active ? membersOf(tP, players) : [];
    return { c, hass, players, rooms, tMa, tP, kind: kindOf(tP, tMa ? this.store?.configs.get(tMa) : undefined), active, members, leader: active ? leaderOf(tP, players) : undefined };
  }
  private async confirmTakeovers(title: string, list: Takeover[], players: Players, rooms: Room[], ok: string) {
    if (!list.length) return true;
    const danger = list.some((t) => t.kind === 'static' || t.kind === 'hijack' || t.last);
    return this.ask({ title, lines: list.map((t) => takeoverText(t, (id) => this.nameOf(id, players, rooms))), ok, danger });
  }
  /** Join (or take) a speaker into the current target. */
  async join(room: Room) {
    const x = this.ctx();
    if (!room.ma || !x.tMa || x.kind !== 'dynamic' || !x.active) return;
    const holder = holderOf(room.ma, x.players, x.tMa);
    const list = takeovers(x.tMa, [room.ma], x.players);
    const tName = this.nameOf(x.tMa, x.players, x.rooms);
    if (!(await this.confirmTakeovers(holder ? `Take ${room.name} from ${this.nameOf(holder.player_id, x.players, x.rooms)}?` : `Add ${room.name} to ${tName}?`,
      list, x.players, x.rooms, holder ? 'Take' : 'Add'))) return;
    const staticStop = !!holder && kindOf(holder) === 'static';
    const back = holder && kindOf(holder) === 'dynamic' && !list[0]?.last ? holder.player_id : undefined;
    this.setBusy(room.ma, 'in');
    try {
      // a speaker that leads a playing static group is refused by set_members: stop that group first (it stops anyway)
      if (staticStop && leaderOf(holder, x.players) === room.ma) await this.store!.stop(holder!.player_id);
      await this.store!.setMembers(x.tMa, [room.ma], []);
      const ok = await this.store!.waitFor((p) => membersOf(p.get(x.tMa!), p).includes(room.ma!), timeouts().join);
      if (!ok) throw new SpeakerError('timeout', `${room.name} did not join`);
      this.toast(`${room.name} joined ${tName}`);
      if (!staticStop) {
        const s = room.ma, t = x.tMa;
        this.offerUndo({ label: `${room.name} joined`, run: async () => { if (back) await this.store!.setMembers(back, [s], []); else await this.store!.setMembers(t, [], [s]); } });
      } else this.offerUndo(null);
    } catch (e) {
      this.toast(`Couldn't add ${room.name}: ${errText(e)}`, 4500);
      void this.store!.refresh();
    } finally { this.setBusy(room.ma); }
  }
  async drop(room: Room) {
    const x = this.ctx();
    if (!room.ma || !x.tMa || x.kind !== 'dynamic' || !x.active) return;
    const allow = x.c.leader_drop === 'allow';
    const why = dropBlock(x.tP, room.ma, x.players, allow);
    const tName = this.nameOf(x.tMa, x.players, x.rooms);
    if (why === 'last') { this.toast(`${room.name} is the last speaker in ${tName}. Pause instead.`); return; }
    if (why === 'leader') { this.toast(`${room.name} leads ${tName}. Use Move to hand off, or drop the other speakers.`, 4500); return; }
    const isLeader = x.leader === room.ma;
    if (isLeader && !(await this.ask({ title: `Drop ${room.name}?`, lines: [`${tName} pauses briefly and restarts on the other speakers: ${room.name} leads it.`], ok: 'Drop' }))) return;
    this.setBusy(room.ma, 'out');
    if (isLeader) this.startRegroup(x.tMa, room.ma);
    try {
      await this.store!.setMembers(x.tMa, [], [room.ma]);
      const ok = await this.store!.waitFor((p) => !membersOf(p.get(x.tMa!), p).includes(room.ma!), timeouts().join);
      if (!ok) throw new SpeakerError('timeout', `${room.name} did not leave`);
      this.toast(isLeader ? `${tName} restarts without ${room.name}` : `${room.name} left ${tName}`);
      const s = room.ma, t = x.tMa;
      this.offerUndo({ label: `${room.name} left`, run: async () => { await this.store!.setMembers(t, [s], []); } });
    } catch (e) {
      if (isLeader) this.endRegroup();
      this.toast(`Couldn't drop ${room.name}: ${errText(e)}`, 4500);
      void this.store!.refresh();
    } finally { this.setBusy(room.ma); }
  }
  /** 'Regrouping…' until the group plays again on a new leader (or 15 s) */
  private startRegroup(group: string, old: string) {
    window.clearTimeout(this._regroupTimer);
    this._regroup = { group, old, until: Date.now() + REGROUP_MS };
    this._regroupTimer = window.setTimeout(() => this.endRegroup(), REGROUP_MS);
  }
  private endRegroup() { window.clearTimeout(this._regroupTimer); this._regroup = null; }
  /** true while the target is re-forming: our own leader drop not yet answered by a playing new leader, or MA says buffering */
  regrouping(x: { tMa?: string; tP?: MaPlayer; players: Players }): boolean {
    const r = this._regroup;
    if (r && r.group === x.tMa) {
      const ms = membersOf(x.tP, x.players), lead = leaderOf(x.tP, x.players);
      const back = !ms.includes(r.old) && !!lead && x.players.get(lead)?.playback_state === 'playing';
      if (back || Date.now() > r.until) { queueMicrotask(() => this.endRegroup()); return false; }
      return true;
    }
    return x.tP?.playback_state === 'buffering';
  }
  /** Move what plays to another group (or just point the card there when nothing plays). */
  async move(to: Target, opts: { quiet?: boolean; undoable?: boolean } = {}): Promise<boolean> {
    const x = this.ctx();
    const from = x.c.entity!;
    if (to.entity === from) return true;
    if (!this.store?.loaded) await this.store?.refresh();
    const y = this.ctx();
    const dMa = targetMa(to.entity, this.hass, y.players);
    if (!y.active || !y.tMa) { fire(this, 'jukebox-target', { entity: to.entity }); if (!opts.quiet) this.toast(`Now on ${to.name}`); return true; }
    if (!dMa) { this.toast(`${to.name} is not in Music Assistant`); return false; }
    const st = this.startTakeovers(to.entity, y.players);
    const fromName = this.nameOf(y.tMa, y.players, y.rooms);
    if (!(await this.confirmTakeovers(`Move to ${to.name}?`, st.list, y.players, y.rooms, 'Move'))) return false;
    this.setBusy(to.entity, 'move');
    fire(this, 'jukebox-target', { entity: to.entity }); // optimistic
    try {
      await this.store!.transfer(y.tMa, dMa, true);
      const ok = await this.store!.waitFor((p) => isActive(p.get(dMa)), timeouts().move);
      if (!ok) throw new SpeakerError('timeout', `${to.name} did not start`);
      if (!opts.quiet) this.toast(`Moved to ${to.name}`);
      const src = y.tMa;
      const lossy = st.list.some((t) => t.kind === 'static' || t.kind === 'hijack');
      if (opts.undoable !== false && !lossy) this.offerUndo({ label: `Moved to ${to.name}`, run: async () => {
        await this.store!.transfer(dMa, src, true); fire(this, 'jukebox-target', { entity: from });
      } });
      return true;
    } catch (e) {
      fire(this, 'jukebox-target', { entity: from }); // revert
      this.toast(`Couldn't move to ${to.name}: ${errText(e)}. Still on ${fromName}.`, 5000);
      void this.store!.refresh();
      return false;
    } finally { this.setBusy(to.entity); }
  }
  async applyPreset(p: PresetConfig) {
    const targets = targetsOf(this.config, this.hass);
    if (!this.store?.loaded) await this.store?.refresh();
    const dest = targets.find((t) => t.entity === (p.target ?? this.config.entity)) ?? targets[0];
    const x0 = this.ctx();
    const want = presetSpeakers(p, x0.rooms);
    const dMa = targetMa(dest.entity, this.hass, x0.players);
    // one confirmation for everything this preset takes
    const list = dMa ? takeovers(dMa, want, x0.players, !isActive(x0.players.get(dMa))) : [];
    if (!(await this.confirmTakeovers(`Use ${p.name}?`, list, x0.players, x0.rooms, 'Use'))) return;
    this.setBusy('preset:' + p.name, 'run');
    try {
      if (dest.entity !== this.config.entity && !(await this.move(dest, { quiet: true, undoable: false }))) return;
      await this.updateComplete;
      const x = this.ctx();
      if (x.tMa && x.kind === 'dynamic' && x.active) {
        const plan = planMembers(x.members, want, x.leader, x.c.leader_drop === 'allow');
        if (plan.add.length || plan.remove.length) {
          for (const s of plan.add) { const h = holderOf(s, x.players, x.tMa); if (h && kindOf(h) === 'static' && leaderOf(h, x.players) === s) await this.store!.stop(h.player_id); }
          await this.store!.setMembers(x.tMa, plan.add, plan.remove);
          const ok = await this.store!.waitFor((pl) => { const m = membersOf(pl.get(x.tMa!), pl); return plan.add.every((s) => m.includes(s)) && plan.remove.every((s) => !m.includes(s)); }, timeouts().join);
          if (!ok) throw new SpeakerError('timeout', 'speakers did not follow');
        }
        if (plan.kept.length) this.toast(`${p.name}: kept ${plan.kept.map((s) => this.nameOf(s, x.players, x.rooms)).join(', ')} (leads the group)`, 4500);
        else this.toast(`${p.name} ready`);
      } else this.toast(`${p.name}: play something on ${dest.name} to start it`, 4500);
      const cap = this.cap();
      for (const [e, pct] of Object.entries(p.volumes ?? {})) {
        const v = capVol(Math.max(0, Math.min(100, pct)) / 100, cap);
        this.vol.set(e, { v, t: Date.now() });
        void this.callVol(e, 'volume_set', { volume_level: v });
      }
      this.offerUndo(null);
    } catch (e) {
      this.toast(`Couldn't apply ${p.name}: ${errText(e)}`, 4500);
      void this.store?.refresh();
    } finally { this.setBusy('preset:' + p.name); }
  }

  /* ---------------- render ---------------- */
  protected render() {
    if (!this.config) return nothing;
    const ask = this.askTpl();
    if (!this.open) return html`${ask}${this._toast && !this.open ? html`<div class="toast solo" role="status">${this._toast}</div>` : nothing}`;
    const x = this.ctx();
    const user = this.hass?.user;
    const may = this.dynamic && this.mayGroup;
    const vol = canVolume(x.c, user);
    const cap = this.cap();
    const targets = this.dynamic ? targetsOf(x.c, this.hass) : [];
    const tName = (this.hass?.states[x.c.entity!]?.attributes?.friendly_name as string) ?? targets.find((t) => t.entity === x.c.entity)?.name ?? 'Speakers';
    const grouping = may && x.kind === 'dynamic' && x.active && !!this.store?.loaded;
    let banner = '';
    if (!this.dynamic) banner = `${tName} always plays on these speakers. Set the volume per room here.`;
    else if (!may) banner = vol ? 'Volume only. Ask an admin to change speakers.' : 'Ask an admin to change speakers or volume.';
    else if (this.store?.error && !this.store.loaded) banner = `Music Assistant did not answer (${this.store.error}). Volume still works.`;
    else if (x.kind === 'static') banner = `${tName} is a fixed group in Music Assistant: no join or drop. Move to another group to change speakers.`;
    else if (x.kind === 'dynamic' && !x.active && this.store?.loaded) banner = `${tName} is not playing. Play something to join speakers, or pick a preset.`;
    // card-config presets plus each dynamic group's MA default (config/players/get); unreadable MA config: card presets only
    const presets = may ? maPresets(this.store?.configs ?? new Map(), x.players, x.rooms, targets, this.hass, x.c.presets ?? []) : [];
    return html`<div class="scrim dim sp-scrim" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); this.close(); }}></div>
      <section class="sheet" role="dialog" aria-label="Speakers" data-mode=${this.dynamic ? 'dynamic' : 'fixed'} data-guest=${may ? 'no' : 'yes'}>
        <header class="sh">
          <span class="ht"><span class="eyebrow">Speakers</span><b class="tn">${tName}</b>
            <small class="stl">${this.statusLine(x)}</small></span>
          <button class="x" aria-label="Close speakers" tabindex="-1" @pointerdown=${noFocus} @click=${this.close}>${icon('close')}</button>
        </header>
        <div class="body">
          ${banner ? html`<p class="banner" data-kind=${!this.dynamic ? 'fixed' : !may ? 'guest' : x.kind}>${banner}</p>` : nothing}
          ${cap !== undefined ? html`<p class="quiet">${icon('volmute', 'i xs')}Quiet hours: volume up to ${Math.round(cap * 100)}%</p>` : nothing}
          ${may && targets.length > 1 ? html`<div class="blk"><span class="eyebrow sm">Play on</span><div class="chips" role="radiogroup">
            ${targets.map((t) => { const on = t.entity === x.c.entity; const b = this._busy.get(t.entity);
              const st = this.hass?.states[t.entity]?.state;
              return html`<button class="chip ${on ? 'on' : ''} ${b ? 'busy' : ''}" role="radio" aria-checked=${on ? 'true' : 'false'} data-target=${t.entity} tabindex="-1"
                @pointerdown=${noFocus} @click=${() => this.move(t)}>${icon('group', 'i xs')}<span>${t.name}</span>${st === 'playing' && !on ? html`<i class="live" title="playing"></i>` : nothing}</button>`; })}
          </div></div>` : nothing}
          ${presets.length ? html`<div class="blk"><span class="eyebrow sm">Presets</span><div class="chips">
            ${presets.map((p) => html`<button class="chip pre ${this._busy.has('preset:' + p.name) ? 'busy' : ''}" data-preset=${p.name} tabindex="-1" @pointerdown=${noFocus}
              @click=${() => this.applyPreset(p)}>${icon('star', 'i xs')}<span>${p.name}</span></button>`)}
          </div></div>` : nothing}
          <div class="mix">
            ${this.mainRow(x.c.entity!, tName, vol, cap)}
            <div class="rooms">${x.rooms.map((r) => this.roomRow(r, x, grouping, vol, cap))}</div>
          </div>
        </div>
        ${this._undo ? html`<div class="undo" role="status"><span>${this._undo.label}</span>
          <button class="ub" data-action="undo" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.doUndo()}>Undo</button></div>` : nothing}
        ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
      </section>${ask}`;
  }
  private statusLine(x: ReturnType<JbSpeakers['ctx']>) {
    const e = this.hass?.states[x.c.entity!];
    const st = e?.state ?? 'unknown';
    const n = this.dynamic && x.active ? x.members.length : (e?.attributes?.group_members as string[] | undefined)?.length ?? x.rooms.length;
    const word = this.dynamic && this.regrouping(x) ? 'Regrouping…' : st === 'playing' ? 'Playing' : st === 'paused' ? 'Paused' : st === 'buffering' ? 'Regrouping…' : 'Idle';
    return `${word} · ${n} speaker${n === 1 ? '' : 's'}`;
  }
  private mainRow(id: string, name: string, vol: boolean, cap?: number) {
    const muted = this.mutedOf(id), v = this.volOf(id);
    return html`<div class="vr main" data-main=${id}>
      <button class="vm" tabindex="-1" aria-label="${muted ? 'Unmute' : 'Mute'} ${name}" ?disabled=${!vol} @pointerdown=${noFocus} @click=${() => this.toggleMute(id)}>${icon(muted ? 'volmute' : 'vol')}</button>
      <span class="vn">All of ${name}</span>
      <jb-slider class="vs" .value=${muted ? 0 : v} .max=${cap} ?disabled=${!vol} .label=${`${name} volume`}
        @jb-input=${(e: CustomEvent) => this.onVol(id, e, false)} @jb-change=${(e: CustomEvent) => this.onVol(id, e, true)}></jb-slider>
      <span class="vv" data-v=${muted ? '–' : String(Math.round(v * 100))}></span>
    </div>`;
  }
  private roomRow(r: Room, x: ReturnType<JbSpeakers['ctx']>, grouping: boolean, vol: boolean, cap?: number) {
    const st = this.hass?.states[r.entity];
    const off = !st || st.state === 'unavailable' || st.state === 'off';
    const muted = this.mutedOf(r.entity), v = this.volOf(r.entity);
    const busy = r.ma ? this._busy.get(r.ma) : undefined;
    let inT: boolean, where = '', act: { label: string; kind: string; fn: () => void; dis?: boolean } | undefined;
    const p = r.ma ? x.players.get(r.ma) : undefined;
    if (this.dynamic && this.store?.loaded && r.ma) {
      inT = x.members.includes(r.ma);
      const h = inT ? undefined : holderOf(r.ma, x.players, x.tMa);
      const title = h ? (this.hass?.states[targetsOf(x.c, this.hass).find((t) => targetMa(t.entity, this.hass, x.players) === h.player_id)?.entity ?? '']?.attributes?.media_title as string | undefined) ?? h.current_media?.title
        : p?.current_media?.title ?? undefined;
      if (inT) where = x.leader === r.ma && x.members.length > 1 ? 'Leads the group' : 'In this group';
      else if (h) where = `In ${this.nameOf(h.player_id, x.players, x.rooms)}${kindOf(h) === 'static' ? ' (fixed)' : ''}${title ? ` · ${title}` : ''}`;
      else if (p && ['playing', 'paused'].includes(p.playback_state)) where = `${p.playback_state === 'paused' ? 'Paused' : 'Playing alone'}${title ? ` · ${title}` : ''}`;
      else where = 'Not playing';
      if (grouping) {
        if (inT) {
          const why = dropBlock(x.tP, r.ma, x.players, x.c.leader_drop === 'allow');
          act = { label: why === 'leader' ? 'Leader' : why === 'last' ? 'Last' : 'Drop', kind: why ? 'blocked' : 'drop', fn: () => this.drop(r) };
        } else if (h) act = { label: `Take from ${this.nameOf(h.player_id, x.players, x.rooms)}`, kind: 'take', fn: () => this.join(r) };
        else act = { label: 'Join', kind: 'join', fn: () => this.join(r) };
      }
      if (busy) inT = busy === 'in';
    } else {
      // fixed mode / not loaded: HA only. In the group = the target lists it; otherwise show what the room plays alone
      const t = this.hass?.states[x.c.entity!];
      inT = !!t && ['playing', 'paused', 'buffering'].includes(t.state) && Array.isArray(t.attributes?.group_members) && t.attributes.group_members.includes(r.entity);
      const title = st?.attributes?.media_title as string | undefined;
      where = inT ? 'In this group' : st && ['playing', 'paused'].includes(st.state) && title ? `${st.state === 'paused' ? 'Paused' : 'Playing'} · ${title}` : off ? 'Offline' : 'Not playing';
    }
    return html`<div class="vr room ${inT ? 'in' : 'out'} ${muted ? 'muted' : ''} ${off ? 'off' : ''} ${busy ? 'pending' : ''}" data-room=${r.entity} data-ma=${r.ma ?? ''}>
      <button class="vm" tabindex="-1" aria-label="${muted ? 'Unmute' : 'Mute'} ${r.name}" ?disabled=${off || !vol} @pointerdown=${noFocus} @click=${() => this.toggleMute(r.entity)}>${icon(muted ? 'volmute' : 'speaker')}</button>
      <span class="vn"><b>${r.name}</b><small class="where">${busy === 'in' ? 'Joining…' : busy === 'out' ? 'Leaving…' : where}</small></span>
      ${act ? html`<button class="act ${act.kind}" data-act=${act.kind} tabindex="-1" ?disabled=${!!busy} @pointerdown=${noFocus} @click=${act.fn}>${act.label}</button>` : html`<span></span>`}
      <jb-slider class="vs" .value=${muted ? 0 : v} .max=${cap} ?disabled=${off || !vol} .label=${`${r.name} volume`}
        @jb-input=${(e: CustomEvent) => this.onVol(r.entity, e, false)} @jb-change=${(e: CustomEvent) => this.onVol(r.entity, e, true)}></jb-slider>
      <span class="vv" data-v=${muted ? '–' : String(Math.round(v * 100))}></span>
    </div>`;
  }
  private askTpl() {
    const a = this._ask;
    if (!a) return nothing;
    return html`<div class="scrim dim ask-scrim" @pointerdown=${(e: PointerEvent) => { e.preventDefault(); this.answer(false); }}></div>
      <div class="confirm sp-ask ${a.danger ? 'danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="sa-q">
        <div class="cf-h"><span><b id="sa-q">${a.title}</b>${a.sub ? html`<small>${a.sub}</small>` : nothing}</span></div>
        ${a.lines.length ? html`<ul class="tk">${a.lines.map((l) => html`<li>${l}</li>`)}</ul>` : nothing}
        <div class="cf-a">
          <button class="cbtn" data-action="cancel" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.answer(false)}>Cancel</button>
          <button class="cbtn ok" data-action="confirm" tabindex="-1" @pointerdown=${noFocus} @click=${() => this.answer(true)}>${a.ok}</button>
        </div>
      </div>`;
  }

  static styles = [tokens, base, mediaStyles, css`
    :host { position: absolute; inset: 0; z-index: 30; pointer-events: none; container: spk / size; font-family: var(--_font-body); color: var(--_fg); }
    :host([open]) { pointer-events: auto; }
    :host(:not([open])) .scrim, :host(:not([open])) .confirm { pointer-events: auto; }
    .scrim { position: absolute; inset: 0; }
    .sp-scrim { z-index: 1; background: #000000b0; }
    .sheet { position: absolute; z-index: 2; display: flex; flex-direction: column; background: #0b0b0bf7; border: 1px solid #ffffff2b; box-shadow: 0 -20px 60px #000c;
      left: 0; right: 0; bottom: 0; max-height: 88%; border-radius: 20px 20px 0 0; padding-bottom: env(safe-area-inset-bottom); }
    .sh { display: flex; align-items: center; gap: 12px; padding: 16px 16px 12px 20px; border-bottom: 1px solid var(--_divider); }
    .ht { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .ht .eyebrow { font-size: 11px; color: var(--_inactive); }
    .tn { font-family: var(--_font-display); font-size: 22px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ht small { font-size: 13px; color: var(--_muted); }
    .x { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 50%; color: var(--_active); flex: none; }
    .x .i { width: 26px; height: 26px; } .x:active { background: #ffffff1f; }
    .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 20px 20px; display: flex; flex-direction: column; gap: 14px; scrollbar-width: none; }
    .banner, .quiet { font-size: 14px; color: var(--_muted); padding: 10px 14px; border-radius: 12px; border: 1px solid var(--_divider); background: #ffffff0d; }
    .quiet { display: flex; align-items: center; gap: 8px; color: var(--_fg); }
    .blk { display: flex; flex-direction: column; gap: 8px; }
    .eyebrow.sm { font-size: 11px; color: var(--_inactive); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 16px; border-radius: 999px; border: 1px solid #ffffff38;
      font-size: 15px; font-weight: 700; color: var(--_fg); }
    .chip .i { width: 18px; height: 18px; }
    .chip.on { background: #fff; color: #000; border-color: #fff; }
    .chip.busy { opacity: .6; }
    .chip:active { transform: scale(.97); }
    .chip .live { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .mix { display: flex; flex-direction: column; }
    .rooms { display: flex; flex-direction: column; border-top: 1px solid var(--_divider); }
    .vr { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; grid-template-areas: "m n a" "s s v"; align-items: center; column-gap: 8px; padding: 8px 0; }
    .vr + .vr { border-top: 1px solid var(--_divider); }
    .vr.main { grid-template-areas: "m n n" "s s v"; }
    .vm { grid-area: m; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; color: var(--_active); margin-left: -8px; }
    .vm .i { width: 22px; height: 22px; }
    .vn { grid-area: n; display: flex; flex-direction: column; min-width: 0; font-size: 15px; font-weight: 700; }
    .vn b, .vn small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .vn small { font-size: 12px; font-weight: 500; color: var(--_muted); }
    .vr.out .vn b { color: var(--_muted); }
    .vr.out .vm { color: var(--_inactive); }
    .vr.pending { opacity: .7; }
    .vs { grid-area: s; --jb-slider-h: 7px; --jb-slider-knob: 22px; --jb-slider-hit: 40px; }
    .vv { grid-area: v; width: 34px; text-align: right; font-size: 12px; color: var(--_muted); font-variant-numeric: tabular-nums; }
    .vv::after { content: attr(data-v); }
    .vr.off { opacity: .5; }
    .act { grid-area: a; height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid #ffffff4d; font-size: 14px; font-weight: 700; color: var(--_fg); white-space: nowrap;
      max-width: 52cqw; overflow: hidden; text-overflow: ellipsis; }
    .act.join { background: #fff; color: #000; border-color: #fff; }
    .act.take { border-style: dashed; }
    .act.blocked { color: var(--_inactive); border-color: var(--_divider); }
    .act:disabled { opacity: .4; }
    .undo { position: absolute; left: 12px; right: 12px; bottom: 14px; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 18px; border-radius: 999px;
      background: #1c1c1c; border: 1px solid #ffffff38; box-shadow: 0 10px 30px #000a; font-size: 14px; font-weight: 600; }
    .undo span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ub { height: 40px; padding: 0 18px; border-radius: 999px; background: #fff; color: #000; font-weight: 800; font-size: 14px; }
    .undo ~ .toast { bottom: 76px; }
    .toast.solo { position: absolute; z-index: 3; }
    .confirm { z-index: 10; max-height: calc(100cqh - 24px); overflow-y: auto; }
    /* the panel only knows the card's own height (not the viewport): short cards get a full-height sheet and tighter rows */
    .sh { flex: none; }
    @container spk (max-height: 560px) {
      .sheet { max-height: 100%; } .sh { padding-top: 8px; padding-bottom: 6px; } .tn { font-size: 18px; }
      .body { padding-top: 8px; gap: 10px; } .vr { padding: 4px 0; } .chip { height: 40px; }
    }
    .ask-scrim { z-index: 9; }
    .tk { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 15px; color: var(--_fg); }
    .sp-ask.danger .cbtn.ok { background: #fff; }
    /* tablet: right drawer */
    @container spk (min-width: 641px) {
      .sheet { left: auto; top: 0; bottom: 0; right: 0; width: min(440px, 92cqw); max-height: none; border-radius: 0; border-width: 0 0 0 1px; box-shadow: -20px 0 60px #000c; }
    }
    /* wide (1280+, incl. 1080p after the card's zoom): wider drawer, two-column rooms */
    @container spk (min-width: 1200px) {
      .sheet { width: min(760px, 58cqw); }
      .rooms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; }
      .vr + .vr { border-top: 0; } .rooms .vr { border-bottom: 1px solid var(--_divider); }
    }
    /* large_buttons */
    :host([large]) .chip { height: 56px; font-size: 17px; padding: 0 20px; }
    :host([large]) .act { height: 52px; font-size: 16px; padding: 0 18px; }
    :host([large]) .vm { width: 52px; height: 52px; } :host([large]) .vm .i { width: 28px; height: 28px; }
    :host([large]) .vr { grid-template-columns: 52px minmax(0, 1fr) auto; }
    :host([large]) .vn { font-size: 18px; } :host([large]) .vn small { font-size: 14px; }
    :host([large]) .vs { --jb-slider-h: 10px; --jb-slider-knob: 30px; --jb-slider-hit: 52px; }
    :host([large]) .x { width: 60px; height: 60px; } :host([large]) .ub { height: 52px; font-size: 16px; }
    @media (prefers-reduced-motion: reduce) { .chip:active { transform: none; } }
  `];
}
function errText(e: unknown) {
  if (e instanceof SpeakerError) return e.code === 'timeout' ? 'no answer in time' : e.code === 'config' ? 'mass_queue_entry_id is not set' : e.message.replace(/^.*?:\s*/, '') || 'failed';
  return String((e as any)?.message ?? e);
}
if (!customElements.get('jb-speakers')) customElements.define('jb-speakers', JbSpeakers);

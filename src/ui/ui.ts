// DOM overlay: menus, HUD and item panels. Plain DOM keeps it light and lets
// the canvas do only map/sprite work.

import { ITEMS, itemName, type ItemStack } from '../game/items';
import type { Container, GameWorld } from '../game/world';
import type { OutbreakHistory, RegionState } from '../sim/outbreak';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export interface MenuInfo {
  hasSave: boolean;
  saveText: string;
  attribution: string;
}

export class UI {
  private root: HTMLElement;
  private layers: Record<string, HTMLElement> = {};

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private layer(name: string, html?: string): HTMLElement {
    let e = this.layers[name];
    if (html !== undefined) {
      e?.remove();
      e = el(html);
      e.id = name;
      this.root.appendChild(e);
      this.layers[name] = e;
    }
    return e;
  }

  hide(...names: string[]) {
    for (const n of names) this.layers[n]?.classList.add('hidden');
  }

  show(name: string) {
    this.layers[name]?.classList.remove('hidden');
  }

  isOpen(name: string) {
    const e = this.layers[name];
    return !!e && !e.classList.contains('hidden');
  }

  menu(info: MenuInfo, on: { continue: () => void; newWorld: (seed: string, overpass: boolean) => void }) {
    const m = this.layer('menu', `
      <div class="screen">
        <div class="title">POCKETPOCALYPSE</div>
        <div class="subtitle">The Netherlands, a few weeks after the end. Real streets, real canals, real polders, all of it overrun. Pick any spot in the country and drop in.</div>
        <div class="row">
          ${info.hasSave ? `<button class="primary" data-a="continue">Continue · ${esc(info.saveText)}</button>` : ''}
          <button ${info.hasSave ? '' : 'class="primary"'} data-a="new">New world</button>
        </div>
        <div class="row">
          <label>Seed <input type="text" id="seed" placeholder="random" /></label>
          <label><input type="checkbox" id="overpass" checked /> Stream live OpenStreetMap data</label>
        </div>
        <div class="subtitle" style="font-size:11px">WASD move · Shift sprint · Mouse aim · Click attack · E search · I inventory · M map · Wheel zoom</div>
        <div class="attribution">${esc(info.attribution)}</div>
      </div>`);
    m.onclick = (ev) => {
      const a = (ev.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
      if (a === 'continue') on.continue();
      if (a === 'new') {
        if (info.hasSave && !confirm('Start a new world? Your current world will be lost.')) return;
        on.newWorld((m.querySelector('#seed') as HTMLInputElement).value, (m.querySelector('#overpass') as HTMLInputElement).checked);
      }
    };
    this.show('menu');
  }

  select(history: OutbreakHistory, presets: { name: string }[], onPreset: (i: number) => void, onRandom: () => void) {
    const tl = history.timeline.slice(0, 3).concat(history.timeline.slice(-4));
    const s = this.layer('select', `
      <div>
        <div id="select-bar" class="panel">
          <h2>Choose where to begin</h2>
          <div>Click anywhere in the Netherlands, or pick a place:</div>
          <div id="presets">${presets.map((p, i) => `<button class="small" data-p="${i}">${esc(p.name)}</button>`).join('')}<button class="small" data-r="1">Random</button></div>
          <div class="legend"><span><i style="background:#c8382e"></i>overrun</span><span><i style="background:#d9b44a"></i>quarantine fell</span><span><i style="background:#7aa6c9"></i>evacuated</span><span><i style="background:#e0602a"></i>burned</span></div>
        </div>
        <div id="select-side" class="panel">
          <h3>${esc(history.strain)}</h3>
          <div class="tl">
            <div>Day −${history.arrivalDay}: first cases in <b>${esc(history.origin)}</b>.</div>
            ${tl.map((e) => `<div>Day ${e.day}: <b>${esc(e.text)}</b></div>`).join('')}
          </div>
        </div>
      </div>`);
    s.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      const p = t.closest('[data-p]')?.getAttribute('data-p');
      if (p !== null && p !== undefined) onPreset(Number(p));
      if (t.closest('[data-r]')) onRandom();
    };
    this.show('select');
  }

  flight(big: string, small: string) {
    let f = this.layers.flight;
    if (!f) f = this.layer('flight', `<div><div class="big"></div><div class="small"></div></div>`);
    (f.querySelector('.big') as HTMLElement).textContent = big;
    (f.querySelector('.small') as HTMLElement).textContent = small;
    this.show('flight');
  }

  hud() {
    if (!this.layers.hud) {
      this.layer('hud', `
        <div>
          <div class="where"><div class="place"></div><div class="status"></div><div class="muted coords"></div></div>
          <div class="stats"></div>
          <div class="log"></div>
          <div class="bars">
            <div class="bar"><div class="hp" style="background:#b8352c"></div><span>HEALTH</span></div>
            <div class="bar"><div class="st" style="background:#c9b04a"></div><span>STAMINA</span></div>
            <div class="bar"><div class="fd" style="background:#8a6a3a"></div><span>FOOD</span></div>
            <div class="bar"><div class="wt" style="background:#4a8ab8"></div><span>WATER</span></div>
          </div>
          <div class="weapon"><div class="name"></div><div class="ammo"></div></div>
          <div class="prompt hidden"></div>
          <div class="progress hidden"><div></div></div>
          <div class="compass hidden"></div>
          <div class="keys">WASD move · Shift sprint · Click attack · E search · I inventory · M map · Wheel zoom · F3 debug</div>
        </div>`);
    }
    this.show('hud');
  }

  updateHud(w: GameWorld, region: RegionState | null, coords: string, prompt: string | null, progress: number | null, compass: { x: number; y: number; text: string; angle: number } | null) {
    const h = this.layers.hud;
    if (!h) return;
    const p = w.player;
    const q = (s: string) => h.querySelector(s) as HTMLElement;
    q('.hp').style.width = `${Math.max(0, p.hp)}%`;
    q('.st').style.width = `${p.stamina}%`;
    q('.fd').style.width = `${p.hunger}%`;
    q('.wt').style.width = `${p.thirst}%`;
    if (region?.city) {
      const c = region.city;
      const ago = w.save.history.presentDay - c.collapseDay;
      const fate = c.fate === 'quarantine-fell' ? 'quarantine zone, fell' : c.fate;
      q('.place').textContent = region.distanceKm < 3 ? c.name : `Near ${c.name} (${region.distanceKm.toFixed(1)} km)`;
      q('.status').textContent = `${fate} · ${ago > 0 ? `${ago} days since collapse` : 'collapsing'} · threat ${Math.round(region.intensity * 10)}/10`;
    }
    q('.coords').textContent = coords;
    const eq = p.equipped ? ITEMS[p.equipped] : null;
    q('.name').textContent = eq ? eq.name : 'Bare hands';
    q('.ammo').textContent = eq?.weapon?.ammo ? `${p.count(eq.weapon.ammo)} rounds` : '';
    q('.stats').innerHTML = `Survivor #${p.survivor}<br/>Kills ${p.kills}<br/>Alive ${fmtTime(p.timeAlive)}`;
    const pr = q('.prompt');
    if (prompt) {
      pr.textContent = prompt;
      pr.classList.remove('hidden');
    } else pr.classList.add('hidden');
    const pg = q('.progress');
    if (progress !== null) {
      (pg.firstElementChild as HTMLElement).style.width = `${progress * 100}%`;
      pg.classList.remove('hidden');
    } else pg.classList.add('hidden');
    const log = q('.log');
    const recent = w.log.filter((l) => w.time - l.t < 6);
    log.innerHTML = recent.map((l) => `<div style="opacity:${Math.min(1, 6 - (w.time - l.t))}">${esc(l.text)}</div>`).join('');
    const cp = q('.compass');
    if (compass) {
      cp.style.transform = `translate(${compass.x}px, ${compass.y}px) translate(-50%,-50%)`;
      cp.innerHTML = `<span style="display:inline-block;transform:rotate(${compass.angle}rad)">➤</span> ${esc(compass.text)}`;
      cp.classList.remove('hidden');
    } else cp.classList.add('hidden');
  }

  loot(w: GameWorld, c: Container, onChange: () => void) {
    const items = w.contents(c);
    const m = this.layer('loot', `
      <div class="modal panel">
        <h3><span>${esc(c.label)}</span><button class="small" data-x="1">Close</button></h3>
        <div class="items">
          ${items.length ? items.map((s, i) => itemRow(s, `<button class="small" data-t="${i}">Take</button>`)).join('') : '<div class="empty">Nothing useful left.</div>'}
        </div>
        ${items.length ? '<div class="row" style="margin-top:10px"><button class="primary small" data-all="1">Take all (F)</button></div>' : ''}
      </div>`);
    m.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('[data-x]')) this.hide('loot');
      const ti = t.closest('[data-t]')?.getAttribute('data-t');
      if (ti !== undefined && ti !== null) w.take(c, Number(ti));
      if (t.closest('[data-all]')) w.take(c, 'all');
      if (ti !== undefined || t.closest('[data-all]')) {
        onChange();
        this.loot(w, c, onChange);
      }
    };
    this.show('loot');
  }

  inventory(w: GameWorld) {
    const p = w.player;
    const m = this.layer('inv', `
      <div class="modal panel">
        <h3><span>Backpack ${p.inventory.length}/16</span><button class="small" data-x="1">Close</button></h3>
        <div class="items">
          ${p.inventory.length ? p.inventory.map((s, i) => {
            const d = ITEMS[s.id];
            const use = d?.weapon ? (p.equipped === s.id ? 'Unequip' : 'Equip') : d && ['food', 'drink', 'medical'].includes(d.cat) ? 'Use' : '';
            return itemRow(s, `${use ? `<button class="small" data-u="${i}">${use}</button>` : ''}<button class="small" data-d="${i}">Drop</button>`, p.equipped === s.id);
          }).join('') : '<div class="empty">Empty.</div>'}
        </div>
      </div>`);
    m.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('[data-x]')) return this.hide('inv');
      const u = t.closest('[data-u]')?.getAttribute('data-u');
      const d = t.closest('[data-d]')?.getAttribute('data-d');
      if (u != null) w.useItem(Number(u));
      if (d != null) w.dropItem(Number(d));
      if (u != null || d != null) this.inventory(w);
    };
    this.show('inv');
  }

  death(w: GameWorld, cause: string, onRespawn: () => void) {
    const p = w.player;
    const d = this.layer('death', `
      <div class="screen" style="background:rgba(20,0,0,0.55)">
        <div class="title">YOU DIED</div>
        <div class="subtitle">Survivor #${p.survivor} ${cause === 'starvation' ? 'starved' : 'was torn apart'} after ${fmtTime(p.timeAlive)} with ${p.kills} kills.<br/>Everything you carried is still on your body. Go back and get it.</div>
        <button class="primary" data-r="1">Wake up as survivor #${p.survivor + 1}</button>
      </div>`);
    d.onclick = (ev) => {
      if ((ev.target as HTMLElement).closest('[data-r]')) onRespawn();
    };
    this.show('death');
  }

  toast(text: string, ms = 3500) {
    const t = this.layer('toast', `<div class="panel">${esc(text)}</div>`);
    setTimeout(() => {
      if (this.layers.toast === t) this.hide('toast');
    }, ms);
  }

  debug(text: string | null) {
    if (text === null) return this.hide('debug');
    let d = this.layers.debug;
    if (!d) d = this.layer('debug', '<div></div>');
    d.textContent = text;
    this.show('debug');
  }

  attribution(text: string) {
    let a = this.layers.attr;
    if (!a) a = this.layer('attr', '<div class="attribution"></div>');
    a.textContent = text;
  }
}

function itemRow(s: ItemStack, actions: string, equipped = false) {
  const d = ITEMS[s.id];
  return `<div class="item${equipped ? ' eq' : ''}"><span class="sw" style="background:${d?.color ?? '#888'}"></span><span class="nm">${esc(itemName(s.id))}${s.qty > 1 ? ` ×${s.qty}` : ''}</span>${actions}</div>`;
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s.toString().padStart(2, '0')}s`;
}

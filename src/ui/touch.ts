// On-screen controls for phones and tablets: a floating joystick on the left
// half of the screen and round action buttons on the right. They appear once
// the device has touch, and feed the same Input the keyboard does.

export type TouchMode = 'off' | 'playing' | 'map';

export interface TouchActions {
  interact: () => void;
  bag: () => void;
  map: () => void;
}

/** Push past this fraction of the stick radius to sprint. */
const SPRINT_AT = 0.85;
const RADIUS = 52;

export function hasTouch(): boolean {
  return navigator.maxTouchPoints > 0 || 'ontouchstart' in window || matchMedia('(pointer: coarse)').matches;
}

export class TouchControls {
  moveX = 0;
  moveY = 0;
  sprint = false;
  attack = false;
  /** Set on every HIT press, so a quick tap between two frames still swings; the game clears it. */
  attackTapped = false;
  /** True once the person has used touch; switches hints and aiming. */
  enabled = hasTouch();

  private root: HTMLElement;
  private zone: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private stick: { id: number; x: number; y: number } | null = null;
  private attackId: number | null = null;
  private mode: TouchMode = 'off';

  constructor(parent: HTMLElement, on: TouchActions) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.innerHTML = `
      <div class="zone"></div>
      <div class="stick hidden"><div class="knob"></div></div>
      <div class="buttons">
        <button class="tb attack" data-b="attack">HIT</button>
        <button class="tb" data-b="interact">SEARCH</button>
        <button class="tb" data-b="bag">BAG</button>
        <button class="tb" data-b="map">MAP</button>
      </div>`;
    parent.appendChild(this.root);
    this.zone = this.root.querySelector('.zone') as HTMLElement;
    this.base = this.root.querySelector('.stick') as HTMLElement;
    this.knob = this.root.querySelector('.knob') as HTMLElement;

    this.zone.addEventListener('pointerdown', (e) => {
      if (this.stick) return;
      e.preventDefault();
      this.zone.setPointerCapture(e.pointerId);
      this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.base.classList.remove('hidden');
      this.setKnob(0, 0);
    });
    this.zone.addEventListener('pointermove', (e) => {
      if (!this.stick || e.pointerId !== this.stick.id) return;
      let dx = e.clientX - this.stick.x, dy = e.clientY - this.stick.y;
      const d = Math.hypot(dx, dy);
      if (d > RADIUS) {
        // drag the stick along so a long swipe never runs out of room
        this.stick.x += (dx / d) * (d - RADIUS);
        this.stick.y += (dy / d) * (d - RADIUS);
        this.base.style.transform = `translate(${this.stick.x}px, ${this.stick.y}px)`;
        dx = (dx / d) * RADIUS;
        dy = (dy / d) * RADIUS;
      }
      this.setKnob(dx, dy);
    });
    const release = (e: PointerEvent) => {
      if (!this.stick || e.pointerId !== this.stick.id) return;
      this.stick = null;
      this.base.classList.add('hidden');
      this.setKnob(0, 0);
    };
    this.zone.addEventListener('pointerup', release);
    this.zone.addEventListener('pointercancel', release);

    const buttons = this.root.querySelector('.buttons') as HTMLElement;
    buttons.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest('[data-b]')?.getAttribute('data-b');
      if (!b) return;
      e.preventDefault();
      if (b === 'attack') {
        this.attackId = e.pointerId;
        this.attack = true;
        this.attackTapped = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } else if (b === 'interact') on.interact();
      else if (b === 'bag') on.bag();
      else if (b === 'map') on.map();
    });
    const stopAttack = (e: PointerEvent) => {
      if (e.pointerId !== this.attackId) return;
      this.attackId = null;
      this.attack = false;
    };
    buttons.addEventListener('pointerup', stopAttack);
    buttons.addEventListener('pointercancel', stopAttack);
    // a long press must not open the browser's context menu
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.enabled) {
        this.enabled = true;
        this.apply();
      }
    }, { capture: true });
    this.apply();
  }

  setMode(mode: TouchMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'playing') this.reset();
    this.apply();
  }

  /** Let go of everything, e.g. when a panel opens over the controls. */
  reset() {
    this.stick = null;
    this.attackId = null;
    this.attack = false;
    this.base.classList.add('hidden');
    this.setKnob(0, 0);
  }

  private setKnob(dx: number, dy: number) {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // a small dead zone so resting a thumb on the stick doesn't walk
    const live = Math.hypot(dx, dy) > RADIUS * 0.15;
    this.moveX = live ? dx / RADIUS : 0;
    this.moveY = live ? dy / RADIUS : 0;
    this.sprint = Math.hypot(dx, dy) >= RADIUS * SPRINT_AT;
  }

  private apply() {
    this.root.className = this.enabled ? `mode-${this.mode}` : 'mode-off';
  }
}

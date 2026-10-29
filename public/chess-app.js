// 체스 앱: 컴퓨터(Stockfish)와 두기, 한 화면에서 둘이 두기, 온라인 방 만들기·참여.
// 화면: #/chess (고르기), #/chess/ai, #/chess/local, #/chess/online (방 목록), #/chess/room/<코드>
import { Chess } from './vendor/chess.js';

const PIECES = '/vendor/pieces.svg';
const FILES = 'abcdefgh';
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
const NAMES = { w: '백', b: '흑' };
const REASONS = {
  checkmate: '체크메이트',
  resign: '기권',
  timeout: '시간 초과',
  'timeout-draw': '시간 초과 (상대 기물 부족으로 무승부)',
  stalemate: '스테일메이트 (둘 곳 없음)',
  material: '기물 부족',
  repetition: '같은 장면 3번 반복',
  fifty: '50수 규칙',
  agreement: '합의',
  abandon: '상대가 나감'
};
const AI_KEY = 'chessAiGame';
const LOCAL_KEY = 'chessLocalGame';
const AI_LEVEL_KEY = 'chessAiLevel';

let ctx; // { app, el, api, me, isCurrent, showToast }
let cleanups = [];

// 다른 화면으로 갈 때 타이머·엔진을 멈춘다 (app.js 의 route 가 부른다)
export function stopChess() {
  for (const fn of cleanups) fn();
  cleanups = [];
}

const onLeave = (fn) => cleanups.push(fn);
const h = (...args) => ctx.el(...args);

function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function renderChess(parts, context) {
  stopChess();
  ctx = context;
  const [, page, arg] = parts;
  if (page === 'ai') return renderAi();
  if (page === 'local') return renderLocal();
  if (page === 'online') return renderLobby();
  if (page === 'room' && /^[A-Za-z2-9]{6}$/.test(arg || '')) return renderRoom(arg.toUpperCase());
  return renderMenu();
}

// ---------- 고르기 ----------

function renderMenu() {
  const card = (href, icon, title, text) => h('a', { class: 'chess-mode', href },
    h('span', { class: 'chess-mode-icon', text: icon }),
    h('span', { class: 'chess-mode-text' }, h('strong', { text: title }), h('span', { text })));
  ctx.app.replaceChildren(h('div', { class: 'chess-menu' },
    h('h1', { text: '체스' }),
    card('#/chess/online', '♞', '친구랑 온라인 대결', '방을 만들어 코드를 알려 주거나, 친구 방에 참여해요'),
    card('#/chess/ai', '♚', '컴퓨터랑 두기', '1~10단계 실력의 컴퓨터와 둬요'),
    card('#/chess/local', '♟', '한 화면에서 둘이 두기', '한 기기로 번갈아 가며 둬요')));
}

// ---------- 판 ----------
// 클릭(누르고 놓기)이나 끌어서 둔다. 둘 수 있는 칸은 점으로 보여 준다.

class Board {
  constructor({ onMove }) {
    this.onMove = onMove;
    this.game = new Chess();
    this.orientation = 'w';
    this.movable = null; // 지금 움직일 수 있는 색 ('w' | 'b' | null)
    this.lastMove = null;
    this.hint = null;
    this.selected = null;
    this.drag = null;
    this.root = h('div', { class: 'board' });
    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.moveDrag(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', () => this.cancelDrag());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  set({ game, orientation, movable, lastMove, hint }) {
    if (game) this.game = game;
    if (orientation) this.orientation = orientation;
    if (movable !== undefined) this.movable = movable;
    if (lastMove !== undefined) this.lastMove = lastMove;
    this.hint = hint || null;
    if (this.selected && this.game.get(this.selected)?.color !== this.movable) this.selected = null;
    this.render();
  }

  squareAt(row, col) {
    return this.orientation === 'w' ? `${FILES[col]}${8 - row}` : `${FILES[7 - col]}${row + 1}`;
  }

  squareFromPoint(x, y) {
    const r = this.root.getBoundingClientRect();
    const col = Math.floor(((x - r.left) / r.width) * 8);
    const row = Math.floor(((y - r.top) / r.height) * 8);
    return col < 0 || col > 7 || row < 0 || row > 7 ? null : this.squareAt(row, col);
  }

  dests(from) {
    return from ? this.game.moves({ square: from, verbose: true }) : [];
  }

  render() {
    const dests = new Map(this.dests(this.selected).map((m) => [m.to, m]));
    const checkSq = this.game.inCheck() ? this.findKing(this.game.turn()) : null;
    const squares = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareAt(row, col);
        const piece = this.game.get(sq);
        const light = (FILES.indexOf(sq[0]) + Number(sq[1])) % 2 === 1;
        const cls = ['sq', light ? 'light' : 'dark'];
        if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) cls.push('last');
        if (this.hint && (this.hint.from === sq || this.hint.to === sq)) cls.push('hint');
        if (this.selected === sq) cls.push('selected');
        if (checkSq === sq) cls.push('check');
        if (dests.has(sq)) cls.push(piece ? 'capture' : 'dest');
        const node = h('div', { class: cls.join(' '), 'data-sq': sq });
        if (piece) node.append(pieceSvg(piece, this.drag?.from === sq && this.drag.moved ? 'piece dragging' : 'piece'));
        if (col === 0) node.append(h('span', { class: 'coord rank', text: sq[1] }));
        if (row === 7) node.append(h('span', { class: 'coord file', text: sq[0] }));
        squares.push(node);
      }
    }
    this.root.replaceChildren(...squares);
    if (this.drag?.ghost) this.root.append(this.drag.ghost);
    if (this.picker) this.root.append(this.picker);
  }

  findKing(color) {
    for (const row of this.game.board()) {
      for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
    }
    return null;
  }

  canPick(sq) {
    const p = this.game.get(sq);
    return !!p && p.color === this.movable && p.color === this.game.turn();
  }

  down(e) {
    if (this.picker || e.button > 0) return;
    const sq = this.squareFromPoint(e.clientX, e.clientY);
    if (!sq) return;
    e.preventDefault();
    // 이미 고른 말이 갈 수 있는 칸을 누르면 둔다
    if (this.selected && this.dests(this.selected).some((m) => m.to === sq)) {
      this.tryMove(this.selected, sq);
      return;
    }
    if (!this.canPick(sq)) {
      this.selected = null;
      this.render();
      return;
    }
    const wasSelected = this.selected === sq;
    this.selected = sq;
    this.drag = { from: sq, x: e.clientX, y: e.clientY, moved: false, wasSelected, ghost: null };
    this.root.setPointerCapture(e.pointerId);
    this.render();
  }

  moveDrag(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    if (!d.moved) {
      d.moved = true;
      d.ghost = pieceSvg(this.game.get(d.from), 'piece ghost');
      this.render();
    }
    const r = this.root.getBoundingClientRect();
    const size = r.width / 8;
    d.ghost.style.width = `${size}px`;
    d.ghost.style.height = `${size}px`;
    d.ghost.style.transform = `translate(${e.clientX - r.left - size / 2}px, ${e.clientY - r.top - size / 2}px)`;
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const sq = this.squareFromPoint(e.clientX, e.clientY);
    if (d.moved && sq && sq !== d.from && this.dests(d.from).some((m) => m.to === sq)) {
      this.tryMove(d.from, sq);
      return;
    }
    // 고른 말을 다시 누르면 고르기 취소
    if (!d.moved && d.wasSelected) this.selected = null;
    this.render();
  }

  cancelDrag() {
    this.drag = null;
    this.render();
  }

  tryMove(from, to) {
    const moves = this.dests(from).filter((m) => m.to === to);
    if (!moves.length) return;
    this.selected = null;
    if (moves.some((m) => m.promotion)) {
      this.showPicker(from, to);
      return;
    }
    this.render();
    this.onMove(from, to);
  }

  // 폰이 끝에 닿으면 무엇으로 바꿀지 고른다
  showPicker(from, to) {
    const color = this.game.get(from).color;
    const close = () => { this.picker = null; this.render(); };
    this.picker = h('div', { class: 'promo' },
      h('div', { class: 'promo-box' },
        h('p', { text: '무엇으로 바꿀까요?' }),
        h('div', { class: 'promo-row' }, ...['q', 'r', 'b', 'n'].map((type) => {
          const btn = h('button', { type: 'button', 'aria-label': type, onclick: (e) => {
            e.stopPropagation();
            this.picker = null;
            this.render();
            this.onMove(from, to, type);
          } });
          btn.append(pieceSvg({ color, type }, 'piece'));
          return btn;
        })),
        h('button', { type: 'button', class: 'promo-cancel', text: '취소', onclick: (e) => { e.stopPropagation(); close(); } })));
    this.picker.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.render();
  }
}

function pieceSvg(piece, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `${PIECES}#${piece.color}${piece.type}`);
  svg.append(use);
  return svg;
}

// ---------- 판 옆 정보: 이름·시계·잡은 기물, 기보 ----------

function material(game) {
  const left = { w: { ...START_COUNT }, b: { ...START_COUNT } };
  for (const row of game.board()) for (const p of row) if (p) left[p.color][p.type]--;
  // left[color][type] = 그 색이 잃은 기물 수
  const score = (c) => Object.entries(left[c]).reduce((s, [t, n]) => s + Math.max(n, 0) * VALUES[t], 0);
  return { lost: left, diff: score('b') - score('w') }; // diff > 0 이면 백이 유리
}

function playerBar(color, name, game, clockText) {
  const { lost, diff } = material(game);
  const enemy = color === 'w' ? 'b' : 'w';
  const taken = h('span', { class: 'taken' });
  for (const type of ['q', 'r', 'b', 'n', 'p']) {
    for (let i = 0; i < Math.max(lost[enemy][type], 0); i++) taken.append(pieceSvg({ color: enemy, type }, 'taken-piece'));
  }
  const lead = color === 'w' ? diff : -diff;
  if (lead > 0) taken.append(h('span', { class: 'lead', text: `+${lead}` }));
  const turn = game.turn() === color && !game.isGameOver();
  return h('div', { class: `player-bar${turn ? ' turn' : ''}` },
    h('span', { class: `player-dot ${color}` }),
    h('span', { class: 'player-name', text: name }),
    taken,
    clockText != null ? h('span', { class: 'clock', 'data-clock': color, text: clockText }) : null);
}

function moveList(game) {
  const history = game.history();
  const list = h('ol', { class: 'moves' });
  for (let i = 0; i < history.length; i += 2) {
    list.append(h('li', {}, h('span', { text: history[i] }), h('span', { text: history[i + 1] || '' })));
  }
  setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
  return list;
}

function endText(game) {
  if (game.isCheckmate()) return `${NAMES[game.turn() === 'w' ? 'b' : 'w']} 승리 · 체크메이트`;
  if (game.isStalemate()) return '무승부 · 스테일메이트 (둘 곳 없음)';
  if (game.isInsufficientMaterial()) return '무승부 · 기물 부족';
  if (game.isThreefoldRepetition()) return '무승부 · 같은 장면 3번 반복';
  if (game.isDrawByFiftyMoves()) return '무승부 · 50수 규칙';
  return '';
}

function replay(moves) {
  const game = new Chess();
  for (const m of moves || []) {
    try { game.move(m); } catch { break; }
  }
  return game;
}

function gameLayout({ board, top, bottom, side, banner }) {
  return h('div', { class: 'chess-game' },
    h('div', { class: 'board-col' }, top, h('div', { class: 'board-wrap' }, board.root, banner || null), bottom),
    h('div', { class: 'side-col' }, ...side));
}

// ---------- 컴퓨터 (Stockfish, 이 브라우저에서 계산) ----------

const LEVELS = [
  // [Stockfish 실력(0~20), 생각 시간(ms), 일부러 아무 수나 둘 확률]
  [0, 80, 0.5], [0, 120, 0.3], [2, 150, 0.15], [4, 200, 0.05], [6, 300, 0],
  [9, 400, 0], [12, 600, 0], [15, 800, 0], [18, 1000, 0], [20, 1500, 0]
];

class Engine {
  constructor() {
    const file = typeof WebAssembly === 'object' ? 'stockfish.js' : 'stockfish.asm.js';
    this.worker = new Worker(`/vendor/stockfish/${file}`);
    this.waiting = null;
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      if (line.startsWith('bestmove') && this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line.split(' ')[1]);
      }
    };
    this.worker.postMessage('uci');
  }

  best(fen, skill, ms) {
    if (this.waiting) this.worker.postMessage('stop');
    return new Promise((resolve) => {
      this.waiting = resolve;
      this.worker.postMessage(`setoption name Skill Level value ${skill}`);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go movetime ${ms}`);
    });
  }

  stop() {
    this.waiting = null;
    this.worker.terminate();
  }
}

const parseUci = (uci) => (uci && uci !== '(none)' ? { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] } : null);

function renderAi() {
  const saved = load(AI_KEY);
  if (!saved) return renderAiSetup();

  const game = replay(saved.moves);
  const you = saved.color;
  const ai = you === 'w' ? 'b' : 'w';
  const [skill, ms, randomness] = LEVELS[saved.level - 1] || LEVELS[4];
  const engine = new Engine();
  let thinking = false;
  let hint = null;
  onLeave(() => engine.stop());

  const board = new Board({ onMove: (from, to, promotion) => play({ from, to, promotion }) });
  const status = h('p', { class: 'chess-status', role: 'status' });

  function save() {
    store(AI_KEY, { ...saved, moves: game.history() });
  }

  function play(move) {
    try { game.move(move); } catch { return draw(); }
    hint = null;
    save();
    draw();
    if (!game.isGameOver()) aiTurn();
  }

  async function aiTurn() {
    if (game.turn() !== ai || game.isGameOver()) return;
    thinking = true;
    draw();
    const moves = game.moves({ verbose: true });
    let move;
    if (Math.random() < randomness) {
      await new Promise((r) => setTimeout(r, 400));
      move = moves[Math.floor(Math.random() * moves.length)];
    } else {
      move = parseUci(await engine.best(game.fen(), skill, ms));
    }
    if (!ctx.isCurrent() || game.turn() !== ai) return;
    thinking = false;
    try { game.move(move); } catch { game.move(moves[0]); }
    save();
    draw();
  }

  function draw() {
    const last = game.history({ verbose: true }).at(-1);
    board.set({ game, orientation: you, movable: thinking || game.isGameOver() ? null : you, lastMove: last ? { from: last.from, to: last.to } : null, hint });
    const over = endText(game);
    status.textContent = over || (thinking ? '컴퓨터가 생각하는 중…' : game.turn() === you ? (game.inCheck() ? '체크! 왕을 지키세요' : '내 차례') : '');
    status.className = `chess-status${over ? ' over' : ''}`;
    top.replaceWith(top = playerBar(ai, `컴퓨터 (${saved.level}단계)`, game));
    bottom.replaceWith(bottom = playerBar(you, '나', game));
    moves.replaceWith(moves = moveList(game));
  }

  let top = h('div');
  let bottom = h('div');
  let moves = h('div');
  const actions = h('div', { class: 'chess-actions' },
    h('button', { type: 'button', text: '무르기', onclick: () => {
      if (thinking) return;
      // 내 수까지 되돌린다 (컴퓨터 수 + 내 수)
      game.undo();
      if (game.turn() !== you) game.undo();
      hint = null;
      save();
      draw();
    } }),
    h('button', { type: 'button', text: '힌트', onclick: async () => {
      if (thinking || game.turn() !== you || game.isGameOver()) return;
      status.textContent = '좋은 수를 찾는 중…';
      const best = parseUci(await engine.best(game.fen(), 20, 800));
      if (!ctx.isCurrent()) return;
      hint = best;
      draw();
    } }),
    h('button', { type: 'button', text: '새 게임', onclick: () => {
      if (game.history().length && !game.isGameOver() && !confirm('지금 게임을 그만두고 새로 할까요?')) return;
      store(AI_KEY, null);
      stopChess();
      renderChess(['chess', 'ai'], ctx);
    } }));

  ctx.app.replaceChildren(gameLayout({ board, top, bottom, side: [status, moves, actions] }));
  draw();
  aiTurn();
}

function renderAiSetup() {
  let level = Number(load(AI_LEVEL_KEY)) || 3;
  let color = 'w';
  const levelLabel = h('strong', { text: `${level}단계` });
  const range = h('input', { type: 'range', min: '1', max: '10', value: String(level), 'aria-label': '컴퓨터 실력' });
  range.addEventListener('input', () => {
    level = Number(range.value);
    levelLabel.textContent = `${level}단계`;
  });
  const colorBtns = h('div', { class: 'seg' }, ...[['w', '백 (먼저)'], ['b', '흑'], ['random', '랜덤']].map(([value, text]) =>
    h('button', { type: 'button', text, class: value === color ? 'on' : '', onclick: (e) => {
      color = value;
      colorBtns.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
    } })));
  ctx.app.replaceChildren(h('div', { class: 'chess-panel' },
    h('h1', { text: '컴퓨터랑 두기' }),
    h('label', { class: 'field-label' }, h('span', { text: '컴퓨터 실력 ' }), levelLabel),
    range,
    h('p', { class: 'hint-text', text: '1~3단계는 처음 배우는 사람, 5단계 이상은 꽤 잘 두는 사람에게 맞아요.' }),
    h('span', { class: 'field-label', text: '내 색' }),
    colorBtns,
    h('button', { type: 'button', class: 'chess-primary', text: '시작하기', onclick: () => {
      const c = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
      store(AI_LEVEL_KEY, level);
      store(AI_KEY, { level, color: c, moves: [] });
      renderChess(['chess', 'ai'], ctx);
    } }),
    h('a', { class: 'chess-back', href: '#/chess', text: '← 체스 처음으로' })));
}

// ---------- 한 화면에서 둘이 ----------

function renderLocal() {
  const saved = load(LOCAL_KEY) || { moves: [], flip: true };
  const game = replay(saved.moves);
  const board = new Board({ onMove: (from, to, promotion) => {
    try { game.move({ from, to, promotion }); } catch { return; }
    save();
    draw();
  } });
  const status = h('p', { class: 'chess-status', role: 'status' });
  let top = h('div');
  let bottom = h('div');
  let moves = h('div');
  const save = () => store(LOCAL_KEY, { ...saved, moves: game.history() });

  function draw() {
    const last = game.history({ verbose: true }).at(-1);
    const view = saved.flip ? game.turn() : 'w';
    board.set({ game, orientation: view, movable: game.isGameOver() ? null : game.turn(), lastMove: last ? { from: last.from, to: last.to } : null });
    const over = endText(game);
    status.textContent = over || `${NAMES[game.turn()]} 차례${game.inCheck() ? ' · 체크!' : ''}`;
    status.className = `chess-status${over ? ' over' : ''}`;
    const other = view === 'w' ? 'b' : 'w';
    top.replaceWith(top = playerBar(other, NAMES[other], game));
    bottom.replaceWith(bottom = playerBar(view, NAMES[view], game));
    moves.replaceWith(moves = moveList(game));
  }

  const flip = h('label', { class: 'check-row' }, h('input', { type: 'checkbox' }), h('span', { text: '차례마다 판 돌리기' }));
  flip.querySelector('input').checked = saved.flip;
  flip.querySelector('input').addEventListener('change', (e) => {
    saved.flip = e.target.checked;
    save();
    draw();
  });
  const actions = h('div', { class: 'chess-actions' },
    h('button', { type: 'button', text: '무르기', onclick: () => { game.undo(); save(); draw(); } }),
    h('button', { type: 'button', text: '새 게임', onclick: () => {
      if (game.history().length && !game.isGameOver() && !confirm('지금 게임을 그만두고 새로 할까요?')) return;
      saved.moves = [];
      store(LOCAL_KEY, saved);
      renderChess(['chess', 'local'], ctx);
    } }));
  ctx.app.replaceChildren(gameLayout({ board, top, bottom, side: [status, moves, flip, actions] }));
  draw();
}

// ---------- 온라인: 방 목록, 만들기, 코드로 참여 ----------

const TIMES = [
  ['무제한', 0, 0], ['1분', 1, 0], ['3분', 3, 0], ['3분 +2초', 3, 2], ['5분', 5, 0],
  ['10분', 10, 0], ['15분 +10초', 15, 10], ['30분', 30, 0]
];

function timeLabel(time) {
  if (!time?.base) return '무제한';
  return `${time.base / 60000}분${time.inc ? ` +${time.inc / 1000}초` : ''}`;
}

function setupNeeded(err) {
  return h('div', { class: 'chess-panel' },
    h('h1', { text: '온라인 대결' }),
    h('p', { class: 'chess-error', text: err.message }),
    err.code === 'NO_CHESS_DB'
      ? h('p', { class: 'hint-text', text: '사이트 관리자가 Cloudflare 에서 D1 데이터베이스를 만들어 연결하면 쓸 수 있어요. 컴퓨터랑 두기와 한 화면에서 두기는 지금도 돼요.' })
      : null,
    h('a', { class: 'chess-back', href: '#/chess', text: '← 체스 처음으로' }));
}

function renderLobby() {
  let isPublic = true;
  let color = 'random';
  let timeIndex = 4;

  const seg = (options, current, set) => {
    const box = h('div', { class: 'seg' });
    for (const [value, text] of options) {
      box.append(h('button', { type: 'button', text, class: value === current ? 'on' : '', onclick: (e) => {
        set(value);
        box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      } }));
    }
    return box;
  };
  const timeSelect = h('select', { 'aria-label': '시간' }, ...TIMES.map(([label], i) => {
    const o = h('option', { value: String(i), text: label });
    if (i === timeIndex) o.selected = true;
    return o;
  }));
  timeSelect.addEventListener('change', () => { timeIndex = Number(timeSelect.value); });
  const createMsg = h('p', { class: 'chess-error', role: 'alert' });
  const createBtn = h('button', { type: 'button', class: 'chess-primary', text: '방 만들기', onclick: async () => {
    createBtn.disabled = true;
    createMsg.textContent = '';
    try {
      const [, base, inc] = TIMES[timeIndex];
      const { code } = await ctx.api('/api/chess/rooms', { method: 'POST', body: { public: isPublic, color, base, inc } });
      location.hash = `#/chess/room/${code}`;
    } catch (err) {
      createMsg.textContent = err.message;
      createBtn.disabled = false;
    }
  } });

  const codeInput = h('input', { type: 'text', maxlength: '6', placeholder: '방 코드 6자리', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': '방 코드' });
  const joinMsg = h('p', { class: 'chess-error', role: 'alert' });
  const joinForm = h('form', { class: 'join-form' }, codeInput, h('button', { type: 'submit', class: 'chess-primary', text: '참여' }));
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      joinMsg.textContent = '방 코드는 6자리예요.';
      return;
    }
    location.hash = `#/chess/room/${code}`;
  });

  const list = h('ul', { class: 'room-list' }, h('li', { class: 'room-empty', text: '불러오는 중…' }));
  async function refresh() {
    try {
      const rooms = await ctx.api('/api/chess/rooms');
      if (!ctx.isCurrent()) return;
      list.replaceChildren(...(rooms.length ? rooms.map((r) => h('li', {},
        h('div', { class: 'room-info' },
          h('strong', { text: `${r.host}님의 방` }),
          h('span', { text: `${timeLabel(r.time)} · 방장 ${r.hostColor === 'random' ? '랜덤' : NAMES[r.hostColor]}` })),
        h('a', { class: 'chess-primary small', href: `#/chess/room/${r.code}`, text: r.mine ? '내 방' : '참여' })))
        : [h('li', { class: 'room-empty', text: '지금 기다리는 공개 방이 없어요. 방을 만들어 보세요!' })]));
    } catch (err) {
      if (!ctx.isCurrent()) return;
      if (err.code === 'NO_CHESS_DB' || err.code === 'NO_DB') {
        stopChess();
        ctx.app.replaceChildren(setupNeeded(err));
        return;
      }
      list.replaceChildren(h('li', { class: 'room-empty', text: err.message }));
    }
  }
  const timer = setInterval(refresh, 4000);
  onLeave(() => clearInterval(timer));

  ctx.app.replaceChildren(h('div', { class: 'chess-lobby' },
    h('h1', { text: '친구랑 온라인 대결' }),
    h('section', { class: 'chess-panel' },
      h('h2', { text: '코드로 참여하기' }),
      joinForm, joinMsg),
    h('section', { class: 'chess-panel' },
      h('h2', { text: '방 만들기' }),
      h('span', { class: 'field-label', text: '공개' }),
      seg([[true, '공개 (목록에 보임)'], [false, '비공개 (코드로만)']], isPublic, (v) => { isPublic = v; }),
      h('span', { class: 'field-label', text: '내 색' }),
      seg([['random', '랜덤'], ['w', '백'], ['b', '흑']], color, (v) => { color = v; }),
      h('span', { class: 'field-label', text: '시간' }),
      timeSelect,
      createBtn, createMsg),
    h('section', { class: 'chess-panel' },
      h('h2', { text: '기다리는 공개 방' }),
      list),
    h('a', { class: 'chess-back', href: '#/chess', text: '← 체스 처음으로' })));
  refresh();
}

// ---------- 온라인: 방 안 ----------

function formatClock(ms) {
  const t = Math.max(0, ms);
  const s = Math.floor(t / 1000);
  if (t < 10_000) return `0:${String(Math.floor(t / 1000)).padStart(2, '0')}.${Math.floor((t % 1000) / 100)}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function renderRoom(code) {
  ctx.app.replaceChildren(h('p', { class: 'chess-status', text: '방에 들어가는 중…' }));
  let room;
  try {
    room = await ctx.api('/api/chess/join', { method: 'POST', body: { code } });
  } catch (err) {
    if (!ctx.isCurrent()) return;
    if (err.code === 'NO_CHESS_DB' || err.code === 'NO_DB') return ctx.app.replaceChildren(setupNeeded(err));
    ctx.app.replaceChildren(h('div', { class: 'chess-panel' },
      h('h1', { text: '방에 못 들어갔어요' }),
      h('p', { class: 'chess-error', text: err.message }),
      h('a', { class: 'chess-back', href: '#/chess/online', text: '← 방 목록으로' })));
    return;
  }
  if (!ctx.isCurrent()) return;

  let game = replay(room.moves);
  let receivedAt = Date.now();
  let busy = false;
  const board = new Board({ onMove: (from, to, promotion) => sendMove(from, to, promotion) });
  const status = h('p', { class: 'chess-status', role: 'status' });
  const banner = h('div', { class: 'chess-banner', hidden: '' });
  const offer = h('div', { class: 'offer', hidden: '' });
  const actions = h('div', { class: 'chess-actions' });
  let top = h('div');
  let bottom = h('div');
  let moves = h('div');
  let waitingView = null;
  let layoutShown = false;

  const act = async (action, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      apply(await ctx.api('/api/chess/action', { method: 'POST', body: { code, action } }));
    } catch (err) {
      ctx.showToast(err.message);
      if (err.code === 'NO_ROOM') location.hash = '#/chess/online';
    }
  };

  async function sendMove(from, to, promotion) {
    // 바로 판에 보여 주고, 서버가 거절하면 서버 상태로 되돌린다
    try { game.move({ from, to, promotion }); } catch { return; }
    busy = true;
    draw();
    try {
      apply(await ctx.api('/api/chess/move', { method: 'POST', body: { code, from, to, promotion } }));
    } catch (err) {
      ctx.showToast(err.message);
      room.v = -1; // 다음 확인 때 전체를 다시 받는다
      await poll();
    } finally {
      busy = false;
      draw();
    }
  }

  function apply(next) {
    if (!next || next.same) return;
    room = next;
    receivedAt = Date.now();
    game = replay(room.moves);
    draw();
  }

  async function poll() {
    try {
      const next = await ctx.api(`/api/chess/room?code=${code}&v=${room.v}`);
      if (!ctx.isCurrent()) return;
      if (!busy) apply(next);
    } catch (err) {
      if (!ctx.isCurrent()) return;
      if (err.code === 'NO_ROOM') {
        stopChess();
        ctx.app.replaceChildren(h('div', { class: 'chess-panel' },
          h('h1', { text: '방이 없어졌어요' }),
          h('p', { class: 'hint-text', text: '방장이 방을 없앴거나 오래돼서 지워졌어요.' }),
          h('a', { class: 'chess-back', href: '#/chess/online', text: '← 방 목록으로' })));
      }
    }
  }

  // 시계: 서버가 준 남은 시간에서, 받은 뒤 흐른 시간만큼 둘 차례인 쪽을 줄여서 보여 준다
  function clocks() {
    if (!room.clock) return null;
    const c = { ...room.clock };
    if (room.status === 'playing' && room.moves.length >= 2) c[game.turn()] -= Date.now() - receivedAt;
    return c;
  }

  function tick() {
    const c = clocks();
    if (!c) return;
    for (const color of ['w', 'b']) {
      const node = ctx.app.querySelector(`[data-clock="${color}"]`);
      if (node) {
        node.textContent = formatClock(c[color]);
        node.classList.toggle('low', c[color] < 20_000);
      }
    }
  }

  function resultText() {
    if (room.result === '1/2-1/2') return `무승부 · ${REASONS[room.reason] || ''}`;
    const winner = room.result === '1-0' ? 'w' : 'b';
    const who = room.you ? (room.you === winner ? '내가 이겼어요!' : '내가 졌어요') : `${NAMES[winner]} 승리`;
    return `${who} · ${REASONS[room.reason] || ''}`;
  }

  function draw() {
    if (room.status === 'waiting') return drawWaiting();
    if (!layoutShown) {
      waitingView = null;
      layoutShown = true;
      ctx.app.replaceChildren(gameLayout({ board, top, bottom, banner, side: [status, offer, moves, actions] }));
    }
    const you = room.you;
    const orientation = you || 'w';
    const myTurn = room.status === 'playing' && you === game.turn() && !busy;
    board.set({ game, orientation, movable: myTurn ? you : null, lastMove: room.lastMove });

    const name = (c) => (c === 'w' ? room.white?.name : room.black?.name) || '?';
    const c = clocks();
    const other = orientation === 'w' ? 'b' : 'w';
    top.replaceWith(top = playerBar(other, name(other), game, c ? formatClock(c[other]) : null));
    bottom.replaceWith(bottom = playerBar(orientation, name(orientation) + (you ? ' (나)' : ''), game, c ? formatClock(c[orientation]) : null));
    moves.replaceWith(moves = moveList(game));

    if (room.status === 'ended') {
      status.textContent = resultText();
      status.className = 'chess-status over';
    } else if (!you) {
      status.textContent = `구경 중 · ${NAMES[game.turn()]} 차례`;
      status.className = 'chess-status';
    } else {
      status.textContent = myTurn ? (game.inCheck() ? '체크! 왕을 지키세요' : '내 차례') : busy ? '보내는 중…' : '상대 차례';
      status.className = `chess-status${myTurn ? ' mine' : ''}`;
    }

    // 상대의 무승부 제안·재대결 요청·나감 표시
    offer.hidden = true;
    offer.replaceChildren();
    const opp = you === 'w' ? 'b' : 'w';
    if (you && room.status === 'playing' && room.drawOffer === opp) {
      offer.hidden = false;
      offer.append(h('span', { text: '상대가 무승부를 제안했어요' }),
        h('button', { type: 'button', text: '수락', onclick: () => act('draw-accept') }),
        h('button', { type: 'button', text: '거절', onclick: () => act('draw-decline') }));
    } else if (you && room.status === 'playing' && room.opponentAway) {
      offer.hidden = false;
      offer.append(h('span', { text: '상대가 1분 넘게 안 보여요' }),
        h('button', { type: 'button', text: '승리 처리', onclick: () => act('claim', '상대가 나간 걸로 보고 이긴 걸로 끝낼까요?') }));
    } else if (you && room.status === 'ended' && room.rematch?.[opp] && !room.rematch?.[you]) {
      offer.hidden = false;
      offer.append(h('span', { text: '상대가 한 판 더 하고 싶어해요' }),
        h('button', { type: 'button', text: '한 판 더', onclick: () => act('rematch') }));
    }

    const btns = [];
    if (you && room.status === 'playing') {
      const draw = h('button', { type: 'button', text: room.drawOffer === you ? '무승부 제안함' : '무승부 제안', onclick: () => act('draw-offer') });
      draw.disabled = room.drawOffer === you;
      btns.push(draw, h('button', { type: 'button', class: 'danger', text: '기권', onclick: () => act('resign', '기권할까요? 지는 걸로 끝나요.') }));
    }
    if (you && room.status === 'ended') {
      const again = h('button', { type: 'button', class: 'chess-primary', text: room.rematch?.[you] ? '상대를 기다리는 중…' : '한 판 더 (색 바꿔서)', onclick: () => act('rematch') });
      again.disabled = !!room.rematch?.[you];
      btns.push(again);
    }
    btns.push(h('button', { type: 'button', text: '링크 복사', onclick: () => copyLink(code) }));
    btns.push(h('a', { class: 'button-like', href: '#/chess/online', text: '나가기' }));
    actions.replaceChildren(...btns);
    tick();
  }

  function drawWaiting() {
    layoutShown = false;
    if (!waitingView) {
      waitingView = h('div', { class: 'chess-panel waiting' },
        h('h1', { text: '친구를 기다리는 중…' }),
        h('p', { class: 'hint-text', text: '친구에게 이 코드를 알려 주세요. 친구가 체스 → 친구랑 온라인 대결 → 코드로 참여하기에 넣으면 바로 시작돼요.' }),
        h('div', { class: 'room-code', text: code }),
        h('p', { class: 'hint-text', text: `${timeLabel(room.time)} · ${room.public ? '공개 방' : '비공개 방'} · 내 색 ${room.you ? NAMES[room.you] : '?'}` }),
        h('div', { class: 'chess-actions' },
          h('button', { type: 'button', class: 'chess-primary', text: '링크 복사', onclick: () => copyLink(code) }),
          room.isHost ? h('button', { type: 'button', text: '방 없애기', onclick: async () => {
            await act('cancel');
            location.hash = '#/chess/online';
          } }) : null),
        h('div', { class: 'spinner' }));
      ctx.app.replaceChildren(waitingView);
    }
  }

  const pollTimer = setInterval(poll, 1000);
  const clockTimer = setInterval(tick, 100);
  onLeave(() => { clearInterval(pollTimer); clearInterval(clockTimer); });
  draw();
}

async function copyLink(code) {
  const link = `${location.origin}/#/chess/room/${code}`;
  try {
    await navigator.clipboard.writeText(link);
    ctx.showToast('링크를 복사했어요. 친구에게 보내 주세요.');
  } catch {
    prompt('이 링크를 복사해서 친구에게 보내 주세요', link);
  }
}

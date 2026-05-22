// Fallen — a tiny metroidvania playground.
// Movement, double jump, dash, wall cling/jump, and a tiny sword swing.

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // ---------- input ----------
  const keys = new Set();
  const pressed = new Set(); // edge-triggered for this frame
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    pressed.add(k);
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

  const held = (...ks) => ks.some(k => keys.has(k));
  const tapped = (...ks) => ks.some(k => pressed.has(k));

  // ---------- level ----------
  // Each room is a self-contained set of solids + a spawn hook. Routed by location.hash.
  let solids = [];

  const ROOMS = {
    playground: {
      build() {
        solids = [
          { x: 0, y: 500, w: W, h: 40 },
          { x: 0, y: 0, w: 20, h: H },
          { x: W - 20, y: 0, w: 20, h: H },
          { x: 0, y: 0, w: W, h: 20 },

          { x: 140, y: 440, w: 110, h: 18 },
          { x: 300, y: 390, w: 110, h: 18 },
          { x: 470, y: 320, w: 90, h: 18 },
          { x: 620, y: 320, w: 30, h: 180 },
          { x: 800, y: 320, w: 140, h: 18 },
          { x: 720, y: 120, w: 22, h: 180 },
          { x: 880, y: 60,  w: 22, h: 200 },
          { x: 480, y: 120, w: 220, h: 16 },
          { x: 70, y: 300, w: 70, h: 14 },
        ];
        spawnHusk(220, 410);
        spawnHusk(500, 290);
        spawnHusk(860, 290);
      },
      playerSpawn: { x: 60, y: 460 },
    },
    boss: {
      build() {
        // wide empty arena with just floor + walls + ceiling
        solids = [
          { x: 0, y: 500, w: W, h: 40 },
          { x: 0, y: 0, w: 20, h: H },
          { x: W - 20, y: 0, w: 20, h: H },
          { x: 0, y: 0, w: W, h: 20 },
        ];
        spawnWar(W - 180, 420);
      },
      playerSpawn: { x: 80, y: 460 },
    },
  };

  function loadRoom(name) {
    if (!ROOMS[name]) name = 'playground';
    enemies.length = 0;
    particles.length = 0;
    ROOMS[name].build();
    const sp = ROOMS[name].playerSpawn;
    player.x = sp.x; player.y = sp.y;
    player.vx = 0; player.vy = 0;
    player.hp = player.maxHp;
    player.invuln = 30;
    currentRoom = name;
  }
  let currentRoom = 'playground';

  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '') || 'playground';
    loadRoom(name);
  });

  // ---------- player ----------
  const player = {
    x: 60, y: 460,
    w: 18, h: 26,
    vx: 0, vy: 0,
    facing: 1,
    onGround: false,
    wasOnGround: false,
    jumpsLeft: 2,
    coyote: 0,
    jumpBuffer: 0,
    dashCooldown: 0,
    dashTime: 0,
    dashDir: 1,
    wallCling: 0, // -1 left, 1 right, 0 none
    attackTime: 0,
    attackCooldown: 0,
    attackHitIds: new Set(), // enemies already struck in this swing
    hp: 5,
    maxHp: 5,
    invuln: 0,
    hurtFlash: 0,
    trail: [],
  };

  // ---------- enemies ----------
  let enemyIdSeq = 1;
  const enemies = [];
  function spawnHusk(x, y) {
    enemies.push({
      id: enemyIdSeq++,
      type: 'husk',
      x, y, w: 22, h: 28,
      vx: -0.6, vy: 0,
      facing: -1,
      hp: 3,
      maxHp: 3,
      onGround: false,
      hitFlash: 0,
      knockTime: 0,
      dead: false,
      aggro: 0,
      contactDmg: 1,
    });
  }
  function spawnWar(x, y) {
    enemies.push({
      id: enemyIdSeq++,
      type: 'war',
      x, y, w: 44, h: 62,           // ~2.4x player height
      vx: 0, vy: 0,
      facing: -1,
      hp: 24,
      maxHp: 24,
      onGround: false,
      hitFlash: 0,
      knockTime: 0,
      dead: false,
      aggro: 0,
      contactDmg: 1,
      // AI state machine: idle | approach | windup | swing | recover | charge
      state: 'idle',
      stateTime: 0,
      cooldown: 60,
      swingHit: false,          // whether the current swing has connected
      isBoss: true,
    });
  }

  let hitstop = 0; // frames where the world freezes for impact juice

  // tuning (all in px/frame at 60fps)
  const GRAVITY = 0.6;
  const MAX_FALL = 13;
  const MOVE = 0.7;
  const FRICTION = 0.82;
  const AIR_FRICTION = 0.94;
  const MAX_SPEED = 4.2;
  const JUMP_V = -10.2;
  const DOUBLE_JUMP_V = -9.2;
  const COYOTE_FRAMES = 6;
  const BUFFER_FRAMES = 6;
  const DASH_SPEED = 11;
  const DASH_FRAMES = 11;
  const DASH_CD = 28;
  const WALL_SLIDE = 1.6;
  const WALL_JUMP_X = 7;
  const WALL_JUMP_Y = -9.5;
  const ATTACK_FRAMES = 12;
  const ATTACK_CD = 18;

  // ---------- particles ----------
  const particles = [];
  function spawnParticles(x, y, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * (opts.spread || 3),
        vy: (Math.random() - 0.5) * (opts.spread || 3) - (opts.up || 0),
        life: opts.life || (20 + Math.random() * 20),
        maxLife: opts.life || 40,
        color: opts.color || '#cfe0ff',
        size: opts.size || (1 + Math.random() * 1.5),
        gravity: opts.gravity ?? 0.12,
      });
    }
  }

  // ---------- combat helpers ----------
  function damagePlayer(source, amount = 1) {
    const kdx = (player.x + player.w / 2) - (source.x + source.w / 2);
    player.vx = (kdx >= 0 ? 1 : -1) * (source.isBoss ? 7 : 5);
    player.vy = -5.5;
    player.hp -= amount;
    player.invuln = 60;
    player.hurtFlash = 16;
    hitstop = source.isBoss ? 8 : 5;
    shake = Math.max(shake, source.isBoss ? 11 : 7);
    spawnParticles(player.x + player.w / 2, player.y + player.h / 2, 14, {
      spread: 3.5, color: '#ff8a8a', life: 30,
    });
    if (player.hp <= 0) {
      player.hp = player.maxHp;
      const sp = ROOMS[currentRoom].playerSpawn;
      player.x = sp.x; player.y = sp.y; player.vx = 0; player.vy = 0;
      player.invuln = 90;
      shake = 14;
    }
  }

  // War's big sword sweeps from over-the-head down to the ground.
  // Hitbox is a wide rectangle in front of him while swinging.
  function warSwordHitbox(e) {
    const reach = 80;
    return {
      x: e.facing > 0 ? e.x + e.w - 6 : e.x - reach + 6,
      y: e.y + 4,
      w: reach,
      h: e.h + 6,
    };
  }

  // The full War boss AI lives here so the enemy loop stays readable.
  function updateWar(e, dx) {
    e.stateTime++;
    if (e.knockTime > 0) { e.vx *= 0.85; return; }

    const adx = Math.abs(dx);
    const facePlayer = () => { e.facing = dx >= 0 ? 1 : -1; };

    switch (e.state) {
      case 'idle': {
        e.vx *= 0.8;
        facePlayer();
        if (e.cooldown > 0) { e.cooldown--; break; }
        // pick next move based on range
        if (adx < 110) { e.state = 'windup'; e.stateTime = 0; e.swingHit = false; }
        else if (adx > 220 && Math.random() < 0.02) { e.state = 'charge'; e.stateTime = 0; }
        else { e.state = 'approach'; e.stateTime = 0; }
        break;
      }
      case 'approach': {
        facePlayer();
        e.vx = e.facing * 1.6;
        if (adx < 90) { e.state = 'windup'; e.stateTime = 0; e.swingHit = false; }
        else if (e.stateTime > 90) { e.state = 'idle'; e.cooldown = 20; }
        break;
      }
      case 'windup': {
        e.vx *= 0.7;
        facePlayer();
        // brief telegraph — about half a second
        if (e.stateTime >= 32) { e.state = 'swing'; e.stateTime = 0; }
        break;
      }
      case 'swing': {
        e.vx = e.facing * 1.2; // small step into the swing
        if (e.stateTime >= 16) { e.state = 'recover'; e.stateTime = 0; }
        break;
      }
      case 'recover': {
        e.vx *= 0.6;
        if (e.stateTime >= 28) {
          e.state = 'idle';
          // longer cooldown after a swing — this is the player's punish window
          e.cooldown = 45;
        }
        break;
      }
      case 'charge': {
        if (e.stateTime === 1) facePlayer();
        e.vx = e.facing * 5.5;
        if (e.stateTime >= 36 || adx < 40) {
          e.state = 'recover';
          e.stateTime = 0;
        }
        break;
      }
    }
  }

  // ---------- collision helpers ----------
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function moveAndCollide(p, dx, dy) {
    // axis-separated sweep
    p.x += dx;
    for (const s of solids) {
      if (rectsOverlap(p, s)) {
        if (dx > 0) p.x = s.x - p.w;
        else if (dx < 0) p.x = s.x + s.w;
        p.vx = 0;
      }
    }
    p.y += dy;
    p.onGround = false;
    for (const s of solids) {
      if (rectsOverlap(p, s)) {
        if (dy > 0) { p.y = s.y - p.h; p.onGround = true; p.vy = 0; }
        else if (dy < 0) { p.y = s.y + s.h; p.vy = 0; }
      }
    }
  }
  function touchingWall(p, dir) {
    const probe = { x: p.x + dir, y: p.y + 2, w: p.w, h: p.h - 4 };
    return solids.some(s => rectsOverlap(probe, s));
  }

  // ---------- background ----------
  // Procedural silhouette layers — Hollow-Knight-ish: deep teals + warm rim light.
  const bgLayers = (() => {
    const layers = [];
    const rng = mulberry32(7);
    for (let i = 0; i < 3; i++) {
      const pts = [];
      let x = -20;
      const baseY = 380 + i * 40;
      while (x < W + 40) {
        pts.push({ x, y: baseY + (rng() - 0.5) * (80 - i * 15) });
        x += 30 + rng() * 40;
      }
      layers.push({ pts, depth: i });
    }
    return layers;
  })();

  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const stars = Array.from({ length: 70 }, () => ({
    x: Math.random() * W,
    y: Math.random() * 280,
    r: Math.random() * 1.2 + 0.2,
    tw: Math.random() * Math.PI * 2,
  }));

  const mist = Array.from({ length: 14 }, () => ({
    x: Math.random() * W,
    y: 360 + Math.random() * 160,
    r: 80 + Math.random() * 120,
    s: 0.2 + Math.random() * 0.4,
  }));

  let shake = 0;
  let time = 0;

  // ---------- update ----------
  function update() {
    time++;
    if (hitstop > 0) {
      hitstop--;
      // tick a few cosmetics during freeze so impact reads
      for (const e of enemies) if (e.hitFlash > 0) e.hitFlash--;
      if (player.hurtFlash > 0) player.hurtFlash--;
      pressed.clear();
      return;
    }

    // ----- input -> intent
    const left = held('a', 'arrowleft');
    const right = held('d', 'arrowright');
    const jumpHit = tapped(' ', 'w', 'arrowup');
    const dashHit = tapped('shift');
    const attackHit = tapped('j', 'x');

    // horizontal accel
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir !== 0 && player.dashTime <= 0) {
      player.vx += dir * MOVE;
      player.facing = dir;
    }
    // friction
    if (player.dashTime <= 0) {
      player.vx *= player.onGround ? FRICTION : AIR_FRICTION;
      if (Math.abs(player.vx) < 0.05) player.vx = 0;
    }
    // clamp ground speed
    if (player.dashTime <= 0) {
      player.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, player.vx));
    }

    // gravity
    if (player.dashTime <= 0) {
      player.vy += GRAVITY;
      if (player.vy > MAX_FALL) player.vy = MAX_FALL;
    }

    // wall cling detect
    const wallL = touchingWall(player, -1);
    const wallR = touchingWall(player, 1);
    const onWall = !player.onGround && ((wallL && left) || (wallR && right));
    if (onWall && player.vy > WALL_SLIDE) player.vy = WALL_SLIDE;
    player.wallCling = onWall ? (wallR ? 1 : -1) : 0;

    // coyote + buffer
    if (player.onGround) player.coyote = COYOTE_FRAMES; else if (player.coyote > 0) player.coyote--;
    if (jumpHit) player.jumpBuffer = BUFFER_FRAMES; else if (player.jumpBuffer > 0) player.jumpBuffer--;

    // refresh jumps on ground
    if (player.onGround && !player.wasOnGround) {
      player.jumpsLeft = 2;
      spawnParticles(player.x + player.w / 2, player.y + player.h, 6, { spread: 2, color: '#7d92b8', life: 22 });
    }

    // jump logic
    if (player.jumpBuffer > 0) {
      if (player.wallCling !== 0) {
        // wall jump — push off the wall
        player.vx = -player.wallCling * WALL_JUMP_X;
        player.vy = WALL_JUMP_Y;
        player.facing = -player.wallCling;
        player.jumpBuffer = 0;
        player.coyote = 0;
        player.jumpsLeft = 1; // still get one air jump after wall jump
        spawnParticles(player.x + player.w / 2 + player.wallCling * 8, player.y + player.h / 2, 10, {
          spread: 3, color: '#a8c4ff', life: 26,
        });
      } else if (player.onGround || player.coyote > 0) {
        player.vy = JUMP_V;
        player.jumpsLeft = 1;
        player.jumpBuffer = 0;
        player.coyote = 0;
        spawnParticles(player.x + player.w / 2, player.y + player.h, 8, { spread: 2.5, color: '#cfe0ff', life: 22 });
      } else if (player.jumpsLeft > 0) {
        player.vy = DOUBLE_JUMP_V;
        player.jumpsLeft = 0;
        player.jumpBuffer = 0;
        // wing burst
        for (let i = 0; i < 14; i++) {
          particles.push({
            x: player.x + player.w / 2,
            y: player.y + player.h / 2,
            vx: Math.cos((i / 14) * Math.PI * 2) * 2.5,
            vy: Math.sin((i / 14) * Math.PI * 2) * 2.5,
            life: 24, maxLife: 24,
            color: '#fff0c4',
            size: 1.6,
            gravity: 0.02,
          });
        }
      }
    }

    // variable jump height — release jump cuts upward velocity
    if (!held(' ', 'w', 'arrowup') && player.vy < -3) player.vy *= 0.86;

    // dash
    if (player.dashCooldown > 0) player.dashCooldown--;
    if (dashHit && player.dashCooldown <= 0 && player.dashTime <= 0) {
      player.dashTime = DASH_FRAMES;
      player.dashCooldown = DASH_CD;
      player.dashDir = dir !== 0 ? dir : player.facing;
      player.vy = 0;
      spawnParticles(player.x + player.w / 2, player.y + player.h / 2, 12, {
        spread: 1, color: '#fff', life: 16, gravity: 0,
      });
      shake = Math.max(shake, 4);
    }
    if (player.dashTime > 0) {
      player.vx = player.dashDir * DASH_SPEED;
      player.vy = 0;
      player.dashTime--;
      if (time % 2 === 0) {
        player.trail.push({ x: player.x, y: player.y, life: 12, max: 12 });
      }
    }

    // attack
    if (player.attackCooldown > 0) player.attackCooldown--;
    if (attackHit && player.attackCooldown <= 0) {
      player.attackTime = ATTACK_FRAMES;
      player.attackCooldown = ATTACK_CD;
      player.attackHitIds.clear();
    }
    if (player.attackTime > 0) player.attackTime--;

    // sword hitbox — active during the first ~70% of the swing
    if (player.attackTime > ATTACK_FRAMES * 0.3) {
      const reach = 26;
      const hb = {
        x: player.facing > 0 ? player.x + player.w - 2 : player.x - reach + 2,
        y: player.y - 2,
        w: reach,
        h: player.h + 4,
      };
      for (const e of enemies) {
        if (e.dead || player.attackHitIds.has(e.id)) continue;
        if (rectsOverlap(hb, e)) {
          player.attackHitIds.add(e.id);
          e.hp--;
          e.hitFlash = 8;
          e.knockTime = 10;
          e.vx = player.facing * 5.5;
          e.vy = -3.5;
          hitstop = 4;
          shake = Math.max(shake, 5);
          // sword-recoil: a tiny pop back for the player feels great
          player.vx -= player.facing * 1.2;
          spawnParticles(e.x + e.w / 2, e.y + e.h / 2, 10, {
            spread: 3, color: '#ffd9a0', life: 22, gravity: 0.05,
          });
          if (e.hp <= 0) {
            e.dead = true;
            hitstop = 7;
            shake = Math.max(shake, 8);
            spawnParticles(e.x + e.w / 2, e.y + e.h / 2, 28, {
              spread: 4, color: '#9fc7ff', life: 50, gravity: -0.02, up: 1,
            });
            spawnParticles(e.x + e.w / 2, e.y + e.h / 2, 14, {
              spread: 5, color: '#1a2138', life: 30, gravity: 0.2,
            });
          }
        }
      }
    }

    // move and collide
    player.wasOnGround = player.onGround;
    moveAndCollide(player, player.vx, 0);
    moveAndCollide(player, 0, player.vy);

    // ----- enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead) { enemies.splice(i, 1); continue; }
      if (e.hitFlash > 0) e.hitFlash--;
      if (e.knockTime > 0) e.knockTime--;

      const dx = (player.x + player.w / 2) - (e.x + e.w / 2);
      const dy = (player.y + player.h / 2) - (e.y + e.h / 2);

      if (e.type === 'husk') {
        const near = Math.abs(dx) < 220 && Math.abs(dy) < 60;
        e.aggro = near ? Math.min(60, e.aggro + 1) : Math.max(0, e.aggro - 1);
        if (e.knockTime <= 0) {
          const want = e.aggro > 20 ? Math.sign(dx) : e.facing;
          e.facing = want || e.facing;
          const probe = { x: e.x + (e.facing > 0 ? e.w : -1), y: e.y + 2, w: 1, h: e.h };
          const wallAhead = solids.some(s => rectsOverlap(probe, s));
          const footProbe = { x: e.x + (e.facing > 0 ? e.w + 1 : -2), y: e.y + e.h + 1, w: 1, h: 2 };
          const groundAhead = solids.some(s => rectsOverlap(footProbe, s));
          if (wallAhead || (!groundAhead && e.onGround && e.aggro < 30)) {
            e.facing *= -1; e.vx = 0;
          } else {
            e.vx = e.facing * (e.aggro > 20 ? 1.4 : 0.7);
          }
        } else {
          e.vx *= 0.9;
        }
      } else if (e.type === 'war') {
        updateWar(e, dx);
      }

      e.vy += GRAVITY;
      if (e.vy > MAX_FALL) e.vy = MAX_FALL;
      moveAndCollide(e, e.vx, 0);
      moveAndCollide(e, 0, e.vy);

      // contact damage to player (skip while War is winding up — sword does the damage)
      const harmless = e.type === 'war' && (e.state === 'windup' || e.state === 'recover');
      if (!harmless && player.invuln <= 0 && rectsOverlap(player, e)) {
        damagePlayer(e);
      }

      // war sword hitbox
      if (e.type === 'war' && e.state === 'swing' && !e.swingHit) {
        const hb = warSwordHitbox(e);
        if (rectsOverlap(player, hb) && player.invuln <= 0) {
          e.swingHit = true;
          damagePlayer(e, 2); // big sword hurts more
        }
      }
    }

    if (player.invuln > 0) player.invuln--;
    if (player.hurtFlash > 0) player.hurtFlash--;

    // trail fade
    for (const t of player.trail) t.life--;
    while (player.trail.length && player.trail[0].life <= 0) player.trail.shift();

    // particles
    for (const p of particles) {
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
    }
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);

    // soul motes (ambient drifting glow)
    if (Math.random() < 0.25) {
      particles.push({
        x: Math.random() * W, y: H + 10,
        vx: (Math.random() - 0.5) * 0.3, vy: -0.3 - Math.random() * 0.4,
        life: 200, maxLife: 200,
        color: '#9fc7ff', size: 1.2, gravity: 0,
      });
    }

    // shake decay
    shake *= 0.85;
    if (shake < 0.1) shake = 0;

    // out-of-bounds rescue
    if (player.y > H + 60) {
      player.x = 60; player.y = 460; player.vx = 0; player.vy = 0;
      shake = Math.max(shake, 8);
    }

    pressed.clear();
  }

  // ---------- draw ----------
  function drawBackground() {
    // sky gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0d1a');
    g.addColorStop(0.55, '#101a2c');
    g.addColorStop(1, '#1a2138');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars
    for (const s of stars) {
      s.tw += 0.02;
      ctx.globalAlpha = 0.4 + Math.sin(s.tw) * 0.3;
      ctx.fillStyle = '#cfe0ff';
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // distant warm rim — suggests deeper underworld glow below
    const rim = ctx.createRadialGradient(W / 2, H + 100, 50, W / 2, H + 100, 500);
    rim.addColorStop(0, 'rgba(255, 170, 80, 0.18)');
    rim.addColorStop(1, 'rgba(255, 170, 80, 0)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, W, H);

    // silhouette layers
    const colors = ['#0d1424', '#0a1020', '#070b18'];
    for (let i = 0; i < bgLayers.length; i++) {
      const layer = bgLayers[i];
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (const p of layer.pts) ctx.lineTo(p.x, p.y + Math.sin(time * 0.005 + p.x * 0.01) * (2 - i));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }

    // mist puffs
    for (const m of mist) {
      m.x += m.s * 0.15;
      if (m.x - m.r > W) m.x = -m.r;
      const grd = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r);
      grd.addColorStop(0, 'rgba(140, 180, 230, 0.05)');
      grd.addColorStop(1, 'rgba(140, 180, 230, 0)');
      ctx.fillStyle = grd;
      ctx.fillRect(m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
    }
  }

  function drawSolids() {
    for (const s of solids) {
      // silhouette body
      ctx.fillStyle = '#05070d';
      ctx.fillRect(s.x, s.y, s.w, s.h);
      // top rim light
      ctx.fillStyle = 'rgba(180, 210, 255, 0.18)';
      ctx.fillRect(s.x, s.y, s.w, 1);
      // bottom under-glow only on platforms (not the walls)
      if (s.h <= 24 && s.w > 30 && s.y < H - 30) {
        ctx.fillStyle = 'rgba(255, 180, 100, 0.06)';
        ctx.fillRect(s.x, s.y + s.h, s.w, 6);
      }
    }
  }

  function drawPlayer() {
    // dash trail
    for (const t of player.trail) {
      const a = t.life / t.max;
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = '#cfe0ff';
      ctx.fillRect(t.x, t.y, player.w, player.h);
    }
    ctx.globalAlpha = 1;

    // invuln flicker: skip drawing every other few frames
    if (player.invuln > 0 && Math.floor(player.invuln / 4) % 2 === 0) return;

    const px = Math.round(player.x);
    const py = Math.round(player.y);
    const cx = px + player.w / 2;
    const cy = py + player.h / 2;

    // outer glow halo (the angel's lingering light)
    const halo = ctx.createRadialGradient(cx, cy, 4, cx, cy, 36);
    halo.addColorStop(0, 'rgba(220, 230, 255, 0.35)');
    halo.addColorStop(1, 'rgba(220, 230, 255, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - 40, cy - 40, 80, 80);

    // cloak silhouette (slightly larger than body)
    ctx.fillStyle = '#0c0f1a';
    ctx.fillRect(px - 2, py + 4, player.w + 4, player.h - 2);

    // body
    ctx.fillStyle = player.hurtFlash > 0 ? '#ffb7b7' : '#dfe7f5';
    ctx.fillRect(px + 3, py + 2, player.w - 6, player.h - 4);

    // hood shadow over upper head
    ctx.fillStyle = '#0c0f1a';
    ctx.fillRect(px + 1, py, player.w - 2, 7);

    // single glowing eye
    ctx.fillStyle = '#ffe9a8';
    const eyeX = player.facing > 0 ? px + player.w - 6 : px + 4;
    ctx.fillRect(eyeX, py + 3, 2, 2);

    // tiny broken halo above head
    ctx.strokeStyle = 'rgba(255, 220, 140, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, py - 2, 5, Math.PI * 0.15, Math.PI * 0.85, false);
    ctx.stroke();

    // tiny sword on hip when idle
    if (player.attackTime <= 0) {
      ctx.fillStyle = '#b8c6dc';
      const sx = player.facing > 0 ? px + player.w - 1 : px - 2;
      ctx.fillRect(sx, py + 14, 3, 6);
    }

    // sword swing arc
    if (player.attackTime > 0) {
      const t = 1 - player.attackTime / ATTACK_FRAMES;
      // sweep from upper-front down to lower-front
      const sweep = Math.PI * 0.9;
      const baseAng = player.facing > 0 ? -sweep / 2 : Math.PI - sweep / 2;
      const ang = player.facing > 0 ? baseAng + t * sweep : baseAng + (1 - t) * sweep;
      const len = 22;
      const bx = cx + Math.cos(ang) * 6;
      const by = cy + Math.sin(ang) * 6;
      const tx = cx + Math.cos(ang) * len;
      const ty = cy + Math.sin(ang) * len;

      // arc smear (trail behind current angle)
      ctx.strokeStyle = 'rgba(255, 240, 200, 0.45)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const trailStart = player.facing > 0 ? ang - 0.7 : ang + 0.05;
      const trailEnd = player.facing > 0 ? ang + 0.05 : ang + 0.7;
      ctx.arc(cx, cy, len - 4, trailStart, trailEnd);
      ctx.stroke();

      // blade
      ctx.strokeStyle = '#fff8d8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // hilt
      ctx.fillStyle = '#9a86c6';
      ctx.fillRect(bx - 1, by - 1, 3, 3);
    }
  }

  function drawEnemies() {
    for (const e of enemies) {
      if (e.type === 'war') drawWar(e);
      else drawHusk(e);
    }
  }

  function drawHusk(e) {
    const ex = Math.round(e.x);
    const ey = Math.round(e.y);
    const cx = ex + e.w / 2;
    const cy = ey + e.h / 2;

    const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, 30);
    glow.addColorStop(0, 'rgba(180, 80, 100, 0.18)');
    glow.addColorStop(1, 'rgba(180, 80, 100, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 32, cy - 32, 64, 64);

    ctx.save();
    ctx.translate(cx, ey + e.h);
    if (e.knockTime > 0) ctx.rotate(-e.facing * 0.15);
    ctx.fillStyle = e.hitFlash > 0 ? '#ffffff' : '#0a0d18';
    ctx.fillRect(-e.w / 2, -e.h, e.w, e.h);
    ctx.fillRect(-e.w / 2 - 2, -4, e.w + 4, 4);

    if (e.hitFlash <= 0) {
      ctx.fillStyle = '#ff9b6e';
      const eyeY = -e.h + 8;
      const off = e.facing > 0 ? 1 : -1;
      ctx.fillRect(-3 + off, eyeY, 2, 2);
      ctx.fillRect(2 + off, eyeY, 2, 2);
    }
    ctx.restore();

    if (e.hp < e.maxHp) {
      for (let i = 0; i < e.maxHp; i++) {
        ctx.fillStyle = i < e.hp ? '#e9d9a8' : 'rgba(255,255,255,0.15)';
        ctx.fillRect(ex + i * 5, ey - 6, 3, 2);
      }
    }
  }

  function drawWar(e) {
    const ex = Math.round(e.x);
    const ey = Math.round(e.y);
    const cx = ex + e.w / 2;
    const cy = ey + e.h / 2;

    // crimson under-glow
    const glow = ctx.createRadialGradient(cx, cy, 6, cx, cy, 90);
    glow.addColorStop(0, 'rgba(220, 60, 60, 0.28)');
    glow.addColorStop(1, 'rgba(220, 60, 60, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 90, cy - 90, 180, 180);

    const flash = e.hitFlash > 0;

    // body silhouette (cape silhouette behind, body in front)
    ctx.save();
    ctx.translate(cx, ey + e.h);
    if (e.knockTime > 0) ctx.rotate(-e.facing * 0.08);

    // tattered cape
    ctx.fillStyle = flash ? '#ffffff' : '#1a0608';
    ctx.beginPath();
    const capeSide = -e.facing;
    ctx.moveTo(capeSide * (e.w / 2 - 4), -e.h + 14);
    ctx.lineTo(capeSide * (e.w / 2 + 14), -e.h / 2 + 6);
    ctx.lineTo(capeSide * (e.w / 2 + 10), -4);
    ctx.lineTo(capeSide * 2, -4);
    ctx.lineTo(capeSide * 2, -e.h + 18);
    ctx.closePath();
    ctx.fill();

    // body block
    ctx.fillStyle = flash ? '#ffffff' : '#0c0610';
    ctx.fillRect(-e.w / 2, -e.h, e.w, e.h);

    // armor plates (subtle band highlights)
    if (!flash) {
      ctx.fillStyle = '#3a0d12';
      ctx.fillRect(-e.w / 2 + 2, -e.h + 22, e.w - 4, 3);  // chest band
      ctx.fillRect(-e.w / 2 + 2, -e.h + 36, e.w - 4, 3);  // waist band
      ctx.fillStyle = '#1c0408';
      ctx.fillRect(-e.w / 2 - 3, -4, e.w + 6, 5);         // ragged hem

      // helmet
      ctx.fillStyle = '#150307';
      ctx.fillRect(-e.w / 2 + 3, -e.h, e.w - 6, 14);
      // horns
      ctx.beginPath();
      ctx.moveTo(-e.w / 2 + 3, -e.h);
      ctx.lineTo(-e.w / 2 - 3, -e.h - 8);
      ctx.lineTo(-e.w / 2 + 7, -e.h - 2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(e.w / 2 - 3, -e.h);
      ctx.lineTo(e.w / 2 + 3, -e.h - 8);
      ctx.lineTo(e.w / 2 - 7, -e.h - 2);
      ctx.closePath();
      ctx.fill();

      // burning eye-slit
      ctx.fillStyle = '#ff5a3a';
      ctx.fillRect(-e.w / 2 + 8, -e.h + 6, e.w - 16, 2);
      // small inner glow point that tracks player
      ctx.fillStyle = '#ffd0a8';
      const off = e.facing > 0 ? 2 : -2;
      ctx.fillRect(off, -e.h + 6, 4, 2);
    }
    ctx.restore();

    // ----- BIG SWORD -----
    // Sword pivots from War's hand at shoulder height; pose depends on state.
    const handX = cx + e.facing * (e.w / 2 - 4);
    const handY = ey + 22;
    let bladeAng;
    if (e.state === 'windup') {
      // raise over head — interpolate from rest to overhead
      const t = Math.min(1, e.stateTime / 32);
      const rest = e.facing > 0 ? Math.PI * 0.35 : Math.PI - Math.PI * 0.35;
      const over = e.facing > 0 ? -Math.PI * 0.75 : Math.PI + Math.PI * 0.75;
      bladeAng = rest + (over - rest) * easeOut(t);
    } else if (e.state === 'swing') {
      // sweep down across the front
      const t = Math.min(1, e.stateTime / 16);
      const over = e.facing > 0 ? -Math.PI * 0.75 : Math.PI + Math.PI * 0.75;
      const down = e.facing > 0 ? Math.PI * 0.45 : Math.PI - Math.PI * 0.45;
      bladeAng = over + (down - over) * easeIn(t);
    } else if (e.state === 'charge') {
      // sword leveled out front
      bladeAng = e.facing > 0 ? 0 : Math.PI;
    } else if (e.state === 'recover') {
      const rest = e.facing > 0 ? Math.PI * 0.45 : Math.PI - Math.PI * 0.45;
      bladeAng = rest;
    } else {
      // idle resting pose: blade pointed down-and-forward
      bladeAng = e.facing > 0 ? Math.PI * 0.35 : Math.PI - Math.PI * 0.35;
    }

    const bladeLen = 70;
    const bladeWidth = 8;
    const tipX = handX + Math.cos(bladeAng) * bladeLen;
    const tipY = handY + Math.sin(bladeAng) * bladeLen;

    // swing motion blur trail
    if (e.state === 'swing') {
      ctx.strokeStyle = 'rgba(255, 180, 120, 0.35)';
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const over = e.facing > 0 ? -Math.PI * 0.75 : Math.PI + Math.PI * 0.75;
      ctx.arc(handX, handY, bladeLen - 8,
        Math.min(over, bladeAng), Math.max(over, bladeAng));
      ctx.stroke();
    }

    // windup tell: faint glow on the blade while raising
    if (e.state === 'windup') {
      ctx.strokeStyle = 'rgba(255, 90, 60, 0.45)';
      ctx.lineWidth = bladeWidth + 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(handX, handY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }

    // blade
    ctx.strokeStyle = '#c9cfdc';
    ctx.lineWidth = bladeWidth;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(handX + Math.cos(bladeAng) * 6, handY + Math.sin(bladeAng) * 6);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // edge highlight
    ctx.strokeStyle = '#f4f6fc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(handX + Math.cos(bladeAng) * 8, handY + Math.sin(bladeAng) * 8);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // crossguard
    const guardAng = bladeAng + Math.PI / 2;
    ctx.strokeStyle = '#5a1418';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(handX + Math.cos(guardAng) * 8, handY + Math.sin(guardAng) * 8);
    ctx.lineTo(handX - Math.cos(guardAng) * 8, handY - Math.sin(guardAng) * 8);
    ctx.stroke();

    // hilt
    ctx.fillStyle = '#2a0a0d';
    ctx.fillRect(handX - 3, handY - 3, 6, 6);
  }

  function easeIn(t) { return t * t; }
  function easeOut(t) { return 1 - (1 - t) * (1 - t); }

  function drawBossBar() {
    const boss = enemies.find(e => e.isBoss);
    if (!boss) return;
    const barW = 360, barH = 6;
    const x = (W - barW) / 2;
    const y = H - 28;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 2, y - 2, barW + 4, barH + 4);
    ctx.fillStyle = '#2a0a0d';
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = '#d44245';
    ctx.fillRect(x, y, barW * (boss.hp / boss.maxHp), barH);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x, y, barW * (boss.hp / boss.maxHp), 1);

    ctx.fillStyle = '#cfd7e6';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WAR', W / 2, y - 6);
    ctx.textAlign = 'left';
  }

  function drawHUD() {
    // little mask icons in the upper-right
    const baseX = W - 20;
    const baseY = 20;
    for (let i = 0; i < player.maxHp; i++) {
      const x = baseX - (i + 1) * 16;
      const filled = i < player.hp;
      ctx.fillStyle = filled ? '#e9d9a8' : 'rgba(180, 180, 200, 0.18)';
      // simple mask shape: rounded rect-ish
      ctx.fillRect(x, baseY, 10, 12);
      ctx.fillRect(x + 1, baseY - 1, 8, 1);
      ctx.fillRect(x + 1, baseY + 12, 8, 1);
      if (filled) {
        ctx.fillStyle = '#fff6d2';
        ctx.fillRect(x + 2, baseY + 2, 2, 2);
      }
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawVignette() {
    const v = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 560);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  function render() {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    drawBackground();
    drawSolids();
    drawParticles();
    drawEnemies();
    drawPlayer();
    drawVignette();
    ctx.restore();
    drawHUD();
    drawBossBar();
  }

  // ---------- main loop ----------
  function frame() {
    update();
    render();
    requestAnimationFrame(frame);
  }
  // initial room load (honors URL hash, e.g. #boss)
  loadRoom(location.hash.replace('#', '') || 'playground');
  requestAnimationFrame(frame);
})();

case 'player_left': {
        const p = otherPlayers[msg.id];
        const name = p?.username ?? msg.id;
        if (!localPlayer || msg.id !== localPlayer.id) pushChat(`${name} has left DragonSpires.`);
        delete otherPlayers[msg.id];
        break;
      }
      case 'chat':
        if (typeof msg.text === 'string') pushChat(msg.text);
        break;
      case 'chat_error':
        pushChat('~ The game has rejected your message due to bad language.');
        break;
      case 'stats_update': {
        const apply = (obj) => {
          if (!obj) return;
          if ('stamina' in msg) obj.stamina = msg.stamina;
          if ('life' in msg) obj.life = msg.life;
          if ('magic' in msg) obj.magic = msg.magic;
        };
        if (localPlayer && msg.id === localPlayer.id) apply(localPlayer);
        else if (otherPlayers[msg.id]) apply(otherPlayers[msg.id]);
        break;
      }
      case 'login_error':
      case 'signup_error':
        pushChat(msg.message || 'Auth error');
        break;
      default: break;
    }
  }

  // ---------- INPUT ----------
  window.addEventListener('keydown', (e) => {
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    // Toggle / submit chat
    if (e.key === 'Enter' && loggedIn) {
      if (!chatMode) { chatMode = true; typingBuffer = ""; }
      else {
        const toSend = typingBuffer.trim();
        if (toSend === '-pos' && localPlayer) {
          pushChat(`~ ${localPlayer.username} is currently on Map ${localPlayer.map_id ?? 1} at location x:${localPlayer.pos_x}, y:${localPlayer.pos_y}.`);
        } else if (toSend.length > 0) {
          send({ type: 'chat', text: toSend.slice(0, CHAT_INPUT.maxLen) });
        }
        typingBuffer = ""; chatMode = false;
      }
      e.preventDefault(); return;
    }

    // Capture chat text
    if (chatMode) {
      if (e.key === 'Backspace') { typingBuffer = typingBuffer.slice(0, -1); e.preventDefault(); }
      else if (e.key.length === 1 && typingBuffer.length < CHAT_INPUT.maxLen) typingBuffer += e.key;
      return;
    }

    // Login GUI typing
    if (!loggedIn && showLoginGUI && activeField) {
      if (e.key === 'Tab') {
        // Switch between username and password fields
        e.preventDefault();
        activeField = (activeField === 'username') ? 'password' : 'username';
        return;
      } else if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else passwordStr = passwordStr.slice(0, -1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        send({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault();
      } else if (e.key.length === 1) {
        if (activeField === 'username') usernameStr += e.key;
        else passwordStr += e.key;
      }
      return;
    }

    // Look command with 'l' key - look in the direction player is facing
    if (loggedIn && localPlayer && e.key === 'l') {
      e.preventDefault();
      
      // Calculate position in front of player based on direction
      let lookX = localPlayer.pos_x;
      let lookY = localPlayer.pos_y;
      
      switch (playerDirection) {
        case 'up': lookY -= 1; break;
        case 'down': lookY += 1; break;
        case 'left': lookX -= 1; break;
        case 'right': lookX += 1; break;
      }
      
      // Make sure we're looking within map bounds
      if (lookX >= 0 && lookX < mapSpec.width && lookY >= 0 && lookY < mapSpec.height) {
        const itemId = getItemAtPosition(lookX, lookY);
        const itemDetails = getItemDetails(itemId);
        
        if (itemDetails && itemDetails.description && itemDetails.description.trim()) {
          pushChat(`~ ${itemDetails.description}`);
        } else {
          pushChat("~ You see nothing.");
        }
      } else {
        pushChat("~ You see nothing.");
      }
      
      return;
    }

    // Pick up item with 'g' key
    if (loggedIn && localPlayer && e.key === 'g') {
      e.preventDefault();
      
      const itemId = getItemAtPosition(localPlayer.pos_x, localPlayer.pos_y);
      const itemDetails = getItemDetails(itemId);
      
      // Case 1: There's a pickupable item on the ground
      if (itemDetails && isItemPickupable(itemDetails)) {
        send({
          type: 'pickup_item',
          x: localPlayer.pos_x,
          y: localPlayer.pos_y,
          itemId: itemId
        });
      }
      // Case 2: No item on ground but player has something in hands - drop it
      else if ((!itemDetails || !isItemPickupable(itemDetails)) && localPlayer.hands && localPlayer.hands > 0) {
        send({
          type: 'pickup_item',
          x: localPlayer.pos_x,
          y: localPlayer.pos_y,
          itemId: 0 // 0 indicates dropping/no item on ground
        });
      }
      
      return;
    }

    // Equip weapon with 't' key
    if (loggedIn && localPlayer && e.key === 't') {
      e.preventDefault();
      
      // Always send the command - server will handle the logic
      send({
        type: 'equip_weapon'
      });
      
      return;
    }

    // Equip armor with 'y' key
    if (loggedIn && localPlayer && e.key === 'y') {
      e.preventDefault();
      
      // Always send the command - server will handle the logic
      send({
        type: 'equip_armor'
      });
      
      return;
    }

    // Rotation with '0' key - rotate in place without movement
    if (loggedIn && localPlayer && e.key === '0') {
      e.preventDefault();
      
      // Cancel any attack animation
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
        localAttackTimeout = null;
      }
      
      // Cycle through directions: right -> down -> left -> up -> right...
      const directions = ['right', 'down', 'left', 'up'];
      const currentIndex = directions.indexOf(playerDirection);
      const nextIndex = (currentIndex + 1) % directions.length;
      playerDirection = directions[nextIndex];
      
      // Reset to standing animation
      movementAnimationState = 0;
      isLocallyAttacking = false;
      
      // Update local player object for server sync
      localPlayer.direction = playerDirection;
      localPlayer.isAttacking = false;
      localPlayer.isMoving = false;
      
      // Send rotation to server
      send({
        type: 'rotate',
        direction: playerDirection
      });
      
      return;
    }

    // Attack input - NEW SYSTEM
    if (loggedIn && localPlayer && e.key === 'Tab') {
      e.preventDefault();
      
      // Start local attack state
      isLocallyAttacking = true;
      localAttackState = (localAttackState + 1) % 2; // Alternate between 0 and 1
      
      // Set timeout to stop attack after 1 second
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
      }
      
      localAttackTimeout = setTimeout(() => {
        isLocallyAttacking = false;
        movementAnimationState = 0; // Reset to standing
        localAttackTimeout = null;
      }, 1000);
      
      // Send attack to server
      send({ 
        type: 'attack',
        direction: playerDirection
      });
      
      return;
    }

    // Movement - NEW SYSTEM with direction and animation state
    if (loggedIn && localPlayer) {
      if ((localPlayer.stamina ?? 0) <= 0) return;
      
      // Prevent rapid movement (minimum 100ms between moves)
      const currentTime = Date.now();
      if (currentTime - lastMoveTime < 100) return;
      
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0, newDirection = null;
      
      if (k === 'arrowup' || k === 'w') { dy = -1; newDirection = 'up'; }
      else if (k === 'arrowdown' || k === 's') { dy = 1; newDirection = 'down'; }
      else if (k === 'arrowleft' || k === 'a') { dx = -1; newDirection = 'left'; }
      else if (k === 'arrowright' || k === 'd') { dx = 1; newDirection = 'right'; }
      
      if (dx || dy) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        
        // Use the new collision checking function
        if (canMoveTo(nx, ny, localPlayer.id)) {
          // CANCEL ATTACK ANIMATION IMMEDIATELY ON MOVEMENT
          if (localAttackTimeout) {
            clearTimeout(localAttackTimeout);
            localAttackTimeout = null;
          }
          isLocallyAttacking = false;
          
          // UPDATE DIRECTION AND ANIMATION STATE
          playerDirection = newDirection;
          // Increment animation state: 0->1->2->0->1->2...
          movementAnimationState = (movementAnimationState + 1) % 3;
          
          // IMMEDIATELY UPDATE LOCAL PLAYER OBJECT
          localPlayer.direction = playerDirection;
          localPlayer.pos_x = nx;
          localPlayer.pos_y = ny;
          localPlayer.isAttacking = false;
          localPlayer.isMoving = true;
          
          // Update last move time
          lastMoveTime = currentTime;
          
          // Send the move command to server
          send({ 
            type: 'move', 
            dx, 
            dy, 
            direction: playerDirection
          });
          
          // Stop moving after a brief moment and reset to standing
          setTimeout(() => {
            if (localPlayer) {
              localPlayer.isMoving = false;
              movementAnimationState = 0; // Reset to standing after movement
            }
          }, 200);
        } else {
          // Can't move but still update direction and animation for visual feedback
          playerDirection = newDirection;
          movementAnimationState = (movementAnimationState + 1) % 3;
          lastMoveTime = currentTime; // Still update move time to prevent rapid inputs
        }
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (chatMode) return;

    if (connected && showLoginGUI && !loggedIn) {
      const u = GUI.username, p = GUI.password, lb = GUI.loginBtn, sb = GUI.signupBtn;
      const uTop = FIELD_TOP(u.y), uBottom = uTop + u.h;
      const pTop = FIELD_TOP(p.y), pBottom = pTop + p.h;

      if (mx >= u.x && mx <= u.x + u.w && my >= uTop && my <= uBottom) { activeField = 'username'; return; }
      else if (mx >= p.x && mx <= p.x + p.w && my >= pTop && my <= pBottom) { activeField = 'password'; return; }
      else if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
      else if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) { send({ type: 'signup', username: usernameStr, password: passwordStr }); return; }
      activeField = null;
    }
  });

  // ---------- RENDER HELPERS ----------
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    const base = isoBase(x, y);
    const camBase = localPlayer ? isoBase(localPlayer.pos_x, localPlayer.pos_y)
                                : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));
    let screenX = PLAYER_SCREEN_X - TILE_W/2 + (base.x - camBase.x);
    let screenY = PLAYER_SCREEN_Y - TILE_H/2 + (base.y - camBase.y);
    screenX += WORLD_SHIFT_X + CENTER_LOC_ADJ_X + CENTER_LOC_FINE_X;
    screenY += WORLD_SHIFT_Y + CENTER_LOC_ADJ_Y + CENTER_LOC_FINE_Y;
    return { screenX, screenY };
  }

  function drawTile(sx, sy, t) {
    // Use extracted tile if available; position 62x32 properly in 64x32 diamond
    if (t > 0 && floorTiles[t]) {
      // Center the 62x32 tile in the 64x32 space
      ctx.drawImage(floorTiles[t], sx + 1, sy, 62, 32);
    } else {
      // fallback diamond
      ctx.beginPath();
      ctx.moveTo(sx, sy + TILE_H/2);
      ctx.lineTo(sx + TILE_W/2, sy);
      ctx.lineTo(sx + TILE_W, sy + TILE_H/2);
      ctx.lineTo(sx + TILE_W/2, sy + TILE_H);
      ctx.closePath();
      ctx.fillStyle = '#8DBF63';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
  }

function drawItemAtTile(sx, sy, itemIndex) {
  if (!window.getItemMeta || !window.itemsReady()) return;
  const meta = window.getItemMeta(itemIndex);
  if (!meta) return;

  const { img, w, h } = meta;
  if (!img || !img.complete) return;

  // BOTTOM-RIGHT ALIGNMENT with dynamic offset for smaller items
  // Base position: bottom-right alignment to tile rectangle
  let drawX = (sx + TILE_W) - w;  // Right-align to tile right edge
  let drawY = (sy + TILE_H) - h;  // Bottom-align to tile bottom edge
  
  // Apply dynamic offset for items smaller than tile dimensions
  if (w < 62) {
    const offsetX = w - 62; // This will be negative (e.g., 40 - 62 = -22)
    drawX += offsetX;
  }
  
  if (h < 32) {
    const offsetY = h - 32; // This will be negative (e.g., 21 - 32 = -11)
    drawY += offsetY;
  }

  ctx.drawImage(img, drawX, drawY);
}

  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    
    // Name centered, adjusted x:-2, y:-14 from previous baseline
    const nameX = screenX + TILE_W / 2 - 2;
    const nameY = screenY - 34; // (-20 - 14)
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nameX, nameY);
    ctx.lineWidth = 1;

    // NEW: Calculate animation frame based on direction + state system
    let animFrame;
    
    if (isLocal) {
      // Use local state variables for immediate feedback
      if (isLocallyAttacking) {
        // Attack animation based on direction + attack state
        const attackSeq = ATTACK_SEQUENCES[playerDirection] || ATTACK_SEQUENCES.down;
        animFrame = attackSeq[localAttackState];
      } else {
        // Movement animation based on direction + movement state
        if (movementAnimationState === 0) {
          // Standing
          animFrame = DIRECTION_IDLE[playerDirection] || DIRECTION_IDLE.down;
        } else {
          // Walking (walk_1 or walk_2)
          const walkIndex = movementAnimationState === 1 ? 0 : 2; // 1->walk_1(0), 2->walk_2(2)
          const directionOffsets = { down: 0, right: 5, left: 10, up: 15 };
          animFrame = (directionOffsets[playerDirection] || 0) + walkIndex;
        }
      }
    } else {
      // Use server state for other players
      animFrame = getCurrentAnimationFrame(p, false);
    }
    
    if (playerSpritesReady && playerSprites[animFrame] && playerSprites[animFrame].complete) {
      const sprite = playerSprites[animFrame];
      const meta = playerSpriteMeta[animFrame];
      
      if (sprite && meta) {
        // FIXED POSITIONING: Apply x:-7, y:-12 offset
        let spriteX = (screenX + TILE_W) - meta.w - 7;  // Additional -7 offset
        let spriteY = (screenY + TILE_H) - meta.h - 12; // Additional -12 offset
        
        // Apply dynamic offset for sprites smaller than tile dimensions
        if (meta.w < 62) {
          const offsetX = meta.w - 62; // This will be negative
          spriteX += offsetX;
        }
        
        if (meta.h < 32) {
          const offsetY = meta.h - 32; // This will be negative
          spriteY += offsetY;
        }
        
        ctx.drawImage(sprite, spriteX, spriteY, meta.w, meta.h);
      }
    } else {
      // Fallback rendering
      const drawX = screenX + PLAYER_OFFSET_X + SPRITE_CENTER_ADJ_X;
      const drawY = screenY + PLAYER_OFFSET_Y + SPRITE_CENTER_ADJ_Y;
      
      ctx.fillStyle = isLocal ? '#1E90FF' : '#FF6347';
      ctx.beginPath();
      ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawBarsAndStats() {
    if (!loggedIn || !localPlayer) return;
    const topY = 19, bottomY = 135, span = bottomY - topY;

    const sPct = Math.max(0, Math.min(1, (localPlayer.stamina ?? 0) / Math.max(1, (localPlayer.max_stamina ?? 1))));
    const sFillY = topY + (1 - sPct) * span;
    ctx.fillStyle = '#00ff00'; ctx.fillRect(187, sFillY, 13, bottomY - sFillY);

    const lPct = Math.max(0, Math.min(1, (localPlayer.life ?? 0) / Math.max(1, (localPlayer.max_life ?? 1))));
    const lFillY = topY + (1 - lPct) * span;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(211, lFillY, 13, bottomY - lFillY);

    const mx = 177, my = 247;
    const mCur = localPlayer.magic ?? 0, mMax = localPlayer.max_magic ?? 0;
    ctx.font = '14px monospace'; ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(`${mCur}/${mMax}`, mx, my);
    ctx.fillStyle = 'yellow'; ctx.fillText(`${mCur}/${mMax}`, mx, my);
    ctx.lineWidth = 1;

    const gold = localPlayer.gold ?? 0;
    ctx.font = '14px sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(String(gold), 177, 273);
    ctx.fillStyle = 'white'; ctx.fillText(String(gold), 177, 273);
    ctx.lineWidth = 1;
  }

  function drawChatHistory() {
    const { x1,y1,x2,y2,pad } = CHAT;
    const w = x2 - x1;
    ctx.font = '12px monospace'; ctx.fillStyle = '#000'; ctx.textAlign = 'left';
    const lineH = 16;
    let y = y2 - pad;
    for (let i = messages.length - 1; i >= 0; i--) {
      let line = messages[i];
      while (ctx.measureText(line).width > w - pad*2 && line.length > 1) line = line.slice(0, -1);
      ctx.fillText(line, x1 + pad, y);
      y -= lineH;
      if (y < y1 + pad) break;
    }
  }
  
  function drawChatInput() {
    if (!chatMode) return;
    const { x1, y1, x2, y2, pad, extraY } = CHAT_INPUT;
    const w = x2 - x1;
    ctx.font = '12px monospace'; ctx.fillStyle = '#000'; ctx.textAlign = 'left';
    const words = typingBuffer.split(/(\s+)/);
    let line = '', y = y1 + pad + extraY;
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i];
      if (ctx.measureText(test).width > w - pad*2) {
        ctx.fillText(line, x1 + pad, y);
        y += 16; line = words[i].trimStart();
        if (y > y2 - pad) break;
      } else line = test;
    }
    if (y <= y2 - pad && line.length) ctx.fillText(line, x1 + pad, y);
  }

  function drawItemOnBorder(itemId, x, y) {
    if (!window.getItemMeta || !window.itemsReady()) return;
    const meta = window.getItemMeta(itemId);
    if (!meta || !meta.img || !meta.img.complete) return;

    // Draw item on top of border at specified position
    ctx.drawImage(meta.img, x, y);
  }

  // ---------- SCENES ----------
  function drawConnecting() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!showLoginGUI) {
      if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
      else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
      ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
      if (connectionPaused) ctx.fillText('Press any key to enter!', 47, 347);
      else ctx.fillText('Connecting to server...', 47, 347);
    } else {
      ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
      ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
      if (!connected) ctx.fillText('Connecting to server...', 47, 347);
    }
  }

  function drawLogin() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // Auto-select username field if no field is selected
    if (activeField === null) {
      activeField = 'username';
    }

    // WHITE labels, nudged up by 2px to align
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);

    // Username
    const uTop = FIELD_TOP(GUI.username.y);
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr || '', GUI.username.x + 4, GUI.username.y + 2);

    // Password
    const pTop = FIELD_TOP(GUI.password.y);
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    // Buttons
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    drawChatHistory();
  }

  function drawGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    if (!localPlayer) return;

    // Map (only if ready)
    if (tilesReady && mapReady) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
          const { screenX, screenY } = isoScreen(x, y);
          drawTile(screenX, screenY, t);
        }
      }
    }

    // Build a quick lookup of players by tile
    const playersByTile = {};
    (function buildPlayersIndex() {
      if (localPlayer) {
        const k = `${localPlayer.pos_x},${localPlayer.pos_y}`;
        (playersByTile[k] ||= []).push({ ...localPlayer, __isLocal: true });
      }
      for (const id in otherPlayers) {
        const p = otherPlayers[id];
        const k = `${p.pos_x},${p.pos_y}`;
        (playersByTile[k] ||= []).push(p);
      }
    })();

    // Second pass: items + players in tile order (depth-safe with tall items)
    if (tilesReady && mapReady && window.itemsReady()) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const { screenX, screenY } = isoScreen(x, y);

          // Get the effective item at this position (handles map items, placed items, and pickups)
          const effectiveItemId = getItemAtPosition(x, y);
          
          // Only render if there's actually an item (> 0)
          if (effectiveItemId > 0) {
            drawItemAtTile(screenX, screenY, effectiveItemId);
          }

          // Players standing on this tile
          const k = `${x},${y}`;
          const arr = playersByTile[k];
          if (arr && arr.length) {
            for (const p of arr) drawPlayer(p, !!p.__isLocal);
          }
        }
      }
    }

    // Border
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

    // Stats on top
    drawBarsAndStats();

    // Chat
    drawChatHistory();
    drawChatInput();

    // Draw pickupable item at player's position on top of border
    if (localPlayer && itemDetailsReady) {
      const playerItemId = getItemAtPosition(localPlayer.pos_x, localPlayer.pos_y);
      const playerItemDetails = getItemDetails(playerItemId);
      
      if (playerItemDetails && isItemPickupable(playerItemDetails)) {
        drawItemOnBorder(playerItemId, 57, 431); // Ground item position
      }

      // Draw equipped items on border
      if (localPlayer.armor && localPlayer.armor > 0) {
        drawItemOnBorder(localPlayer.armor, 56, 341); // Armor position
      }
      
      if (localPlayer.weapon && localPlayer.weapon > 0) {
        drawItemOnBorder(localPlayer.weapon, 38, 296); // Weapon position
      }
      
      if (localPlayer.hands && localPlayer.hands > 0) {
        drawItemOnBorder(localPlayer.hands, 73, 296); // Hands position
      }
    }
  }

  // ---------- LOOP ----------
  function loop() {
    if (!connected) drawConnecting();
    else if (connected && connectionPaused) drawConnecting();
    else if (connected && !showLoginGUI) drawConnecting();
    else if (connected && showLoginGUI && !loggedIn) drawLogin();
    else if (connected && loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();

  // Click handler
  canvas.addEventListener('mousedown', () => {
    if (!connected) { connectToServer(); return; }
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; }
  });

  // Helper functions for item details
  function getItemDetails(itemId) {
    if (!itemDetailsReady || !itemDetails || itemId < 1 || itemId > itemDetails.length) {
      return null;
    }
    return itemDetails[itemId - 1]; // Convert to 0-based index
  }

  function getItemAtPosition(x, y) {
    // Check both map items (from JSON) and placed items (from admin/pickup)
    const mapItem = (mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined') 
      ? mapSpec.items[y][x] : 0;
    const placedItem = mapItems[`${x},${y}`];
    
    // If there's a placed item entry (including -1 for picked up), it ALWAYS overrides the map item
    if (placedItem !== undefined) {
      // If placedItem is -1, it means the original map item was picked up, return 0
      if (placedItem === -1) {
        return 0;
      }
      // If placedItem is 0, it means admin removed an item, return 0
      if (placedItem === 0) {
        return 0;
      }
      // Otherwise return the placed item (admin placed or original map item)
      return placedItem;
    }
    
    // No placed item entry exists, return the original map item
    return mapItem;
  }

  function isItemPickupable(itemDetails) {
    if (!itemDetails) return false;
    const pickupableTypes = ["weapon", "armor", "useable", "consumable", "buff", "garbage"];
    return pickupableTypes.includes(itemDetails.type);
  }

  // utils
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  window.connectToServer = connectToServer;

  // Load floor collision data
  fetch('/client/assets/floorcollision.json')
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.floor)) {
        floorCollision = data.floor;
        floorCollisionReady = true;
        console.log(`Client loaded floor collision data: ${floorCollision.length} tiles`);
      }
    })
    .catch(err => {
      // Try alternative path
      fetch('/assets/floorcollision.json')
        .then(r => r.json())
        .then(data => {
          if (data && Array.isArray(data.floor)) {
            floorCollision = data.floor;
            floorCollisionReady = true;
            console.log(`Client loaded floor collision data: ${floorCollision.length} tiles`);
          }
        })
        .catch(err2 => {
          floorCollisionReady = true; // Set to true anyway to not block the game
          console.warn('Failed to load floor collision data');
        });
    });

  // Load item details
  fetch('/assets/itemdetails.json')  // Changed path - try without /client/
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.items)) {
        itemDetails = data.items.map((item, index) => ({
          id: index + 1, // 1-based indexing to match item IDs
          name: item[0],
          collision: item[1] === "true",
          type: item[2],
          statMin: parseInt(item[3]) || 0,
          statMax: parseInt(item[4]) || 0,
          description: item[5]
        }));
        itemDetailsReady = true;
      }
    })
    .catch(err => {
      // Try alternative path
      fetch('/client/assets/itemdetails.json')
        .then(r => r.json())
        .then(data => {
          if (data && Array.isArray(data.items)) {
            itemDetails = data.items.map((item, index) => ({
              id: index + 1,
              name: item[0],
              collision: item[1] === "true",
              type: item[2],
              statMin: parseInt(item[3]) || 0,
              statMax: parseInt(item[4]) || 0,
              description: item[5]
            }));
            itemDetailsReady = true;
          }
        })
        .catch(err2 => {
          itemDetailsReady = true; // Set to true anyway to not block the game
        });
    });
});// client.js - Browser-side game client
document.addEventListener('DOMContentLoaded', () => {
  // ---------- CONFIG ----------
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS = "ws://localhost:3000";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Missing <canvas id="gameCanvas">'); return; }
  const ctx = canvas.getContext('2d');

  const CANVAS_W = 640, CANVAS_H = 480;
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  // Logical diamond for positioning
  const TILE_W = 64, TILE_H = 32;

  // Item fine-tuning (center on tile a bit better)
  const ITEM_X_NUDGE = 0;//3;   // +right
  const ITEM_Y_NUDGE = 0;//15;  // +up (we subtract this in draw)

  // Screen anchor for local tile
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // World/camera offsets (as previously tuned)
  const WORLD_SHIFT_X = -32, WORLD_SHIFT_Y = 16;
  const CENTER_LOC_ADJ_X = 32, CENTER_LOC_ADJ_Y = -8;
  const CENTER_LOC_FINE_X = -5, CENTER_LOC_FINE_Y = 0;

  // Sprite offsets (as tuned earlier)
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;
  const SPRITE_CENTER_ADJ_X = 23;  // = 64 - 41
  const SPRITE_CENTER_ADJ_Y = -20; // = -24 + 4

  // GUI (+50,+50)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const FIELD_H = 16;
  const FIELD_TOP = (y) => (y - 13);
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    loginBtn:  { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn: { x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat areas
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };
  const CHAT_INPUT = { x1: 156, y1: 411, x2: 618, y2: 453, pad: 8, maxLen: 200, extraY: 2 };

  // Animation constants
  const ANIMATION_NAMES = [
    'down_walk_1', 'down', 'down_walk_2', 'down_attack_1', 'down_attack_2',
    'right_walk_1', 'right', 'right_walk_2', 'right_attack_1', 'right_attack_2',
    'left_walk_1', 'left', 'left_walk_2', 'left_attack_1', 'left_attack_2',
    'up_walk_1', 'up', 'up_walk_2', 'up_attack_1', 'up_attack_2',
    'stand', 'sit'
  ];

  // Walk animation sequences (indices into ANIMATION_NAMES)
  const WALK_SEQUENCES = {
    down: [0, 1, 2, 1],   // down_walk_1, down, down_walk_2, down
    right: [5, 6, 7, 6],  // right_walk_1, right, right_walk_2, right
    left: [10, 11, 12, 11], // left_walk_1, left, left_walk_2, left
    up: [15, 16, 17, 16]    // up_walk_1, up, up_walk_2, up
  };

  // Attack animation pairs
  const ATTACK_SEQUENCES = {
    down: [3, 4],   // down_attack_1, down_attack_2
    right: [8, 9],  // right_attack_1, right_attack_2
    left: [13, 14], // left_attack_1, left_attack_2
    up: [18, 19]    // up_attack_1, up_attack_2
  };

  // Direction animations for idle state
  const DIRECTION_IDLE = {
    down: 1,   // down
    right: 6,  // right
    left: 11,  // left
    up: 16     // up
  };

  // Movement animation sequence: walk_1 -> walk_2 -> idle
  const MOVEMENT_SEQUENCE = ['walk_1', 'walk_2', 'idle'];

  // ---------- STATE ----------
  let ws = null;
  let connected = false;
  let connectionPaused = false;
  let showLoginGUI = false;
  let loggedIn = false;
  let chatMode = false;

  // Assets ready flags
  let tilesReady = false;
  let mapReady = false;
  let playerSpritesReady = false;
  let itemDetailsReady = false;
  let floorCollisionReady = false;

  // Map
  let mapSpec = { width: 64, height: 64, tiles: [] };
  let mapItems = {}; // { "x,y": itemId }

  // Item details
  let itemDetails = []; // Array of item detail objects

  // Floor collision data
  let floorCollision = []; // Array of collision data

  // Auth GUI
  let usernameStr = "";
  let passwordStr = "";
  let activeField = null;

  // Players
  let localPlayer = null;
  let otherPlayers = {};

  // NEW: Simplified direction and animation state system
  let playerDirection = 'down'; // Current facing direction
  let movementAnimationState = 0; // 0=standing, 1=walk_1, 2=walk_2
  let isLocallyAttacking = false; // Local attack state
  let localAttackState = 0; // 0 or 1 for attack_1 or attack_2
  let lastMoveTime = 0; // Prevent rapid movement through collision objects

  // Chat
  let messages = [];
  let typingBuffer = "";

  // Animation state - SIMPLIFIED ATTACK HANDLING
  let localAttackTimeout = null; // Track our own attack timeout

  // ---------- COLLISION HELPERS ----------
  function hasFloorCollision(x, y) {
    if (!floorCollisionReady || !floorCollision || 
        x < 0 || y < 0 || x >= mapSpec.width || y >= mapSpec.height) {
      return false; // No collision data or out of bounds
    }
    
    // Get the floor tile ID at this position
    const tileId = (mapSpec.tiles && mapSpec.tiles[y] && 
                    typeof mapSpec.tiles[y][x] !== 'undefined') 
                    ? mapSpec.tiles[y][x] : 0;
    
    // If no tile (ID 0) or tile ID is out of range, no collision
    if (tileId <= 0 || tileId > floorCollision.length) {
      return false;
    }
    
    // Look up collision for this tile ID (convert to 0-based index)
    return floorCollision[tileId - 1] === true || floorCollision[tileId - 1] === "true";
  }

  function isPlayerAtPosition(x, y, excludePlayerId = null) {
    // Check local player
    if (localPlayer && localPlayer.pos_x === x && localPlayer.pos_y === y) {
      if (!excludePlayerId || localPlayer.id !== excludePlayerId) {
        return true;
      }
    }
    
    // Check other players
    for (const id in otherPlayers) {
      const player = otherPlayers[id];
      if (player.pos_x === x && player.pos_y === y) {
        if (!excludePlayerId || player.id !== excludePlayerId) {
          return true;
        }
      }
    }
    
    return false;
  }

  function canMoveTo(x, y, excludePlayerId = null) {
    // Check map bounds
    if (x < 0 || x >= mapSpec.width || y < 0 || y >= mapSpec.height) {
      return false;
    }
    
    // Check floor collision
    if (hasFloorCollision(x, y)) {
      return false;
    }
    
    // Check item collision
    const targetItemId = getItemAtPosition(x, y);
    const targetItemDetails = getItemDetails(targetItemId);
    if (targetItemDetails && targetItemDetails.collision) {
      return false;
    }
    
    // Check player collision
    if (isPlayerAtPosition(x, y, excludePlayerId)) {
      return false;
    }
    
    return true;
  }

  // ---------- ASSETS ----------
  const imgTitle = new Image();
  imgTitle.src = "/assets/title.GIF";

  // Border: magenta keyed
  const imgBorder = new Image();
  imgBorder.src = "/assets/game_border_2025.gif";
  let borderProcessed = null;
  imgBorder.onload = () => {
    try {
      const w = imgBorder.width, h = imgBorder.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(imgBorder, 0, 0);
      const data = octx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
      borderProcessed = off;
    } catch {
      borderProcessed = null;
    }
  };

  // Player sprites: extract multiple animations from player.gif using player.json
  const imgPlayerSrc = new Image();
  imgPlayerSrc.src = "/assets/player.gif";
  let playerSprites = []; // Array of Image objects for each animation frame
  let playerSpriteMeta = []; // Array of {w, h} for each sprite

  Promise.all([
    new Promise(resolve => {
      if (imgPlayerSrc.complete) resolve();
      else { imgPlayerSrc.onload = resolve; imgPlayerSrc.onerror = resolve; }
    }),
    fetch('/assets/player.json').then(r => r.json()).catch(() => null)
  ]).then(([_, playerJson]) => {
    if (!playerJson || !playerJson.knight) {
      console.error('Failed to load player.json or knight data');
      playerSpritesReady = true;
      return;
    }

    const knightCoords = playerJson.knight;
    const loadPromises = [];

    knightCoords.forEach(([sx, sy, sw, sh], index) => {
      try {
        const off = document.createElement('canvas');
        off.width = sw;
        off.height = sh;
        const octx = off.getContext('2d');
        octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);

        // Make magenta transparent
        const data = octx.getImageData(0, 0, sw, sh);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
        }
        octx.putImageData(data, 0, 0);

        const sprite = new Image();
        const promise = new Promise(resolve => {
          sprite.onload = resolve;
          sprite.onerror = resolve;
        });
        sprite.src = off.toDataURL();
        
        playerSprites[index] = sprite;
        playerSpriteMeta[index] = { w: sw, h: sh };
        loadPromises.push(promise);
      } catch (e) {
        console.error(`Failed to process sprite ${index}:`, e);
      }
    });

    Promise.all(loadPromises).then(() => {
      playerSpritesReady = true;
    });
  });

  // Floor tiles from /assets/floor.png: 9 columns x 11 rows, each 62x32, with 1px overlapping border
  const imgFloor = new Image();
  imgFloor.src = "/assets/floor.png";
  let floorTiles = []; // 1-based indexing
  imgFloor.onload = async () => {
    try {
      const sheetW = imgFloor.width;
      const sheetH = imgFloor.height;
      const tileW = 62, tileH = 32;
      const cols = 9;   // 9 columns
      const rows = 11;  // 11 rows

      const off = document.createElement('canvas');
      off.width = sheetW; off.height = sheetH;
      const octx = off.getContext('2d');
      octx.drawImage(imgFloor, 0, 0);

      let idCounter = 1;
      const loadPromises = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          // Use the coordinate formula from your examples:
          // x = 1 + (col * 63), y = 1 + (row * 33)
          const sx = 1 + (col * 63);  // 63 = 62 + 1 pixel border
          const sy = 1 + (row * 33);  // 33 = 32 + 1 pixel border

          const tcan = document.createElement('canvas');
          tcan.width = tileW; tcan.height = tileH;
          const tctx = tcan.getContext('2d', { willReadFrequently: true });
          tctx.drawImage(off, sx, sy, tileW, tileH, 0, 0, tileW, tileH);

          // magenta -> transparent (if present in art)
          const imgData = tctx.getImageData(0, 0, tileW, tileH);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
          }
          tctx.putImageData(imgData, 0, 0);

          const tileImg = new Image();
          const p = new Promise((resolve) => { tileImg.onload = resolve; tileImg.onerror = resolve; });
          tileImg.src = tcan.toDataURL();
          floorTiles[idCounter] = tileImg;
          loadPromises.push(p);
          idCounter++;
        }
      }

      await Promise.all(loadPromises);
      tilesReady = true;

      fetch('map.json')
        .then(r => r.json())
        .then(m => {
          if (m && m.width && m.height) {
            const tiles = Array.isArray(m.tiles) ? m.tiles : (Array.isArray(m.tilemap) ? m.tilemap : null);
            mapSpec = {
              width: m.width,
              height: m.height,
              tiles: tiles || [],
              items: Array.isArray(m.items) ? m.items : []
            };
          }
        })
        .catch(() => {})
        .finally(() => { mapReady = true; });

    } catch (e) {
      console.error("Floor tile extraction failed:", e);
      tilesReady = true; mapReady = true; // fail-safe
    }
  };

// ---------- ITEMS (sheet + coords, true magenta keyed, formula-based anchoring) ----------
(() => {
  const imgItems = new Image();
  imgItems.src = "/assets/item.gif";

  const itemsJsonPromise = fetch("/assets/item.json")
    .then(r => r.json())
    .catch(() => null);

  const itemSprites = []; // 1-based
  const itemMeta = [];    // 1-based: { img, w, h, leftPad, anchorX }
  let itemsReady = false;

  function waitImage(img) {
    return new Promise((resolve) => {
      if (img.complete) return resolve();
      img.onload = resolve;
      img.onerror = resolve;
    });
  }

  Promise.all([waitImage(imgItems), itemsJsonPromise]).then(([_, meta]) => {
    if (!meta || !Array.isArray(meta.item_coords)) return;

    const off = document.createElement("canvas");
    const octx = off.getContext("2d");

    meta.item_coords.forEach((quad, idx) => {
      const [sx, sy, sw, sh] = quad;
      off.width = sw; off.height = sh;
      octx.clearRect(0, 0, sw, sh);
      octx.drawImage(imgItems, sx, sy, sw, sh, 0, 0, sw, sh);

      // Make true magenta transparent + compute leftPad (first opaque column)
      let leftPad = 0;
      try {
        // Set willReadFrequently for better performance
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = sw; tempCanvas.height = sh;
        const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
        tempCtx.drawImage(off, 0, 0);
        
        const data = tempCtx.getImageData(0, 0, sw, sh);
        const d = data.data;

        // magenta -> transparent
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
        }

        // find first opaque column from the left
        leftPad = sw; // default "none found"
        outer:
        for (let x = 0; x < sw; x++) {
          for (let y = 0; y < sh; y++) {
            const a = d[((y * sw) + x) * 4 + 3];
            if (a !== 0) { leftPad = x; break outer; }
          }
        }
        if (leftPad === sw) leftPad = 0; // all transparent (safety)

        tempCtx.putImageData(data, 0, 0);
        octx.clearRect(0, 0, sw, sh);
        octx.drawImage(tempCanvas, 0, 0);
      } catch {
        leftPad = 0; // fallback if canvas is tainted (shouldn't be here)
      }

      // Bottom-center anchor inside the sprite (relative to left edge)
      // Rightmost opaque column is at sw - 1 (bottom-right justified),
      // so center between leftPad and (sw - 1).
      const anchorX = (leftPad + (sw - 1)) / 2;

      // Freeze the processed pixels into an <img>
      const sprite = new Image();
      sprite.src = off.toDataURL();

      itemSprites[idx + 1] = sprite;
      itemMeta[idx + 1] = { img: sprite, w: sw, h: sh, leftPad, anchorX };
    });

    itemsReady = true;
  });

  // accessors
  window.getItemSprite = (i) => itemSprites[i] || null;
  window.getItemMeta   = (i) => itemMeta[i] || null;
  window.itemSpriteCount = () => itemSprites.length - 1;
  window.itemsReady = () => itemsReady;
})();

  // ---------- ANIMATION HELPERS ----------
  function getMovementAnimationFrame(direction, sequenceIndex) {
    const sequenceType = MOVEMENT_SEQUENCE[sequenceIndex];
    if (sequenceType === 'idle') {
      return DIRECTION_IDLE[direction] || DIRECTION_IDLE.down;
    } else {
      // walk_1 or walk_2
      const walkIndex = sequenceType === 'walk_1' ? 0 : 2;
      const directionOffsets = {
        down: 0,
        right: 5,
        left: 10,
        up: 15
      };
      return (directionOffsets[direction] || 0) + walkIndex;
    }
  }

  function getCurrentAnimationFrame(player, isLocal = false) {
    // For local player, use the server-provided state
    // For other players, use their server-provided state
    if (player.isAttacking) {
      return player.animationFrame || DIRECTION_IDLE[player.direction] || DIRECTION_IDLE.down;
    }

    // Use the player's animation frame (which is calculated based on movement sequence)
    if (typeof player.animationFrame !== 'undefined') {
      return player.animationFrame;
    }

    // Fallback to idle if no animation frame is set
    return DIRECTION_IDLE[player.direction] || DIRECTION_IDLE.down;
  }

  // ---------- WS ----------
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    
    console.log('Attempting to connect to:', WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected successfully');
      connected = true;
      connectionPaused = true;
      showLoginGUI = false;
    };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      handleServerMessage(data);
    };
    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      console.log('Failed to connect to:', WS_URL);
    };
    ws.onclose = (e) => {
      console.log('WebSocket closed:', e.code, e.reason);
      connected = false;
      connectionPaused = false;
      showLoginGUI = false;
      loggedIn = false;
      chatMode = false;
      localPlayer = null;
      otherPlayers = {};
      mapItems = {};
      // Clear any pending attack timeout
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
        localAttackTimeout = null;
      }
      
      // Auto-reconnect after 3 seconds if not manually closed
      if (e.code !== 1000) { // 1000 = normal closure
        console.log('Attempting to reconnect in 3 seconds...');
        setTimeout(connectToServer, 3000);
      }
    };
  }
  connectToServer();

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function pushChat(line) { messages.push(String(line)); if (messages.length > 200) messages.shift(); }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success': {
        loggedIn = true;
        localPlayer = { 
          ...msg.player,
          direction: msg.player.direction || 'down',
          isMoving: false,
          isAttacking: false,
          animationFrame: msg.player.animationFrame || DIRECTION_IDLE.down,
          movementSequenceIndex: msg.player.movementSequenceIndex || 0,
          weapon: msg.player.weapon || 0,
          armor: msg.player.armor || 0,
          hands: msg.player.hands || 0
        };
        
        // Initialize local state variables
        playerDirection = localPlayer.direction;
        movementAnimationState = 0;
        isLocallyAttacking = false;
        localAttackState = 0;
        
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => { 
            if (!localPlayer || p.id !== localPlayer.id) {
              otherPlayers[p.id] = {
                ...p,
                direction: p.direction || 'down',
                isMoving: p.isMoving || false,
                isAttacking: p.isAttacking || false,
                animationFrame: p.animationFrame || DIRECTION_IDLE.down,
                movementSequenceIndex: p.movementSequenceIndex || 0
              };
            }
          });
        }

        // Load items if provided
        if (msg.items) {
          mapItems = { ...msg.items };
        }

        pushChat("Welcome to DragonSpires!");
        break;
      }
      case 'player_joined':
        if (!localPlayer || msg.player.id !== localPlayer.id) {
          otherPlayers[msg.player.id] = {
            ...msg.player,
            direction: msg.player.direction || 'down',
            isMoving: msg.player.isMoving || false,
            isAttacking: msg.player.isAttacking || false,
            animationFrame: msg.player.animationFrame || DIRECTION_IDLE.down,
            movementSequenceIndex: msg.player.movementSequenceIndex || 0
          };
          pushChat(`${msg.player.username || msg.player.id} has entered DragonSpires!`);
        }
        break;
      case 'player_moved':
        if (localPlayer && msg.id === localPlayer.id) { 
          // Only update position and sequence from server, keep local direction for immediate feedback
          localPlayer.pos_x = msg.x; 
          localPlayer.pos_y = msg.y;
          // Don't override direction if we just moved - keep the local direction
          // localPlayer.direction = msg.direction || localPlayer.direction;
          localPlayer.isMoving = msg.isMoving || false;
          // Only update animation frame if we're not currently moving (to avoid animation conflicts)
          if (!localPlayer.isMoving) {
            localPlayer.animationFrame = msg.animationFrame || localPlayer.animationFrame;
            localPlayer.movementSequenceIndex = msg.movementSequenceIndex || localPlayer.movementSequenceIndex;
          }
        } else {
          if (!otherPlayers[msg.id]) {
            otherPlayers[msg.id] = { 
              id: msg.id, 
              username: `#${msg.id}`, 
              pos_x: msg.x, 
              pos_y: msg.y,
              direction: msg.direction || 'down',
              isMoving: msg.isMoving || false,
              isAttacking: false,
              animationFrame: msg.animationFrame || DIRECTION_IDLE.down,
              movementSequenceIndex: msg.movementSequenceIndex || 0
            };
          } else { 
            otherPlayers[msg.id].pos_x = msg.x; 
            otherPlayers[msg.id].pos_y = msg.y;
            otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
            otherPlayers[msg.id].isMoving = msg.isMoving || false;
            otherPlayers[msg.id].animationFrame = msg.animationFrame || otherPlayers[msg.id].animationFrame;
            otherPlayers[msg.id].movementSequenceIndex = msg.movementSequenceIndex || otherPlayers[msg.id].movementSequenceIndex;
          }
        }
        break;
      case 'animation_update':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.direction = msg.direction || localPlayer.direction;
          localPlayer.isMoving = msg.isMoving || false;
          localPlayer.isAttacking = msg.isAttacking || false;
          localPlayer.animationFrame = msg.animationFrame || localPlayer.animationFrame;
          localPlayer.movementSequenceIndex = msg.movementSequenceIndex || localPlayer.movementSequenceIndex;
        } else if (otherPlayers[msg.id]) {
          otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
          otherPlayers[msg.id].isMoving = msg.isMoving || false;
          otherPlayers[msg.id].isAttacking = msg.isAttacking || false;
          otherPlayers[msg.id].animationFrame = msg.animationFrame || otherPlayers[msg.id].animationFrame;
          otherPlayers[msg.id].movementSequenceIndex = msg.movementSequenceIndex || otherPlayers[msg.id].movementSequenceIndex;
        }
        break;
      case 'player_equipment_update':
        if (localPlayer && msg.id === localPlayer.id) {
          // Update local player equipment
          if ('weapon' in msg) localPlayer.weapon = msg.weapon;
          if ('armor' in msg) localPlayer.armor = msg.armor;
          if ('hands' in msg) localPlayer.hands = msg.hands;
        } else if (otherPlayers[msg.id]) {
          // Update other player equipment
          if ('weapon' in msg) otherPlayers[msg.id].weapon = msg.weapon;
          if ('armor' in msg) otherPlayers[msg.id].armor = msg.armor;
          if ('hands' in msg) otherPlayers[msg.id].hands = msg.hands;
        }
        break;
      case 'item_placed':
        // Update local item map
        const key = `${msg.x},${msg.y}`;
        if (msg.itemId === 0) {
          delete mapItems[key];
        } else {
          mapItems[key] = msg.itemId; // This includes -1 for picked up map items
        }
        break;
      case 'player_left': {
        const p = otherPlayers[msg.id];
        const name = p?.username ?? msg.id;
        if (!localPlayer || msg.id !== localPlayer.id) pushChat(`${name} has left Dr

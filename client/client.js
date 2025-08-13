// Replace the getItemAtPosition function in client.js with this fixed version:

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

// Also replace the item rendering section in drawGame() function:

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

// Remove all the console.log statements from the 'item_placed' case in handleServerMessage:

case 'item_placed':
  // Update local item map
  const key = `${msg.x},${msg.y}`;
  if (msg.itemId === 0) {
    delete mapItems[key];
  } else {
    mapItems[key] = msg.itemId; // This includes -1 for picked up map items
  }
  break;

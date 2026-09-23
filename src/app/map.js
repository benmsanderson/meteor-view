/**
 * Drawing the forced response as a map, and picking a region off it.
 *
 * Equirectangular, because the grid is regular in latitude and longitude and
 * anything else would mean resampling for no gain at this scale. The field is
 * drawn into an ImageData at grid resolution and scaled up by the canvas, so
 * cost is proportional to gridpoints rather than pixels.
 *
 * The AR6 outlines do double duty: they are the only geography on the map, and
 * they are what you click to choose a region.
 */

/** Longitude at the left edge. -180 puts the Atlantic in the middle. */
const WEST_EDGE = -180;

/** Normalise a longitude into [WEST_EDGE, WEST_EDGE + 360). */
export function wrapLon(lon) {
  return ((((lon - WEST_EDGE) % 360) + 360) % 360) + WEST_EDGE;
}

/**
 * A diverging blue-white-red scale for anomalies, and a sequential one for
 * quantities that are positive by nature.
 *
 * Diverging scales must be symmetric about zero or they lie about the sign of
 * a change, so the domain is forced to ±max rather than [min, max].
 */
export function colourScale(values, { diverging }) {
  let low = Infinity;
  let high = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < low) low = v;
    if (v > high) high = v;
  }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 1;
  }
  if (diverging) {
    const extent = Math.max(Math.abs(low), Math.abs(high)) || 1;
    low = -extent;
    high = extent;
  }

  const span = high - low || 1;
  const stops = diverging
    ? [
        [0.0, [5, 48, 97]],
        [0.25, [67, 147, 195]],
        [0.5, [247, 247, 247]],
        [0.75, [214, 96, 77]],
        [1.0, [103, 0, 31]],
      ]
    : [
        [0.0, [255, 247, 243]],
        [0.35, [158, 202, 225]],
        [0.7, [33, 113, 181]],
        [1.0, [8, 48, 107]],
      ];

  const colour = (value) => {
    const t = Math.min(Math.max((value - low) / span, 0), 1);
    for (let i = 1; i < stops.length; i += 1) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1];
        const [t1, c1] = stops[i];
        const f = (t - t0) / (t1 - t0 || 1);
        return [
          Math.round(c0[0] + f * (c1[0] - c0[0])),
          Math.round(c0[1] + f * (c1[1] - c0[1])),
          Math.round(c0[2] + f * (c1[2] - c0[2])),
        ];
      }
    }
    return stops[stops.length - 1][1];
  };

  return { low, high, colour };
}

/**
 * Draw a field, the AR6 outlines, and any selection over the top.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Float64Array} options.field row-major `(lat, lon)`
 * @param {Float64Array} options.lat
 * @param {Float64Array} options.lon
 * @param {object[]} options.regions AR6 outlines
 * @param {string|null} options.highlight AR6 code to emphasise
 * @param {object|null} options.box `{south, north, west, east}` selection
 * @param {boolean} options.diverging
 * @returns {{low: number, high: number}} the colour domain actually used
 */
export function drawMap(canvas, { field, lat, lon, regions, highlight, box, diverging }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = Math.round(width / 2);
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const nLat = lat.length;
  const nLon = lon.length;
  const scale = colourScale(field, { diverging });

  // Paint at grid resolution, then let the canvas scale it. The grid is
  // ordered south-to-north and 0-360 in longitude; the image is north-to-south
  // and -180-180, so both axes are remapped here rather than in the caller.
  const image = context.createImageData(nLon, nLat);
  const lonOrder = Array.from({ length: nLon }, (_, j) => j).sort(
    (a, b) => wrapLon(lon[a]) - wrapLon(lon[b])
  );
  const northFirst = lat[0] < lat[nLat - 1];

  for (let row = 0; row < nLat; row += 1) {
    const i = northFirst ? nLat - 1 - row : row;
    for (let col = 0; col < nLon; col += 1) {
      const j = lonOrder[col];
      const value = field[i * nLon + j];
      const offset = (row * nLon + col) * 4;
      if (!Number.isFinite(value)) {
        image.data[offset + 3] = 0;
        continue;
      }
      const [r, g, b] = scale.colour(value);
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }

  // Via an offscreen canvas so the browser scales it smoothly; putImageData
  // ignores the transform and would draw at grid size in the corner.
  const grid = document.createElement('canvas');
  grid.width = nLon;
  grid.height = nLat;
  grid.getContext('2d').putImageData(image, 0, 0);
  context.imageSmoothingEnabled = true;
  context.drawImage(grid, 0, 0, width, height);

  const x = (longitude) => ((wrapLon(longitude) - WEST_EDGE) / 360) * width;
  const y = (latitude) => ((90 - latitude) / 180) * height;

  // Outlines. Drawn per ring, and skipped where a ring straddles the seam:
  // joining across it would streak a line all the way back across the map.
  context.lineWidth = 0.7;
  context.strokeStyle = 'rgba(15, 23, 42, 0.45)';
  for (const region of regions) {
    const emphasis = region.code === highlight;
    context.lineWidth = emphasis ? 2 : 0.7;
    context.strokeStyle = emphasis ? '#f8fafc' : 'rgba(15, 23, 42, 0.45)';
    for (const ring of region.rings) {
      context.beginPath();
      let previous = null;
      for (const [longitude, latitude] of ring) {
        const px = x(longitude);
        const py = y(latitude);
        if (previous !== null && Math.abs(px - previous) > width / 2) {
          context.stroke();
          context.beginPath();
          context.moveTo(px, py);
        } else if (previous === null) {
          context.moveTo(px, py);
        } else {
          context.lineTo(px, py);
        }
        previous = px;
      }
      context.stroke();
    }
  }

  if (box) {
    context.setLineDash([5, 4]);
    context.lineWidth = 2;
    context.strokeStyle = '#facc15';
    const left = x(box.west);
    const right = x(box.east);
    const top = y(box.north);
    const bottom = y(box.south);
    if (right >= left) {
      context.strokeRect(left, top, right - left, bottom - top);
    } else {
      // Straddles the seam: draw it as the two pieces it actually is.
      context.strokeRect(left, top, width - left, bottom - top);
      context.strokeRect(0, top, right, bottom - top);
    }
    context.setLineDash([]);
  }

  return { low: scale.low, high: scale.high, colour: scale.colour };
}

/** Canvas position to geographic coordinates. */
export function toLatLon(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const fx = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const fy = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
  return { lat: 90 - fy * 180, lon: WEST_EDGE + fx * 360 };
}

/**
 * The AR6 region containing a point, or null.
 *
 * Ray casting per ring. With 58 regions of a few dozen vertices each this is
 * far too cheap to be worth indexing.
 */
export function regionAt(regions, { lat, lon }) {
  const target = wrapLon(lon);
  for (const region of regions) {
    for (const ring of region.rings) {
      if (pointInRing(ring, target, lat)) return region;
    }
  }
  return null;
}

function pointInRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = [wrapLon(ring[i][0]), ring[i][1]];
    const [xj, yj] = [wrapLon(ring[j][0]), ring[j][1]];
    // A ring crossing the seam would give a spurious crossing here; AR6 rings
    // that do are split in the source data, so each piece stays on one side.
    if (Math.abs(xi - xj) > 180) continue;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Draw the colour bar for a scale. */
export function drawColourBar(canvas, { low, high, colour, label }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const barHeight = 12;
  for (let px = 0; px < width; px += 1) {
    const [r, g, b] = colour(low + ((high - low) * px) / (width - 1));
    context.fillStyle = `rgb(${r},${g},${b})`;
    context.fillRect(px, 0, 1, barHeight);
  }

  const style = getComputedStyle(document.documentElement);
  context.fillStyle = style.getPropertyValue('--muted').trim() || '#64748b';
  context.font = '11px ui-sans-serif, system-ui, sans-serif';
  context.textBaseline = 'top';
  context.textAlign = 'left';
  context.fillText(low.toFixed(1), 0, barHeight + 4);
  context.textAlign = 'right';
  context.fillText(high.toFixed(1), width, barHeight + 4);
  context.textAlign = 'center';
  context.fillText(label, width / 2, barHeight + 4);
}

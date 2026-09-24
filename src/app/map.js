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
 * Discrete colour classes, sampled from the IPCC AR7 WGI diverging colormaps.
 *
 * The same source as the published figures, so a map from here sits beside
 * them. Eleven classes rather than a continuous ramp: a smooth field invites
 * false precision about values between contours, and a reader can actually
 * take a number off a classed bar.
 */
export const CLASSES = {
  // Sampled at each bin's midpoint on a symmetric domain, not evenly along the
  // array. Warming is almost entirely positive, so even sampling would put the
  // colormap's white centre at about 3.5 °C and render half the map's warming
  // in blues. Reference range ±11 °C.
  temperature: [
    '#cfe2ed', '#ecf2f5', '#f6eeed', '#f1d6d2', '#ecc0b9', '#e6a89e',
    '#e19083', '#dc7a6a', '#cb5748', '#992b34', '#67001f',
  ],
  // Symmetric bins, so these sit symmetrically too. Brown is drier, teal
  // wetter, as in the AR6 maps. Reference range ±45 %.
  precipitation: [
    '#543005', '#8f5c1b', '#c48a3d', '#d9b688', '#e9d7c0', '#f8f8f8',
    '#c2dddb', '#8cc3be', '#449f97', '#1d6e64', '#003c30',
  ],
};

/**
 * Fixed bin edges, per variable.
 *
 * Deliberately not derived from the data. An adaptive scale recomputes as the
 * year slider moves, so 2030 renders as red as 2100 and the reader is misled
 * by the one control most likely to be used. Fixed edges also make two maps —
 * and their difference — comparable, which is what the next piece of work
 * needs.
 *
 * Ten edges give eleven classes, the outermost of which are open-ended and
 * marked with triangles on the bar.
 */
export const BIN_EDGES = {
  // °C of warming. Runs to 8, which SSP5-8.5 exceeds over the Arctic.
  temperature: [-1, 0, 1, 2, 3, 4, 5, 6, 8, 10],
  // Percent change in precipitation, symmetric about zero.
  precipitation: [-40, -30, -20, -10, -5, 5, 10, 20, 30, 40],
};

/**
 * A classed colour scale.
 *
 * @param {'temperature'|'precipitation'} variable
 * @returns {{edges: number[], colours: string[], colour: (v: number) => string}}
 */
export function classedScale(variable) {
  const edges = BIN_EDGES[variable];
  const colours = CLASSES[variable];
  const colour = (value) => {
    if (!Number.isFinite(value)) return null;
    let index = 0;
    while (index < edges.length && value >= edges[index]) index += 1;
    return colours[Math.min(index, colours.length - 1)];
  };
  return { edges, colours, colour };
}

/** '#rrggbb' to [r, g, b]. */
function toRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * A viewport: which part of the world is on screen.
 *
 * `zoom` 1 shows the globe; `centre` is the geographic point at the middle of
 * the canvas. Kept as plain data so pan and zoom are pure state changes and
 * every hit test goes through the same two functions as the drawing.
 */
export function defaultView() {
  return { zoom: 1, centreLat: 0, centreLon: 0 };
}

/** Clamp a view so it cannot be panned off the world or zoomed inside-out. */
export function clampView(view) {
  const zoom = Math.min(Math.max(view.zoom, 1), 12);
  // Half the visible span, in degrees.
  const halfLat = 90 / zoom;
  return {
    zoom,
    centreLat: Math.min(Math.max(view.centreLat, -90 + halfLat), 90 - halfLat),
    centreLon: wrapLon(view.centreLon),
  };
}

/** The projection for a view: geographic to canvas pixels, and back. */
export function projection(view, width, height) {
  const { zoom, centreLat, centreLon } = view;
  const degreesPerPixelX = 360 / (width * zoom);
  const degreesPerPixelY = 180 / (height * zoom);

  const x = (lon) => {
    // Shortest way round, so a ring near the seam does not fly across.
    let delta = wrapLon(lon) - centreLon;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return width / 2 + delta / degreesPerPixelX;
  };
  const y = (lat) => height / 2 - (lat - centreLat) / degreesPerPixelY;
  const lonAt = (px) => wrapLon(centreLon + (px - width / 2) * degreesPerPixelX);
  const latAt = (py) => centreLat - (py - height / 2) * degreesPerPixelY;
  return { x, y, lonAt, latAt, degreesPerPixelX, degreesPerPixelY };
}

/**
 * Draw a field, coastlines, region outlines and any selection.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @param {Float64Array} options.field row-major `(lat, lon)`, already in
 *   display units
 * @param {Float64Array} options.lat
 * @param {Float64Array} options.lon
 * @param {object[]} options.regions AR6 outlines
 * @param {number[][][]} options.coastlines rings of `[lon, lat]`
 * @param {string|null} options.highlight AR6 code to emphasise
 * @param {object|null} options.box `{south, north, west, east}` selection
 * @param {'temperature'|'precipitation'} options.variable which classes to use
 * @param {object} options.view from {@link defaultView}
 */
export function drawMap(
  canvas,
  { field, lat, lon, regions, coastlines = [], highlight, box, variable, view }
) {
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
  const scale = classedScale(variable);

  // Paint the whole globe at grid resolution once, then let the canvas place
  // and scale it for the current view. The grid runs south-to-north and
  // 0-360; the image runs north-to-south and -180-180, so both axes are
  // remapped here rather than in the caller.
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
      const hex = scale.colour(value);
      if (!hex) {
        image.data[offset + 3] = 0;
        continue;
      }
      const [r, g, b] = toRgb(hex);
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }

  const grid = document.createElement('canvas');
  grid.width = nLon;
  grid.height = nLat;
  grid.getContext('2d').putImageData(image, 0, 0);

  const project = projection(view, width, height);
  // Where the whole world lands under this view. Drawn twice, offset by a
  // world width, so panning across the seam shows continuous map rather than
  // blank canvas.
  const worldWidth = width * view.zoom;
  const worldHeight = height * view.zoom;
  const originX = project.x(-180) ;
  const originY = project.y(90);

  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  // Smooth while a gridbox is smaller than a few pixels, crisp once it is
  // not. Past that point smoothing is inventing detail the model does not
  // have, and showing the gridboxes is the honest picture of its resolution.
  context.imageSmoothingEnabled = worldWidth / nLon < 6;
  for (const shift of [-worldWidth, 0, worldWidth]) {
    context.drawImage(grid, originX + shift, originY, worldWidth, worldHeight);
  }

  /** Stroke a set of rings, splitting where they cross the seam. */
  const strokeRings = (rings, colour, lineWidth, alpha = 1) => {
    context.strokeStyle = colour;
    context.lineWidth = lineWidth;
    context.globalAlpha = alpha;
    for (const ring of rings) {
      context.beginPath();
      let previous = null;
      for (const [longitude, latitude] of ring) {
        const px = project.x(longitude);
        const py = project.y(latitude);
        if (previous !== null && Math.abs(px - previous) > width) {
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
    context.globalAlpha = 1;
  };

  // Coastlines first: they are what a reader orients by, and the AR6 boxes
  // should sit over them rather than under.
  strokeRings(coastlines, 'rgba(15, 23, 42, 0.75)', 0.6);

  for (const region of regions) {
    const emphasis = region.code === highlight;
    strokeRings(
      region.rings,
      emphasis ? '#f8fafc' : 'rgba(15, 23, 42, 0.22)',
      emphasis ? 2 : 0.5,
      emphasis ? 1 : 0.8
    );
  }

  if (box) {
    context.setLineDash([5, 4]);
    context.lineWidth = 2;
    context.strokeStyle = '#facc15';
    const top = project.y(box.north);
    const bottom = project.y(box.south);
    for (const shift of [-worldWidth, 0, worldWidth]) {
      const left = project.x(box.west) + shift;
      const right = project.x(box.east) + shift;
      if (right >= left) context.strokeRect(left, top, right - left, bottom - top);
    }
    context.setLineDash([]);
  }
  context.restore();
}

/**
 * Canvas position to geographic coordinates, under a view.
 *
 * Goes through the same projection the drawing does, so a click always lands
 * where the pointer is however the map has been panned or zoomed.
 */
export function toLatLon(canvas, event, view = defaultView()) {
  const rect = canvas.getBoundingClientRect();
  const height = Math.round(rect.width / 2);
  const project = projection(view, rect.width, height);
  const px = event.clientX - rect.left;
  const py = ((event.clientY - rect.top) / rect.height) * height;
  return {
    lat: Math.min(Math.max(project.latAt(py), -90), 90),
    lon: project.lonAt(px),
  };
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

/**
 * Draw the classed colour bar.
 *
 * Equal-width blocks with their edges labelled, rather than a gradient: the
 * classes are the scale, and a gradient would misrepresent them. The outermost
 * classes are open-ended and drawn as triangles, so a reader can see that a
 * value beyond the last edge is off the scale rather than at its end.
 */
export function drawColourBar(canvas, { edges, colours, label }) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const barHeight = 12;
  const cap = 9;
  const inner = width - cap * 2;
  const blocks = edges.length - 1;
  const blockWidth = inner / blocks;

  // Open-ended first class, as a left-pointing triangle.
  context.fillStyle = colours[0];
  context.beginPath();
  context.moveTo(0, barHeight / 2);
  context.lineTo(cap, 0);
  context.lineTo(cap, barHeight);
  context.closePath();
  context.fill();

  for (let i = 0; i < blocks; i += 1) {
    context.fillStyle = colours[i + 1];
    context.fillRect(cap + i * blockWidth, 0, blockWidth + 0.5, barHeight);
  }

  context.fillStyle = colours[colours.length - 1];
  context.beginPath();
  context.moveTo(width, barHeight / 2);
  context.lineTo(width - cap, 0);
  context.lineTo(width - cap, barHeight);
  context.closePath();
  context.fill();

  const style = getComputedStyle(document.documentElement);
  context.fillStyle = style.getPropertyValue('--muted').trim() || '#64748b';
  context.font = '10px ui-sans-serif, system-ui, sans-serif';
  context.textBaseline = 'top';
  context.textAlign = 'center';
  for (let i = 0; i < edges.length; i += 1) {
    // Every edge on a short bar would collide; every other one reads fine.
    if (edges.length > 8 && i % 2 === 1 && i !== edges.length - 1) continue;
    context.fillText(String(edges[i]), cap + i * blockWidth, barHeight + 3);
  }

  context.textAlign = 'left';
  context.fillText(label, 0, barHeight + 16);
}

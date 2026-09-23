/**
 * Reading METEOR portable artifacts (schema v1) in the browser.
 *
 * The artifacts are classic netCDF-3, which netcdfjs parses in a few kilobytes
 * rather than the one-to-two megabyte WebAssembly build of libhdf5 that
 * NETCDF4/HDF5 would need. That is the whole reason the wire format is classic,
 * so this module deliberately depends on nothing heavier.
 *
 * netcdfjs hands back flat arrays and refers to dimensions by index, and it
 * returns char variables as a flat run of single characters. Everything here
 * exists to turn that into named, shaped access.
 */

import { NetCDFReader } from 'netcdfjs';

/** Schema version this reader understands. Refuse anything newer. */
export const SCHEMA_VERSION = 1;

export const BUNDLE_FORMAT = 'meteor-timeseries-bundle';
export const GOLDEN_FORMAT = 'meteor-golden-fixture';

/**
 * An artifact, with named access to its variables, dimensions and attributes.
 */
export class Artifact {
  /** @param {ArrayBuffer|Uint8Array} buffer raw file contents */
  constructor(buffer) {
    this.reader = new NetCDFReader(buffer);

    this.attrs = {};
    for (const a of this.reader.globalAttributes) this.attrs[a.name] = a.value;

    this.dims = {};
    for (const d of this.reader.dimensions) this.dims[d.name] = d.size;

    this._vars = new Map();
    for (const v of this.reader.variables) this._vars.set(v.name, v);

    const version = Number(this.attrs.schema_version);
    if (!Number.isFinite(version)) {
      throw new Error('not a METEOR artifact: no schema_version attribute');
    }
    // A reader must refuse a schema_version higher than it understands: a
    // later version may reinterpret variables this one thinks it knows.
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `artifact schema v${version} is newer than this reader (v${SCHEMA_VERSION})`
      );
    }
    this.schemaVersion = version;
    this.format = this.attrs.format;
  }

  /** @param {string} name @returns {boolean} whether the variable is present */
  has(name) {
    return this._vars.has(name);
  }

  /** Dimension names of a variable, resolved from netcdfjs's indices. */
  dimNames(name) {
    const v = this._vars.get(name);
    if (!v) throw new Error(`no variable '${name}'`);
    return v.dimensions.map((i) => this.reader.dimensions[i].name);
  }

  /** Shape of a variable. @returns {number[]} */
  shape(name) {
    return this.dimNames(name).map((d) => this.dims[d]);
  }

  /**
   * A numeric variable as a flat Float64Array in C (row-major) order.
   *
   * Row-major layout is part of the schema contract, so callers index with
   * the strides implied by {@link shape} and never need to transpose.
   */
  array(name) {
    if (!this._vars.has(name)) throw new Error(`no variable '${name}'`);
    return Float64Array.from(this.reader.getDataVariable(name));
  }

  /**
   * A char variable as an array of strings.
   *
   * netCDF-3 has no string type: xarray writes fixed-width char arrays whose
   * last dimension is the padded width, so the flat run is chunked by that
   * width and the null padding trimmed.
   */
  strings(name) {
    const raw = this.reader.getDataVariable(name);
    const dims = this.shape(name);
    const width = dims[dims.length - 1];
    // netCDF-3 pads each variable to a four-byte boundary, so the flat run can
    // be longer than width * count and chunking by width alone would yield a
    // spurious trailing entry. Take the count from the dimensions instead.
    const count = dims.slice(0, -1).reduce((a, b) => a * b, 1);

    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push(
        raw
          .slice(i * width, (i + 1) * width)
          .join('')
          .replace(/\0+$/, '')
          .trim()
      );
    }
    return out;
  }
}

/**
 * A compact per-location timeseries bundle.
 *
 * Everything a client needs to generate region or point timeseries: the shared
 * VARX arrays, per-location seasonal/EOF/pattern projections, the step-response
 * kernel, baked scenario forcing and (for transformed variables) the gamma
 * parameters plus the shared quantile table.
 */
export class Bundle extends Artifact {
  constructor(buffer) {
    super(buffer);
    if (this.format !== BUNDLE_FORMAT) {
      throw new Error(`expected a ${BUNDLE_FORMAT}, got '${this.format}'`);
    }

    this.variable = this.attrs.variable_name;
    this.nModes = this.dims.mode;
    this.lagOrder = this.dims.lag;
    this.locations = this.strings('location');
    this.experiments = this.strings('exp');
    this.scenarios = this.has('scenario') ? this.strings('scenario') : [];
    this.forcingYearStart = Number(this.attrs.forcing_year_start);

    /** Whether this bundle carries a distribution transform (`pr`, not `tas`). */
    this.hasTransform = this.has('transform_shape');
    this.transformWindow = [
      Number(this.attrs.transform_window_start),
      Number(this.attrs.transform_window_end),
    ];

    this._cache = new Map();
  }

  /** Cached variable read: the UI re-reads the same arrays on every redraw. */
  get(name) {
    if (!this._cache.has(name)) this._cache.set(name, this.array(name));
    return this._cache.get(name);
  }

  /**
   * Index of a location specifier such as `global`, `regional:NEU`,
   * `point:19.1,72.9`.
   */
  locationIndex(spec) {
    const i = this.locations.indexOf(spec);
    if (i < 0) throw new Error(`location '${spec}' is not in this bundle`);
    return i;
  }

  /** Row `i` of a `(location, n)` variable. */
  locationRow(name, spec, n) {
    const i = this.locationIndex(spec);
    return this.get(name).subarray(i * n, (i + 1) * n);
  }

  /**
   * Per-experiment forcing for a bundled scenario, keyed by experiment name.
   *
   * This is what closes the loop for a browser: obtaining forcing otherwise
   * means running CICERO-SCM, which a browser cannot do, so the bundle bakes
   * in the trajectories for the scenarios it was exported with.
   *
   * @param {string} scenario e.g. `ssp245`
   * @returns {Map<string, Float64Array>} forcing by experiment name
   */
  forcing(scenario) {
    if (!this.has('scenario_forcing')) {
      throw new Error('bundle carries no scenario forcing');
    }
    const s = this.scenarios.indexOf(scenario);
    if (s < 0) throw new Error(`scenario '${scenario}' is not in this bundle`);

    const nExp = this.dims.exp;
    const nYear = this.dims.year;
    const flat = this.get('scenario_forcing');
    const out = new Map();
    for (let e = 0; e < nExp; e += 1) {
      const start = (s * nExp + e) * nYear;
      const series = flat.subarray(start, start + nYear);
      // Absent experiments are stored as NaN rather than omitted.
      if (Number.isFinite(series[0])) out.set(this.experiments[e], series);
    }
    return out;
  }
}

/** A fixed-seed reference output, for validating this port against METEOR. */
export class GoldenFixture extends Artifact {
  constructor(buffer) {
    super(buffer);
    if (this.format !== GOLDEN_FORMAT) {
      throw new Error(`expected a ${GOLDEN_FORMAT}, got '${this.format}'`);
    }
    this.locations = this.strings('location');
    this.nRealizations = this.dims.realization;
    this.nMonths = this.dims.month;
    this.nModes = this.dims.mode;
    this.year0 = Number(this.attrs.year_0);
  }

  /** `stochastic_pcs` for one realization, as `(month, mode)` row-major. */
  pcs(realization) {
    const n = this.nMonths * this.nModes;
    return this.array('stochastic_pcs').subarray(realization * n, (realization + 1) * n);
  }

  /** `series` for one location and realization. */
  series(locationIndex, realization) {
    const n = this.nMonths;
    const offset = (locationIndex * this.nRealizations + realization) * n;
    return this.array('series').subarray(offset, offset + n);
  }
}

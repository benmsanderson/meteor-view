/**
 * A searchable place picker over the page's place <select>.
 *
 * With some three hundred places a plain menu is a long scroll, so the menu
 * becomes a text box: it shows the current place, typing narrows the list,
 * and choosing sets the <select> and fires its `change`, so everything that
 * listens to the select carries on unaware. The <select> stays in the page,
 * hidden, as the one record of which place is chosen.
 *
 * Follows the ARIA combobox pattern: arrow keys move through the list, Enter
 * chooses, Escape closes and puts back the current place.
 */

/** Lower case, accents off: "São Paulo" is found by "sao paulo". */
export function fold(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * The places matching a query, best first: a name that starts with it, then
 * a word in the name that does, then anything else that contains it (the
 * country, the continent, a region's code). Among equals the bigger place
 * comes first, so "japan" leads with Tokyo rather than the alphabet.
 *
 * @param {Array<{spec: string, label: string, group: string, keywords?: string,
 *   weight?: number}>} entries
 * @param {string} query
 * @param {number} [limit]
 */
export function searchPlaces(entries, query, limit = 60) {
  const q = fold(query.trim());
  if (!q) return entries;
  const scored = [];
  for (const entry of entries) {
    const label = fold(entry.label);
    const rest = fold(`${entry.keywords ?? ''} ${entry.group}`);
    let score;
    if (label.startsWith(q)) score = 0;
    else if (label.split(/[\s,.()&/-]+/).some((word) => word.startsWith(q))) score = 1;
    else if (label.includes(q)) score = 2;
    else if (rest.includes(q)) score = 3;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || (b.entry.weight ?? 0) - (a.entry.weight ?? 0));
  return scored.slice(0, limit).map(({ entry }) => entry);
}

/**
 * Turn a <select> into a searchable box.
 *
 * @param {object} options
 * @param {HTMLSelectElement} options.select the record of the chosen place
 * @param {HTMLInputElement} options.input
 * @param {HTMLElement} options.list an empty element for the results
 * @param {(spec: string) => string} [options.keywords] extra words to match
 *   a place by, such as a city's country
 * @param {(spec: string) => number} [options.weight] how big a place is, to
 *   order equally good matches
 * @returns {{sync: () => void}} call `sync` when the select changes other
 *   than through the box
 */
export function attachPlaceSearch({ select, input, list, keywords = () => '', weight = () => 0 }) {
  let results = [];
  let active = -1;

  const entries = () =>
    [...select.querySelectorAll('option')].map((option) => ({
      spec: option.value,
      label: option.textContent,
      group: option.parentElement.label ?? '',
      keywords: keywords(option.value),
      weight: weight(option.value),
    }));

  const sync = () => {
    input.value = select.selectedOptions[0]?.textContent ?? '';
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const choose = (spec) => {
    close();
    if (spec && spec !== select.value) {
      select.value = spec;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
  };

  const highlight = (index) => {
    active = index;
    for (const [i, item] of [...list.querySelectorAll('[role="option"]')].entries()) {
      const on = i === index;
      item.setAttribute('aria-selected', String(on));
      if (on) {
        input.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const render = (query) => {
    results = searchPlaces(entries(), query);
    list.replaceChildren();
    // Grouped as the menu is when browsing; a flat ranking when searching.
    let group = null;
    results.forEach((entry, i) => {
      if (!query.trim() && entry.group !== group) {
        group = entry.group;
        const heading = document.createElement('li');
        heading.className = 'place-results__group';
        heading.setAttribute('role', 'presentation');
        heading.textContent = group;
        list.append(heading);
      }
      const item = document.createElement('li');
      item.id = `place-option-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.dataset.spec = entry.spec;
      item.textContent = entry.label;
      if (query.trim()) {
        const where = document.createElement('span');
        where.className = 'place-results__where';
        where.textContent = entry.keywords || entry.group;
        item.append(where);
      }
      if (entry.spec === select.value) item.classList.add('place-results__current');
      list.append(item);
    });
    if (!results.length) {
      const none = document.createElement('li');
      none.className = 'place-results__none';
      none.setAttribute('role', 'presentation');
      none.textContent = 'No place matches';
      list.append(none);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(query.trim() && results.length ? 0 : -1);
  };

  input.addEventListener('focus', () => {
    input.select();
    render('');
    const current = list.querySelector('.place-results__current');
    if (current) current.scrollIntoView({ block: 'center' });
  });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) render(input.value);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight(Math.min(Math.max(active + step, 0), results.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) choose(results[active].spec);
    } else if (event.key === 'Escape') {
      close();
      sync();
    }
  });
  // mousedown, not click: it lands before the input's blur closes the list.
  list.addEventListener('mousedown', (event) => {
    const item = event.target.closest('[role="option"]');
    if (!item) return;
    event.preventDefault();
    choose(item.dataset.spec);
  });
  input.addEventListener('blur', () => {
    close();
    sync();
  });

  sync();
  return { sync };
}

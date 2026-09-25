/**
 * Colours for models, when models are what is being compared.
 *
 * Scenarios have official colours; models do not, so these come from a
 * categorical palette validated for colour-vision deficiency on adjacent
 * lines: the reference palette of the dataviz method, its first six slots —
 * six being the most models a view compares. Light and dark steps of the same
 * hues, the dark ones chosen for the dark surface.
 *
 * With forty models on offer no palette can give each its own colour, so a
 * colour belongs to a model for as long as it stays selected: adding or
 * removing one never repaints the others, which is what lets a reader keep
 * track of a line while changing the set.
 */

const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

/** Slots held by the models currently selected. */
const slots = new Map();

/**
 * Keep colours for the models still selected, free those of the rest, and give
 * any newcomer the lowest free slot.
 *
 * @param {string[]} models the selection, in order
 */
export function assignModelColours(models) {
  for (const model of [...slots.keys()]) {
    if (!models.includes(model)) slots.delete(model);
  }
  for (const model of models) {
    if (slots.has(model)) continue;
    const taken = new Set(slots.values());
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    slots.set(model, slot % LIGHT.length);
  }
}

/** A selected model's colour, in the page's current theme. */
export function modelColour(model) {
  const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const slot = slots.get(model) ?? 0;
  return (dark ? DARK : LIGHT)[slot];
}

/**
 * Winziger DOM-Helfer statt Framework.
 *
 * `el('button.big', { onclick }, 'Text')` baut ein Element inklusive Klassen
 * aus der Kurzschreibweise. Mehr braucht diese App nicht: die Bildschirme sind
 * klein, und ohne Build-Schritt bleibt die App das, was sie sein soll - ein
 * Ordner mit Dateien, der sich auf jedem Handy öffnen lässt.
 *
 * Wichtig: Textinhalte gehen immer über textContent, nie über innerHTML.
 * Vokabeln und Merksätze sind Benutzereingaben.
 */

/**
 * @param {string} spec z.B. 'div.card.card--wide' oder 'button#log.primary'
 * @param {object|null} [props] Attribute, on*-Handler, style-Objekt, dataset
 * @param {...(Node|string|number|null|false|Array)} children
 */
export function el(spec, props = null, ...children) {
  const [head, ...classes] = spec.split('.');
  const [tag, id] = head.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') {
        node.className = `${node.className} ${value}`.trim();
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (key in node && key !== 'list' && typeof value !== 'boolean') {
        node[key] = value;
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Gängige Karte mit Überschrift. */
export function card(title, ...children) {
  return el('section.card', null, title ? el('h2.card__title', null, title) : null, ...children);
}

/** Beschriftetes Eingabefeld. */
export function field(label, input) {
  const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return el('label.field', { for: id }, el('span.field__label', null, label), input);
}

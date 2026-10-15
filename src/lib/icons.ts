import { icon } from '@fortawesome/fontawesome-svg-core';
import {
  faArrowRight, faArrowUp, faBold, faChevronDown,
  faCode, faColumns, faCopy, faEye, faEyeSlash, faFileExport, faFileImport,
  faFolder, faGear, faGlobe, faImage, faItalic, faLink, faListOl, faListUl,
  faLock, faLockOpen, faMinus, faPen, faPenToSquare, faPlus, faRotateRight,
  faStop, faStrikethrough, faTable, faXmark,
} from '@fortawesome/free-solid-svg-icons';

// Explicit definitions keep the same on-demand FA approach as shsfdy2sq.
const icons = {
  arrowRight: faArrowRight, arrowUp: faArrowUp,
  bold: faBold, chevronDown: faChevronDown, code: faCode, columns: faColumns,
  copy: faCopy, eye: faEye, eyeSlash: faEyeSlash, fileExport: faFileExport,
  fileImport: faFileImport, folder: faFolder, gear: faGear, globe: faGlobe,
  image: faImage, italic: faItalic, link: faLink, listOl: faListOl, listUl: faListUl,
  lock: faLock, lockOpen: faLockOpen, minus: faMinus, pen: faPen,
  penToSquare: faPenToSquare, plus: faPlus, rotateRight: faRotateRight,
  stop: faStop, strikethrough: faStrikethrough, table: faTable, xmark: faXmark,
};
export type IconName = keyof typeof icons;

export function setIcon(node: HTMLElement, name: IconName): void {
  const definition = icons[name];
  if (!definition) throw new Error(`Undeclared icon: ${name}`);
  node.innerHTML = icon(definition, { attributes: { 'aria-hidden': 'true', focusable: 'false' } }).html.join('');
}

export function initIcons(): void {
  document.querySelectorAll<HTMLElement>('[data-icon]:not(svg)').forEach((node) => setIcon(node, node.dataset.icon as IconName));
}

export function iconButton(name: IconName, label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  setIcon(button, name);
  button.addEventListener('click', action);
  return button;
}

// CodeMirror 6 wrapper for the clipboard editor. Markdown mode + one-dark keeps the
// editor readable without shipping a theme of our own.

import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

export interface ClipboardEditor {
  get(): string;
  set(text: string): void;
  focus(): void;
  onChange(fn: (text: string) => void): void;
  saveShortcut: (fn: () => void) => void;
  destroy(): void;
}

export function mountEditor(container: HTMLElement): ClipboardEditor {
  const listeners: Array<(text: string) => void> = [];
  let onSave: (() => void) | null = null;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const text = update.state.doc.toString();
      for (const fn of listeners) fn(text);
    }
  });

  const saveKeymap = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        onSave?.();
        return true;
      },
    },
  ]);

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: '',
      extensions: [basicSetup, markdown(), oneDark, saveKeymap, updateListener],
    }),
  });

  return {
    get: () => view.state.doc.toString(),
    set: (text: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    onChange: (fn) => listeners.push(fn),
    saveShortcut: (fn) => {
      onSave = fn;
    },
    destroy: () => view.destroy(),
  };
}

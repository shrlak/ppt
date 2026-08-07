import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryEntry } from '../lib/utils/types';
import { normalizeTitle } from '../lib/storage/library';

interface Props {
  library: LibraryEntry[];
  onAdd: (entry: LibraryEntry) => void;
}

const MAX_RESULTS = 30;

/** Searchable "라이브러리에서 추가" combobox — filters by title as the user types. */
export default function LibraryAddSearch({ library, onAdd }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = normalizeTitle(query);
    const matches = q ? library.filter((e) => normalizeTitle(e.title).includes(q)) : library;
    return matches.slice(0, MAX_RESULTS);
  }, [library, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function select(entry: LibraryEntry) {
    onAdd(entry);
    setQuery('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = results[highlight];
      if (entry) select(entry);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="library-add" ref={rootRef}>
      <span className="library-add-label">라이브러리에서 추가:</span>
      <div className="library-add-combobox">
        <input
          type="text"
          data-testid="library-add-search"
          className="library-add-input"
          role="combobox"
          aria-expanded={open}
          aria-controls="library-add-listbox"
          aria-autocomplete="list"
          aria-label="라이브러리에서 찬양 검색"
          placeholder="곡 검색…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <ul
            className="library-add-dropdown"
            id="library-add-listbox"
            role="listbox"
            // Driven by the input's arrow keys — a scrollable <ul> is focusable
            // in Chromium by default, which would add a dead tab stop.
            tabIndex={-1}
            data-testid="library-add-dropdown"
          >
            {results.length === 0 && (
              <li className="library-add-empty" role="presentation">
                일치하는 곡이 없습니다.
              </li>
            )}
            {results.map((e, i) => (
              <li
                key={e.title}
                data-testid="library-add-option"
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? 'active' : ''}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  select(e);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                {e.title}
                {e.key ? ` (${e.key})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

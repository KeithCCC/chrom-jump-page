'use strict';

/** TabNest v1.1.1: no third-party runtime dependencies or outbound requests. */
const $ = (selector) => document.querySelector(selector);
const state = {
  roots: [],
  nodes: new Map(),
  folders: [],
  allLinks: [],
  pinnedIds: [],
  initialized: false,
  // Resolve once the tree arrives, on EVERY new page (independent of pin setup).
  view: 'bookmark-bar',
  query: '',
  theme: 'light',
  compact: false,
  visibleLimit: 90,
  editor: null,
  toastTimer: null,
  selecting: false,
  selectedIds: new Set(),
  busy: false,
  treeVersion: 0,
  dragToken: crypto.getRandomValues(new Uint32Array(4)).join('-'),
};

const el = {
  primaryNav: $('#primaryNav'), folderNav: $('#folderNav'), folderTotal: $('#folderTotal'),
  breadcrumb: $('#breadcrumbName'), date: $('#dateLabel'), search: $('#searchInput'),
  pins: $('#pinnedGrid'), pinnedSection: $('#pinnedSection'), pinnedCount: $('#pinnedCount'),
  browse: $('#browseSection'), browseTitle: $('#browseTitle'), browseKicker: $('#browseKicker'),
  browseCount: $('#browseCount'), bookmarks: $('#bookmarkGrid'), more: $('#loadMoreBtn'),
  theme: $('#themeBtn'), view: $('#viewBtn'), refresh: $('#refreshBtn'),
  dialog: $('#editorDialog'), form: $('#editorForm'), dialogTitle: $('#dialogTitle'),
  title: $('#titleField'), url: $('#urlField'), parent: $('#parentField'),
  urlBlock: $('#urlFieldBlock'), parentBlock: $('#parentFieldBlock'),
  formError: $('#formError'), toast: $('#toast'),
  bulkToolbar: $('#bulkToolbar'),
  selectionCount: $('#selectionCount'), selectAll: $('#selectAllBtn'),
  clearSelection: $('#clearSelectionBtn'), editSelected: $('#editSelectedBtn'),
  deleteSelected: $('#deleteSelectedBtn'), bulkStatus: $('#bulkStatus')
};

function svg(icon, className = 'icon') {
  const root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  root.setAttribute('class', className);
  root.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ic-${icon}`);
  root.append(use);
  return root;
}

function domainFrom(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.replace(/^www\./, '');
    }
    return `${parsed.protocol.replace(':', '')} ページ`;
  } catch { return ''; }
}

function canOpen(url) {
  try {
    return ['https:', 'http:', 'chrome:', 'file:', 'about:', 'edge:'].includes(new URL(url).protocol);
  } catch { return false; }
}

function normalizeUrl(raw) {
  let value = raw.trim();
  if (!value) throw new Error('URLを入力してください。');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) value = `https://${value}`;
  if (!canOpen(value)) throw new Error('http(s)、chrome、file、about のURLを指定してください。');
  return value;
}

function toast(message) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('visible');
  state.toastTimer = setTimeout(() => el.toast.classList.remove('visible'), 2900);
}

function collectTree() {
  state.nodes.clear();
  state.folders = [];
  state.allLinks = [];
  function visit(node, depth = 0) {
    if (!node) return;
    state.nodes.set(node.id, node);
    if (node.url) {
      if (canOpen(node.url)) state.allLinks.push(node);
      return;
    }
    if (depth > 0) state.folders.push(node);
    for (const child of node.children || []) visit(child, depth + 1);
  }
  for (const root of state.roots) visit(root);
}

function rootCategories() {
  return state.roots[0]?.children?.filter(node => !node.url) || [];
}

function defaultParentId() {
  const cats = rootCategories();
  // Chrome 134+ supplies folderType; titles vary with the browser language.
  // Profiles can expose multiple bars. Prefer the traditional Chrome root '1'
  // among typed bars, otherwise the first typed bar in API order.
  const bars = cats.filter(x => x.folderType === 'bookmarks-bar');
  return (bars.find(x => x.id === '1') || bars[0] ||
    cats.find(x => x.id === '1' && !x.folderType))?.id;
}

function countLinks(folder) {
  if (!folder) return 0;
  return (folder.children || []).reduce((sum, item) => sum + (item.url ? 1 : countLinks(item)), 0);
}

async function savePrefs() {
  await chrome.storage.local.set({
    tabnestPinnedIds: state.pinnedIds,
    tabnestInitialized: state.initialized,
    tabnestTheme: state.theme,
    tabnestCompact: state.compact
  });
}

async function loadTree({force = false} = {}) {
  if (state.busy && !force) return false;
  const version = ++state.treeVersion;
  try {
    const roots = await chrome.bookmarks.getTree();
    if (version !== state.treeVersion) return false;
    state.roots = roots;
    collectTree();
    state.selectedIds = new Set([...state.selectedIds].filter(id => canModify(state.nodes.get(id))));
    const valid = new Set(state.allLinks.map(x => x.id));
    const oldPins = state.pinnedIds.join(',');
    state.pinnedIds = state.pinnedIds.filter(id => valid.has(id));
    if (!state.initialized) {
      const bar = state.nodes.get(defaultParentId());
      const initial = (bar?.children || []).filter(x => x.url && valid.has(x.id));
      const backup = initial.length ? initial : state.allLinks;
      state.pinnedIds = backup.slice(0, 8).map(x => x.id);
      state.initialized = true;
      await savePrefs();
    } else if (oldPins !== state.pinnedIds.join(',')) {
      await savePrefs();
    }
    // Refreshes and bookmark events preserve navigation within an open tab.
    // A fresh page, or a folder that was deleted, returns to the bar.
    if (state.view !== 'all' && state.view !== 'pinned' && !state.nodes.has(state.view)) {
      state.view = defaultParentId() || 'bookmark-bar';
    }
    render();
    return true;
  } catch (error) {
    console.error('Bookmarks unavailable:', error);
    toast('ブックマークを読み込めませんでした。拡張機能の権限を確認してください。');
    return false;
  }
}

function isManaged(node) {
  for (let current = node; current; current = state.nodes.get(current.parentId)) {
    if (current.unmodifiable || current.folderType === 'managed') return true;
  }
  return false;
}

function canModify(node) {
  return !!node && !!node.parentId && !node.folderType && !isManaged(node) &&
    !rootCategories().some(root => root.id === node.id);
}

function isWithin(id, ancestorId) {
  for (let node = state.nodes.get(id); node; node = state.nodes.get(node.parentId)) {
    if (node.id === ancestorId) return true;
  }
  return false;
}

function canMoveTo(id) {
  const target = state.nodes.get(id);
  return !!target && !target.url && !!target.parentId && !isManaged(target) &&
    [...state.selectedIds].every(selectedId => !isWithin(id, selectedId));
}

function toggleSelection(id) {
  if (state.busy || !canModify(state.nodes.get(id))) return;
  const focused = document.activeElement;
  const sectionId = focused?.classList.contains('item-select') ? focused.closest('section')?.id : null;
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  el.bulkStatus.textContent = '';
  render();
  if (sectionId) {
    [...document.querySelectorAll('.item-select')].find(input => input.dataset.id === id && input.closest('section')?.id === sectionId)?.focus();
  }
}

function selectCard(card, node) {
  card.dataset.id = node.id;
  if (!canModify(node)) return;
  card.classList.add('selectable');
  card.classList.toggle('is-selected', state.selectedIds.has(node.id));
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'item-select';
  check.dataset.id = node.id;
  check.checked = state.selectedIds.has(node.id);
  check.disabled = state.busy;
  check.setAttribute('aria-label', `${node.title || node.url || 'フォルダ'}を選択`);
  check.addEventListener('click', event => event.stopPropagation());
  check.addEventListener('change', () => toggleSelection(node.id));
  const label = document.createElement('label');
  label.className = 'card-selection';
  const caption = document.createElement('span'); caption.textContent = '選択';
  label.append(check, caption);
  card.prepend(label);
  card.addEventListener('click', event => {
    if (!state.selecting || event.target.closest('.card-selection, .card-star, .folder-link')) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSelection(node.id);
  }, true);
  card.draggable = !state.busy;
  card.addEventListener('dragstart', event => {
    if (!state.selecting) return;
    if (state.busy) { event.preventDefault(); return; }
    if (!state.selectedIds.has(node.id)) state.selectedIds.add(node.id);
    event.dataTransfer.setData('application/x-tabnest-selection', JSON.stringify({token: state.dragToken, ids: [...state.selectedIds]}));
    event.dataTransfer.setData('text/plain', [...state.selectedIds].join(','));
    event.dataTransfer.effectAllowed = 'move';
    // Keep the source card in the DOM throughout the native drag operation.
    document.querySelectorAll('.item-select').forEach(input => {
      input.checked = state.selectedIds.has(input.dataset.id);
      input.closest('article').classList.toggle('is-selected', input.checked);
    });
    state.selecting = state.selectedIds.size > 0;
    renderNav(); renderSelection();
  });
}

function renderSelection() {
  document.body.classList.toggle('selection-mode', state.selecting);
  el.bulkToolbar.hidden = !state.selecting && !el.bulkStatus.textContent;
  el.bulkToolbar.setAttribute('aria-busy', String(state.busy));
  el.selectionCount.textContent = `${state.selectedIds.size}件選択中`;
  el.selectAll.disabled = state.busy;
  el.clearSelection.disabled = state.busy;
  el.clearSelection.textContent = state.selectedIds.size ? '選択を解除' : '閉じる';
  el.deleteSelected.disabled = state.busy || !state.selectedIds.size;
  el.editSelected.disabled = state.busy || state.selectedIds.size !== 1;
}

async function operateSelection(action, destinationId) {
  if (state.busy || !state.selectedIds.size) return;
  state.busy = true;
  render();
  try {
    // Revalidate against Chrome immediately before changing bookmarks.
    if (!await loadTree({force: true})) throw new Error('最新のブックマークを確認できませんでした。もう一度お試しください。');
    const selected = [...state.selectedIds];
    const nodes = selected.map(id => state.nodes.get(id)).filter(node => canModify(node));
    const top = nodes.filter(node => !nodes.some(other => other.id !== node.id && isWithin(node.id, other.id)));
    if (!top.length) { el.bulkStatus.textContent = '選択項目は既に削除または変更されています。'; return; }
    if (action === 'move' && !canMoveTo(destinationId)) {
      throw new Error('このフォルダへは移動できません。自分自身・配下のフォルダや管理対象フォルダは選べません。');
    }
    if (action === 'delete') {
      const folders = top.filter(node => !node.url).length;
      const bookmarks = top.reduce((sum, node) => sum + (node.url ? 1 : countLinks(node)), 0);
      const detail = folders ? `\nフォルダ${folders}件と、その中身を含むブックマーク${bookmarks}件を削除します。` : '';
      const names = top.slice(0, 5).map(node => `・${node.title || node.url || '無題'}`).join('\n');
      if (!window.confirm(`選択した${selected.length}件をChromeのブックマークから削除しますか？${detail}\n${names}${top.length > 5 ? '\nほか' : ''}\nこの操作は元に戻せません。`)) return;
    }
    let succeeded = 0;
    const failures = [];
    for (const node of top) {
      const group = selected.filter(id => isWithin(id, node.id));
      try {
        if (action === 'move') {
          if (node.parentId !== destinationId) await chrome.bookmarks.move(node.id, {parentId: destinationId});
        } else if (node.url) await chrome.bookmarks.remove(node.id);
        else await chrome.bookmarks.removeTree(node.id);
        for (const id of group) state.selectedIds.delete(id);
        succeeded += group.length;
      } catch (error) {
        failures.push(`${node.title || node.url || '無題'}: ${error.message || '操作できませんでした'}`);
      }
    }
    const verb = action === 'move' ? '移動' : '削除';
    el.bulkStatus.textContent = `${succeeded}件を${verb}しました。${failures.length ? ` ${state.selectedIds.size}件が失敗しました。選択を残しています。\n${failures.join('\n')}` : ''}`;
  } catch (error) {
    el.bulkStatus.textContent = error.message || '操作できませんでした。';
  } finally {
    state.busy = false;
    await loadTree();
    render();
  }
}

function navigationButton({label, icon, id, count, depth = 0, folder = false}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = state.busy;
  button.className = `nav-entry${folder ? ' folder-entry' : ''}${state.view === id ? ' active' : ''}`;
  button.style.paddingLeft = `${12 + depth * 13}px`;
  button.append(svg(icon));
  const name = document.createElement('span');
  name.className = 'nav-name';
  name.textContent = label;
  name.title = label;
  button.append(name);
  if (typeof count === 'number') {
    const badge = document.createElement('span');
    badge.className = 'nav-count';
    badge.textContent = String(count);
    button.append(badge);
  }
  button.addEventListener('click', () => {
    state.view = id;
    state.visibleLimit = 90;
    state.query = '';
    el.search.value = '';
    render();
    window.scrollTo({top: 0, behavior: 'smooth'});
  });
  if (folder) {
    button.dataset.folderId = id;
    button.addEventListener('dragover', event => {
      if (!state.busy && state.selecting && state.selectedIds.size &&
          event.dataTransfer.types.includes('application/x-tabnest-selection') && canMoveTo(id)) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        button.classList.add('drop-target');
      }
    });
    button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
    button.addEventListener('drop', event => {
      button.classList.remove('drop-target');
      if (!state.selecting || !event.dataTransfer.types.includes('application/x-tabnest-selection')) return;
      event.preventDefault();
      try {
        const payload = JSON.parse(event.dataTransfer.getData('application/x-tabnest-selection'));
        if (payload.token !== state.dragToken || !Array.isArray(payload.ids) ||
            payload.ids.length !== state.selectedIds.size || !payload.ids.every(selectedId => state.selectedIds.has(selectedId))) {
          throw new Error('different selection');
        }
      } catch {
        el.bulkStatus.textContent = 'ドラッグ元のタブで移動してください。選択した項目は変更していません。';
        return;
      }
      operateSelection('move', id);
    });
    if (state.selecting && state.selectedIds.size) {
      const row = document.createElement('div'); row.className = 'folder-nav-row';
      const move = document.createElement('button'); move.type = 'button';
      move.className = 'move-here'; move.textContent = 'ここへ移動';
      move.dataset.moveTo = id;
      move.setAttribute('aria-label', `${label}へ選択項目を移動`);
      move.disabled = state.busy || !canMoveTo(id);
      move.addEventListener('click', () => operateSelection('move', id));
      row.append(button, move); return row;
    }
  }
  return button;
}

function renderNav() {
  el.primaryNav.replaceChildren(
    navigationButton({label:'すべてのブックマーク',icon:'grid',id:'all',count:state.allLinks.length}),
    navigationButton({label:'ピン留めしたサイト',icon:'star',id:'pinned',count:state.pinnedIds.length})
  );
  const fragment = document.createDocumentFragment();
  const categories = rootCategories();
  let folderCount = 0;
  function addFolder(folder, depth) {
    folderCount++;
    fragment.append(navigationButton({label:folder.title || '無題のフォルダ',icon:'folder',id:folder.id,count:countLinks(folder),depth,folder:true}));
    // Keep the current path reachable beyond the initial four sidebar levels.
    if (depth < 3 || isWithin(state.view, folder.id)) {
      for (const child of folder.children || []) if (!child.url) addFolder(child, depth + 1);
    }
  }
  for (const folder of categories) addFolder(folder, 0);
  el.folderTotal.textContent = String(folderCount);
  el.folderNav.replaceChildren(fragment);
}

function iconForSite(url) {
  const wrapper = document.createElement('span');
  wrapper.className = 'site-icon';
  const letter = domainFrom(url).slice(0, 1).toUpperCase() || '↗';
  wrapper.textContent = letter;
  if (url.startsWith('https:') || url.startsWith('http:')) {
    const image = document.createElement('img');
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', url);
    favicon.searchParams.set('size', '32');
    image.src = favicon.href;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove());
    wrapper.append(image);
  }
  return wrapper;
}

async function togglePin(id) {
  const i = state.pinnedIds.indexOf(id);
  if (i >= 0) state.pinnedIds.splice(i, 1);
  else state.pinnedIds.push(id);
  await savePrefs();
  render();
  toast(i >= 0 ? 'ピン留めを解除しました' : 'ピン留めしました');
}

function starButton(node) {
  const pinned = state.pinnedIds.includes(node.id);
  const button = document.createElement('button');
  button.className = `card-star${pinned ? ' is-pinned' : ''}`;
  button.type = 'button';
  button.title = pinned ? 'ピン留めを解除' : 'ピン留めする';
  button.setAttribute('aria-label', `${node.title || node.url}を${pinned ? 'ピン留め解除' : 'ピン留め'}`);
  button.setAttribute('aria-pressed', String(pinned));
  button.append(svg('star'));
  button.addEventListener('click', event => { event.stopPropagation(); togglePin(node.id); });
  return button;
}

function linkForBookmark(node, pinned) {
  const anchor = document.createElement('a');
  anchor.className = pinned ? 'pin-link' : 'bookmark-link';
  anchor.href = node.url;
  anchor.title = `${node.title || node.url}\n${node.url}\n右クリックまたはCtrl+クリックで別タブに開く`;
  if (pinned) {
    const head = document.createElement('div');
    head.className = 'pin-head';
    head.append(iconForSite(node.url), svg('arrow', 'icon pin-arrow'));
    anchor.append(head);
  } else anchor.append(iconForSite(node.url));
  const text = document.createElement(pinned ? 'div' : 'div');
  text.className = pinned ? 'pin-info' : 'bookmark-text';
  const title = document.createElement('span');
  title.className = pinned ? 'pin-title' : 'bookmark-title';
  title.textContent = node.title || domainFrom(node.url) || node.url;
  const domain = document.createElement('span');
  domain.className = pinned ? 'pin-domain' : 'bookmark-domain';
  domain.textContent = domainFrom(node.url);
  text.append(title, domain);
  anchor.append(text);
  return anchor;
}

function pinnedCard(node) {
  const card = document.createElement('article');
  card.className = 'pin-card';
  card.draggable = true;
  card.dataset.id = node.id;
  card.append(linkForBookmark(node, true), starButton(node));
  selectCard(card, node);
  card.addEventListener('dragstart', event => {
    if (state.selecting) return;
    event.dataTransfer.setData('text/plain', node.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragover', event => {
    if (state.selecting) return;
    if (event.dataTransfer.types.includes('text/plain')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    }
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('dragend', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', async event => {
    if (state.selecting) return;
    event.preventDefault();
    card.classList.remove('drag-over');
    const fromId = event.dataTransfer.getData('text/plain');
    if (!state.pinnedIds.includes(fromId) || fromId === node.id) return;
    const ids = state.pinnedIds.filter(id => id !== fromId);
    const destination = ids.indexOf(node.id);
    ids.splice(destination, 0, fromId);
    state.pinnedIds = ids;
    await savePrefs();
    render();
  });
  return card;
}

function bookmarkCard(node) {
  const card = document.createElement('article');
  card.className = 'bookmark-card';
  card.append(linkForBookmark(node, false), starButton(node));
  selectCard(card, node);
  card.addEventListener('contextmenu', event => {
    // Keep the browser's normal context menu; use the middle mouse button or Ctrl+click
    // to open in a new tab, and Chrome's bookmark manager for bulk edits.
  });
  return card;
}

function folderCard(node) {
  const card = document.createElement('article');
  card.className = 'folder-card';
  const button = document.createElement('button');
  button.className = 'folder-link';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.append(svg('folder'));
  const text = document.createElement('span');
  text.className = 'bookmark-text';
  const title = document.createElement('span');
  title.className = 'bookmark-title';
  title.textContent = node.title || '無題のフォルダ';
  const sub = document.createElement('span');
  sub.className = 'bookmark-domain';
  sub.textContent = `${countLinks(node)} 件のサイト`;
  text.append(title, sub);
  button.append(icon, text);
  button.addEventListener('click', () => {
    state.view = node.id;
    state.visibleLimit = 90;
    render();
    window.scrollTo({top: 0, behavior: 'smooth'});
  });
  card.append(button, svg('chevron', 'icon folder-chevron'));
  selectCard(card, node);
  return card;
}

function emptyState(headline, message) {
  const box = document.createElement('div');
  box.className = 'empty-state';
  const bold = document.createElement('strong');
  bold.textContent = headline;
  const text = document.createElement('span');
  text.textContent = message;
  box.append(bold, text);
  return box;
}

function renderPinned() {
  const visible = !state.query && ['all','pinned'].includes(state.view);
  el.pinnedSection.hidden = !visible;
  el.pinnedCount.textContent = String(state.pinnedIds.length);
  if (!visible) return;
  const items = state.pinnedIds.map(id => state.nodes.get(id)).filter(x => x?.url && canOpen(x.url));
  const fragment = document.createDocumentFragment();
  if (!items.length) fragment.append(emptyState('まだピン留めがありません', '下の一覧の ☆ を押すと、ここからワンクリックで開けます。'));
  for (const item of items) fragment.append(pinnedCard(item));
  el.pins.replaceChildren(fragment);
}

const reorderType = 'application/x-tabnest-reorder';

async function reorderBookmark(parentId, sourceId, targetId, after) {
  state.busy = true;
  try {
    if (!await loadTree({force: true})) throw new Error('Could not refresh bookmarks');
    const siblings = state.nodes.get(parentId)?.children || [];
    const sourceIndex = siblings.findIndex(node => node.id === sourceId);
    const targetIndex = siblings.findIndex(node => node.id === targetId);
    if (targetIndex < 0 || !canModify(siblings[sourceIndex])) {
      throw new Error('Bookmark is no longer movable within this folder');
    }
    // Chrome interprets the insertion index before removing the source.
    const index = targetIndex + Number(after);
    if (index !== sourceIndex && index !== sourceIndex + 1) {
      await chrome.bookmarks.move(sourceId, {parentId, index});
    }
  } catch (error) {
    console.error('Bookmark reorder failed:', error);
    toast('並べ替えを保存できませんでした。');
  } finally {
    state.busy = false;
    if (!await loadTree()) render();
  }
}

function enableBookmarkReorder(card, node) {
  const parentId = node.parentId;
  if (!canModify(node) || parentId !== state.view) return;
  card.draggable = true;
  const accepts = event => !state.busy && !state.selecting && !state.query.trim() &&
    state.view === parentId && event.dataTransfer.types.includes(reorderType);
  const isAfter = event => {
    const bounds = card.getBoundingClientRect();
    return event.clientX >= bounds.left + bounds.width / 2;
  };
  const clear = () => delete card.dataset.insert;
  card.addEventListener('dragstart', event => {
    event.dataTransfer.setData(reorderType, state.dragToken + ':' + node.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragover', event => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    card.dataset.insert = isAfter(event) ? 'after' : 'before';
  });
  card.addEventListener('dragleave', event => {
    if (!card.contains(event.relatedTarget)) clear();
  });
  card.addEventListener('dragend', () => {
    el.bookmarks.querySelectorAll('[data-insert]').forEach(target => delete target.dataset.insert);
  });
  card.addEventListener('drop', event => {
    clear();
    if (!accepts(event)) return;
    event.preventDefault();
    const [token, sourceId] = event.dataTransfer.getData(reorderType).split(':');
    if (token === state.dragToken && sourceId && sourceId !== node.id) {
      void reorderBookmark(parentId, sourceId, node.id, isAfter(event));
    }
  });
}

function renderBrowse() {
  const query = state.query.trim().toLocaleLowerCase();
  const searching = !!query;
  el.browse.hidden = state.view === 'pinned' && !searching;
  if (el.browse.hidden) return;
  let items;
  let heading;
  if (searching) {
    items = state.allLinks.filter(node => (`${node.title} ${node.url}`).toLocaleLowerCase().includes(query));
    heading = '検索結果';
    el.browseKicker.textContent = 'SEARCH RESULTS';
  } else if (state.view === 'all') {
    items = state.allLinks;
    heading = 'すべてのブックマーク';
    el.browseKicker.textContent = 'BOOKMARK LIBRARY';
  } else {
    const folder = state.nodes.get(state.view);
    items = (folder?.children || []).filter(x => !x.url || canOpen(x.url));
    heading = folder?.title || 'ブックマークバー';
    el.browseKicker.textContent = state.view === defaultParentId() ? 'BOOKMARKS BAR · 直下' : 'FOLDER CONTENTS';
  }
  el.browseTitle.textContent = heading;
  el.browseCount.textContent = String(items.length);
  el.bookmarks.classList.toggle('compact', state.compact);
  const subset = items.slice(0, state.visibleLimit);
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    if (!searching && state.view === 'bookmark-bar') {
      fragment.append(emptyState('ブックマークバーが見つかりません', '「再読み込み」を押すか、左側からフォルダを選択してください。'));
    } else {
      fragment.append(emptyState(searching ? '一致するブックマークはありません' : 'この場所には何もありません', searching ? '別のキーワードで検索してください。' : '「追加する」でサイトを登録できます。'));
    }
  }
  const canReorder = !searching && state.view !== 'all' && !state.selecting && !state.busy;
  for (const item of subset) {
    const card = item.url ? bookmarkCard(item) : folderCard(item);
    if (canReorder) enableBookmarkReorder(card, item);
    fragment.append(card);
  }
  el.bookmarks.replaceChildren(fragment);
  el.more.hidden = items.length <= state.visibleLimit;
  el.more.textContent = `さらに表示 (${items.length - state.visibleLimit}件)`;
  if (!el.more.hidden) el.more.append(svg('chevron'));
}

function render() {
  state.selecting = state.selectedIds.size > 0;
  renderNav();
  renderPinned();
  renderBrowse();
  renderSelection();
  const target = state.view === 'all' ? 'すべてのブックマーク' :
    state.view === 'pinned' ? 'ピン留め' : state.nodes.get(state.view)?.title || 'ブックマークバー';
  el.breadcrumb.textContent = state.query ? '検索結果' : target;
  document.body.classList.toggle('dark', state.theme === 'dark');
  el.theme.replaceChildren(svg(state.theme === 'dark' ? 'sun' : 'moon'));
  el.theme.title = state.theme === 'dark' ? 'ライトテーマにする' : 'ダークテーマにする';
  el.view.title = state.compact ? 'カード表示にする' : 'コンパクト表示にする';
}

function populateParents(selectedId) {
  el.parent.replaceChildren();
  function optionFor(node, depth = 0) {
    const option = document.createElement('option');
    option.value = node.id;
    option.textContent = `${'　'.repeat(depth)}${node.title || '無題のフォルダ'}`;
    el.parent.append(option);
    for (const child of node.children || []) if (!child.url) optionFor(child, depth + 1);
  }
  for (const root of rootCategories()) optionFor(root);
  if (selectedId && state.nodes.has(selectedId)) el.parent.value = selectedId;
  else el.parent.value = defaultParentId();
}

function openEditor(type = 'bookmark', node = null) {
  state.editor = {type, id: node?.id || null};
  el.form.reset();
  el.formError.hidden = true;
  el.dialogTitle.textContent = node ? (type === 'folder' ? 'フォルダを編集' : 'ブックマークを編集') : type === 'folder' ? 'フォルダを追加' : 'お気に入りを追加';
  el.title.value = node?.title || '';
  el.url.value = node?.url || '';
  el.urlBlock.hidden = type === 'folder';
  el.parentBlock.hidden = !!node;
  const parentId = state.view !== 'all' && state.view !== 'pinned' ? state.view : defaultParentId();
  populateParents(node?.parentId || parentId);
  el.dialog.showModal();
  el.title.focus();
}

async function saveEditor(event) {
  event.preventDefault();
  if (!state.editor) return;
  if (state.busy) return;
  state.busy = true;
  $('#saveDialog').disabled = true;
  try {
    const {type, id} = state.editor;
    const title = el.title.value.trim();
    if (!title) throw new Error('名前を入力してください。');
    const parentId = el.parent.value || defaultParentId();
    if (type === 'folder') {
      if (id) await chrome.bookmarks.update(id, {title});
      else {
        if (!parentId) throw new Error('保存するフォルダを選択してください。');
        await chrome.bookmarks.create({parentId, title});
      }
    } else {
      const url = normalizeUrl(el.url.value);
      if (id) await chrome.bookmarks.update(id, {title, url});
      else {
        if (!parentId) throw new Error('保存するフォルダを選択してください。');
        await chrome.bookmarks.create({parentId, title, url});
      }
    }
    el.dialog.close();
    state.editor = null;
    await loadTree({force: true});
    toast(id ? '変更を保存しました' : type === 'folder' ? 'フォルダを追加しました' : 'ブックマークを追加しました');
  } catch (error) {
    el.formError.hidden = false;
    el.formError.textContent = error.message || '保存できませんでした。';
  } finally {
    state.busy = false;
    $('#saveDialog').disabled = false;
    render();
  }
}

function handleKeyboard(event) {
  const focusedInput = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if (!el.dialog.open && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
    if (!focusedInput || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      el.search.focus();
      el.search.select();
    }
  } else if (event.key === 'Escape' && document.activeElement === el.search) {
    el.search.value = '';
    state.query = '';
    render();
    el.search.blur();
  }
}

async function boot() {
  try {
    const settings = await chrome.storage.local.get({
      tabnestPinnedIds: [], tabnestInitialized: false,
      tabnestTheme: 'light', tabnestCompact: false
    });
    state.pinnedIds = Array.isArray(settings.tabnestPinnedIds) ? settings.tabnestPinnedIds : [];
    state.initialized = !!settings.tabnestInitialized;
    state.theme = settings.tabnestTheme === 'dark' ? 'dark' : 'light';
    state.compact = !!settings.tabnestCompact;
  } catch (error) { console.warn('Could not load preferences:', error); }
  el.date.textContent = new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    state.visibleLimit = 90;
    render();
  });
  $('#addBtn').addEventListener('click', () => openEditor());
  $('#sidebarAdd').addEventListener('click', () => openEditor());
  $('#addFolderBtn').addEventListener('click', () => openEditor('folder'));
  el.selectAll.addEventListener('click', () => {
    if (state.busy) return;
    const sections = [el.pinnedSection, el.browse].filter(section => !section.hidden);
    for (const section of sections) {
      section.querySelectorAll('.item-select').forEach(input => state.selectedIds.add(input.dataset.id));
    }
    el.bulkStatus.textContent = '';
    render();
  });
  el.clearSelection.addEventListener('click', () => {
    if (state.busy) return;
    state.selectedIds.clear(); el.bulkStatus.textContent = ''; render();
  });
  el.editSelected.addEventListener('click', () => {
    if (state.busy || state.selectedIds.size !== 1) return;
    const node = state.nodes.get([...state.selectedIds][0]);
    if (canModify(node)) openEditor(node.url ? 'bookmark' : 'folder', node);
  });
  el.deleteSelected.addEventListener('click', () => operateSelection('delete'));
  $('#closeDialog').addEventListener('click', () => el.dialog.close());
  $('#cancelDialog').addEventListener('click', () => el.dialog.close());
  el.form.addEventListener('submit', saveEditor);
  el.more.addEventListener('click', () => { state.visibleLimit += 90; renderBrowse(); });
  el.refresh.addEventListener('click', async () => { await loadTree(); toast('ブックマークを更新しました'); });
  el.theme.addEventListener('click', async () => { state.theme = state.theme === 'light' ? 'dark' : 'light'; await savePrefs(); render(); });
  el.view.addEventListener('click', async () => { state.compact = !state.compact; await savePrefs(); render(); });
  document.addEventListener('keydown', handleKeyboard);
  for (const eventName of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded']) {
    chrome.bookmarks[eventName]?.addListener(() => loadTree());
  }
  await loadTree();
}

boot().catch(error => { console.error(error); toast('初期化中にエラーが発生しました。'); });

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dir = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.env.TABNEST_SOURCE || path.join(dir, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'newtab.html'), 'utf8');
const link = (id, parentId, title) => ({ id, parentId, title, url: `https://example.com/${id}` });
function tree(bar = { id: '1', title: 'ブックマーク バー' }) {
  return [{ id: '0', title: '', children: [
    { id: '2', parentId: '0', title: 'Other bookmarks', children: [link('20', '2', 'Outside site')] },
    { ...bar, parentId: '0', children: [link('10', bar.id, 'Bar site'),
      { id: '11', parentId: bar.id, title: 'Subfolder', children: [link('12', '11', 'Nested site')] }] }
  ] }];
}
async function open(roots, prefs = {}, options = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tabnest.test/' });
  const errors = [];
  const w = dom.window;
  w.console.error = (...args) => errors.push(args.join(' '));
  w.scrollTo = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const confirmations = [];
  w.confirm = message => { confirmations.push(message); return !!options.confirm; };
  const listeners = {};
  const find = id => {
    const visit = nodes => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const child = visit(node.children || []); if (child) return child;
      }
    };
    return visit(roots);
  };
  const detach = id => {
    const node = find(id); if (!node) throw new Error('Bookmark not found');
    const parent = find(node.parentId);
    parent.children = parent.children.filter(n => n.id !== id);
    return node;
  };
  const fail = id => { if (options.failIds?.has(id)) throw new Error('Cannot modify this bookmark'); };
  w.chrome = {
    runtime: { getURL: p => `https://tabnest.test${p}` },
    storage: { local: {
      get: async defaults => ({ ...defaults, ...prefs }),
      set: async values => Object.assign(prefs, values)
    } },
    bookmarks: {
      getTree: async () => {
        if (options.readFails) throw new Error('Read failed');
        return structuredClone(roots);
      },
      move: async (id, { parentId, index }) => {
        fail(id);
        const destination = find(parentId);
        if (!destination || destination.url) throw new Error('Invalid destination');
        const source = find(id);
        const previousIndex = source.parentId === parentId ? destination.children.indexOf(source) : -1;
        const node = detach(id); node.parentId = parentId;
        const children = destination.children ||= [];
        const insertion = index === undefined ? children.length : index - Number(previousIndex >= 0 && previousIndex < index);
        children.splice(insertion, 0, node);
        listeners.onMoved?.();
        return structuredClone(node);
      },
      remove: async id => {
        fail(id);
        if (find(id)?.children?.length) throw new Error('Folder not empty');
        detach(id); listeners.onRemoved?.();
      },
      removeTree: async id => { fail(id); detach(id); listeners.onRemoved?.(); },
      update: async (id, changes) => {
        fail(id); const node = find(id); Object.assign(node, changes);
        listeners.onChanged?.(); return structuredClone(node);
      }
    }
  };
  for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
    w.chrome.bookmarks[name] = { addListener: fn => { listeners[name] = fn; } };
  }
  w.eval(source);
  for (let i = 0; i < 100 && !w.document.querySelector('#folderNav button'); i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.deepEqual(errors, [], 'boot must not log errors');
  return { w, doc: w.document, prefs, listeners, find, confirmations, close: () => dom.window.close() };
}
const cards = doc => [...doc.querySelectorAll('#bookmarkGrid .bookmark-title')].map(n => n.textContent);

test('folder drag saves the order in Chrome across hidden siblings', async t => {
  const roots = tree();
  const bar = roots[0].children[1];
  bar.children.splice(1, 0, { ...link('99', '1', 'Hidden'), url: 'javascript:void(0)' });
  const app = await open(roots); t.after(app.close);
  const card = id => app.doc.querySelector(`#bookmarkGrid [data-id="${id}"]`);
  const data = new Map();
  const transfer = { setData: (type, value) => data.set(type, value), getData: type => data.get(type),
    get types() { return [...data.keys()]; } };
  const dispatch = (id, type, clientX) => {
    const event = new app.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    card(id).dispatchEvent(event);
    return event;
  };
  dispatch('10', 'dragstart', 1);
  assert.equal(dispatch('11', 'dragover', 1).defaultPrevented, true);
  assert.equal(card('11').dataset.insert, 'after');
  dispatch('11', 'drop', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bar.children.map(node => node.id), ['99', '11', '10']);
  assert.deepEqual(cards(app.doc), ['Subfolder', 'Bar site']);
});
const nav = (doc, label) => [...doc.querySelectorAll('.nav-entry')].find(n => n.querySelector('.nav-name').textContent === label);

for (const title of ['ブックマーク バー', 'Bookmarks bar', 'Lesezeichenleiste']) {
  test(`each fresh tab opens bar children with localized title: ${title}`, async t => {
    const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['20', '10'], tabnestTheme: 'dark', tabnestCompact: true };
    const app = await open(tree({ id: '1', title }), prefs); t.after(app.close);
    assert.equal(app.doc.querySelector('#browseTitle').textContent, title);
    assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
    assert.equal(app.doc.querySelector('#breadcrumbName').textContent, title);
    assert.equal(nav(app.doc, title).classList.contains('active'), true);
    assert.deepEqual(prefs.tabnestPinnedIds, ['20', '10']);
    assert.equal(app.doc.body.classList.contains('dark'), true);
    assert.equal(app.doc.querySelector('#bookmarkGrid').classList.contains('compact'), true);
  });
}
test('folderType identifies a nonstandard bar ID without relying on translated titles', async t => {
  const roots = tree({ id: '42', title: 'Custom bar', folderType: 'bookmarks-bar' });
  roots[0].children[0].id = '1'; roots[0].children[0].folderType = 'other';
  const app = await open(roots); t.after(app.close);
  assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
  assert.equal(app.doc.querySelector('#browseTitle').textContent, 'Custom bar');
});
test('legacy ID 1 wins over unrelated first root when folderType is absent', async t => {
  const app = await open(tree()); t.after(app.close);
  assert.deepEqual(app.prefs.tabnestPinnedIds, ['10']);
  assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
});
test('multiple bar roots prefer ID 1 deterministically', async t => {
  const roots = tree({ id: '1', title: 'Local bar', folderType: 'bookmarks-bar' });
  roots[0].children.unshift({ id: '42', parentId: '0', title: 'Account bar', folderType: 'bookmarks-bar', children: [link('43', '42', 'Account site')] });
  const app = await open(roots); t.after(app.close);
  assert.equal(app.doc.querySelector('#browseTitle').textContent, 'Local bar');
  assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
});
test('folder navigation and refresh stay in current folder; next tab resets to bar', async t => {
  const roots = tree(); const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['20', '10'] };
  const app = await open(roots, prefs); t.after(app.close);
  assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
  app.doc.querySelector('#bookmarkGrid .folder-link').click();
  assert.deepEqual(cards(app.doc), ['Nested site']);
  await app.listeners.onChanged();
  assert.deepEqual(cards(app.doc), ['Nested site']);
  const next = await open(roots, prefs); t.after(next.close);
  assert.deepEqual(cards(next.doc), ['Bar site', 'Subfolder']);
  assert.deepEqual(prefs.tabnestPinnedIds, ['20', '10']);
});
test('global search includes other folders; clearing returns to bar', async t => {
  const app = await open(tree()); t.after(app.close);
  const input = app.doc.querySelector('#searchInput');
  input.value = 'Outside'; input.dispatchEvent(new app.w.Event('input'));
  assert.deepEqual(cards(app.doc), ['Outside site']);
  input.value = ''; input.dispatchEvent(new app.w.Event('input'));
  assert.deepEqual(cards(app.doc), ['Bar site', 'Subfolder']);
});
test('existing pins retain order, can be toggled, and persist in a new tab', async t => {
  const roots = tree(); const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['20', '10'] };
  const app = await open(roots, prefs); t.after(app.close);
  nav(app.doc, 'ピン留めしたサイト').click();
  assert.deepEqual([...app.doc.querySelectorAll('.pin-title')].map(n => n.textContent), ['Outside site', 'Bar site']);
  app.doc.querySelector('.pin-card .card-star').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(prefs.tabnestPinnedIds, ['10']);
  const next = await open(roots, prefs); t.after(next.close);
  nav(next.doc, 'ピン留めしたサイト').click();
  assert.deepEqual([...next.doc.querySelectorAll('.pin-title')].map(n => n.textContent), ['Bar site']);
});
test('empty bar stays empty instead of showing bookmarks from elsewhere', async t => {
  const roots = tree(); roots[0].children[1].children = [];
  const app = await open(roots); t.after(app.close);
  assert.deepEqual(cards(app.doc), []);
  assert.equal(app.doc.querySelector('#browseTitle').textContent, 'ブックマーク バー');
  assert.equal(app.doc.querySelector('#browseCount').textContent, '0');
});
test('missing bar explains failure instead of silently showing another folder', async t => {
  const roots = tree(); roots[0].children.pop();
  const app = await open(roots); t.after(app.close);
  assert.deepEqual(cards(app.doc), []);
  assert.match(app.doc.querySelector('#bookmarkGrid').textContent, /ブックマークバー.*見つかりません/);
});
test('bookmark changes never reset a valid all or pinned view', async t => {
  const app = await open(tree()); t.after(app.close);
  nav(app.doc, 'すべてのブックマーク').click(); await app.listeners.onChanged();
  assert.deepEqual(cards(app.doc), ['Outside site', 'Bar site', 'Nested site']);
  nav(app.doc, 'ピン留めしたサイト').click(); await app.listeners.onChanged();
  assert.equal(app.doc.querySelector('#browseSection').hidden, true);
});

function select(app, id) {
  const input = app.doc.querySelector(`.item-select[data-id="${id}"]`);
  assert.ok(input, `item ${id} should have a checkbox`);
  input.click();
}
function startSelection(app) {
  assert.ok(app.doc.querySelector('.item-select'), 'cards should be immediately selectable');
}
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 3));
  assert.ok(predicate(), 'operation did not reach its expected result');
}
function moveTo(app, id) {
  const button = app.doc.querySelector(`[data-move-to="${id}"]`);
  assert.ok(button && !button.disabled, `folder ${id} should accept selection`); button.click();
}

test('selection mode toggles cards without opening links and can clear selection', async t => {
  const app = await open(tree()); t.after(app.close);
  startSelection(app);
  select(app, '10'); select(app, '11');
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '2件選択中');
  assert.equal(app.doc.querySelectorAll('#bookmarkGrid .is-selected').length, 2);
  const event = new app.w.MouseEvent('click', { bubbles: true, cancelable: true });
  assert.equal(app.doc.querySelector('#bookmarkGrid a').dispatchEvent(event), false);
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '1件選択中');
  app.doc.querySelector('#clearSelectionBtn').click();
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '0件選択中');
});
test('multiple bookmarks move to sidebar folder preserving IDs and pinned order', async t => {
  const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['12', '10', '20'] };
  const app = await open(tree(), prefs); t.after(app.close);
  nav(app.doc, 'すべてのブックマーク').click(); startSelection(app);
  select(app, '10'); select(app, '12'); moveTo(app, '2');
  await until(() => app.find('12').parentId === '2' && app.doc.querySelector('#selectionCount').textContent === '0件選択中');
  assert.equal(app.find('10').parentId, '2');
  assert.deepEqual(app.find('2').children.map(n => n.id), ['20', '10', '12']);
  assert.deepEqual(prefs.tabnestPinnedIds, ['12', '10', '20']);
});
test('selected folder and its child are moved once as a subtree across views', async t => {
  const app = await open(tree()); t.after(app.close);
  startSelection(app); select(app, '11');
  nav(app.doc, 'Subfolder').click(); select(app, '12');
  moveTo(app, '2');
  await until(() => app.find('11').parentId === '2' && app.doc.querySelector('#selectionCount').textContent === '0件選択中');
  assert.equal(app.find('12').parentId, '11');
  assert.deepEqual(app.find('11').children.map(n => n.id), ['12']);
});
test('a folder cannot be moved into itself or its descendants', async t => {
  const roots = tree(); roots[0].children[1].children[1].children.push({ id: '13', parentId: '11', title: 'Inner', children: [] });
  const app = await open(roots); t.after(app.close);
  startSelection(app); select(app, '11');
  for (const id of ['11', '13']) {
    assert.equal(app.doc.querySelector(`[data-move-to="${id}"]`)?.disabled, true);
    const target = app.doc.querySelector(`[data-folder-id="${id}"]`);
    const event = new app.w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['application/x-tabnest-selection'], getData: () => '11' } });
    target.dispatchEvent(event);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(app.find('11').parentId, '1');
  }
});
test('deleting multiple bookmarks supports cancel and persists removal from pins', async t => {
  const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['12', '10', '20'] };
  const options = { confirm: false };
  const app = await open(tree(), prefs, options); t.after(app.close);
  nav(app.doc, 'すべてのブックマーク').click(); startSelection(app);
  select(app, '10'); select(app, '12'); app.doc.querySelector('#deleteSelectedBtn').click();
  await until(() => app.confirmations.length === 1);
  assert.ok(app.find('10') && app.find('12'));
  assert.match(app.confirmations[0], /2件/);
  options.confirm = true; app.doc.querySelector('#deleteSelectedBtn').click();
  await until(() => !app.find('10') && !app.find('12') && app.doc.querySelector('#selectionCount').textContent === '0件選択中');
  assert.ok(app.find('20')); assert.deepEqual(prefs.tabnestPinnedIds, ['20']);
});
test('folder deletion explicitly includes descendants without duplicate child operations', async t => {
  const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['12', '10'] };
  const app = await open(tree(), prefs, { confirm: true }); t.after(app.close);
  startSelection(app); select(app, '11'); nav(app.doc, 'Subfolder').click(); select(app, '12');
  app.doc.querySelector('#deleteSelectedBtn').click();
  await until(() => !app.find('11') && app.doc.querySelector('#selectionCount').textContent === '0件選択中');
  assert.match(app.confirmations[0], /フォルダ.*中身/);
  assert.ok(!app.find('12')); assert.ok(app.find('10'));
  assert.deepEqual(prefs.tabnestPinnedIds, ['10']);
  assert.equal(app.doc.querySelector('#browseTitle').textContent, 'ブックマーク バー');
});
test('partial failures keep failed items selected and report accurate results', async t => {
  const options = { failIds: new Set(['12']) };
  const app = await open(tree(), {}, options); t.after(app.close);
  nav(app.doc, 'すべてのブックマーク').click(); startSelection(app); select(app, '10'); select(app, '12');
  moveTo(app, '2');
  await until(() => /失敗/.test(app.doc.querySelector('#bulkStatus').textContent));
  assert.equal(app.find('10').parentId, '2'); assert.equal(app.find('12').parentId, '11');
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '1件選択中');
  assert.match(app.doc.querySelector('#bulkStatus').textContent, /1件.*移動.*1件.*失敗/);
  options.failIds.clear(); moveTo(app, '2');
  await until(() => app.find('12').parentId === '2' && app.doc.querySelector('#selectionCount').textContent === '0件選択中');
});
test('selection is reconciled when another tab deletes a selected bookmark', async t => {
  const roots = tree(); const app = await open(roots); t.after(app.close);
  startSelection(app); select(app, '10');
  roots[0].children[1].children.shift(); await app.listeners.onRemoved();
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '0件選択中');
  assert.equal(app.doc.querySelector('#deleteSelectedBtn').disabled, true);
});
test('single bookmark editing updates title and URL without changing its ID or pins', async t => {
  const prefs = { tabnestInitialized: true, tabnestPinnedIds: ['10'] };
  const app = await open(tree(), prefs); t.after(app.close);
  startSelection(app); select(app, '10'); app.doc.querySelector('#editSelectedBtn').click();
  assert.equal(app.doc.querySelector('#titleField').value, 'Bar site');
  app.doc.querySelector('#titleField').value = 'Renamed';
  app.doc.querySelector('#urlField').value = 'https://example.org/new';
  app.doc.querySelector('#editorForm').dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.find('10').title === 'Renamed' && !app.doc.querySelector('#editorDialog').open);
  assert.equal(app.find('10').url, 'https://example.org/new');
  assert.equal(app.find('10').parentId, '1'); assert.deepEqual(prefs.tabnestPinnedIds, ['10']);
});
test('single folder editing renames it without creating a duplicate', async t => {
  const app = await open(tree()); t.after(app.close);
  startSelection(app); select(app, '11'); app.doc.querySelector('#editSelectedBtn').click();
  assert.equal(app.doc.querySelector('#urlFieldBlock').hidden, true);
  app.doc.querySelector('#titleField').value = 'Renamed folder';
  app.doc.querySelector('#editorForm').dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.find('11').title === 'Renamed folder' && !app.doc.querySelector('#editorDialog').open);
  assert.equal(app.find('11').children[0].id, '12');
});
test('managed and permanent folders are protected from selection and managed destinations reject moves', async t => {
  const roots = tree(); roots[0].children[1].children.push({ id: '30', parentId: '1', title: 'Managed', unmodifiable: 'managed', children: [link('31', '30', 'Managed site')] });
  const app = await open(roots); t.after(app.close);
  startSelection(app);
  assert.equal(app.doc.querySelector('.item-select[data-id="30"]'), null);
  select(app, '10');
  assert.equal(app.doc.querySelector('[data-move-to="30"]')?.disabled, true);
  nav(app.doc, 'Managed').click();
  assert.equal(app.doc.querySelector('.item-select[data-id="31"]'), null);
});
test('select-visible respects pagination and deduplicates pinned copies', async t => {
  const roots = tree(); roots[0].children[1].children = Array.from({ length: 100 }, (_, i) => link(String(100 + i), '1', `Site ${i}`));
  roots[0].children[0].children = [];
  const app = await open(roots, { tabnestInitialized: true, tabnestPinnedIds: ['100'] }); t.after(app.close);
  nav(app.doc, 'すべてのブックマーク').click(); startSelection(app);
  app.doc.querySelector('#selectAllBtn').click();
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '90件選択中');
  app.doc.querySelector('#loadMoreBtn').click(); app.doc.querySelector('#selectAllBtn').click();
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '100件選択中');
});
test('folder cards still navigate during selection and deep destinations appear in sidebar', async t => {
  const roots = tree();
  let parent = roots[0].children[1].children[1];
  for (let i = 0; i < 5; i++) {
    const child = { id: String(50 + i), parentId: parent.id, title: `Deep ${i}`, children: [] };
    parent.children.push(child); parent = child;
  }
  const app = await open(roots); t.after(app.close);
  startSelection(app); select(app, '10');
  app.doc.querySelector('#bookmarkGrid .folder-link').click();
  assert.equal(app.doc.querySelector('#browseTitle').textContent, 'Subfolder');
  for (let i = 0; i < 5; i++) {
    app.doc.querySelector('#bookmarkGrid .folder-link').click();
    assert.equal(app.doc.querySelector('#browseTitle').textContent, `Deep ${i}`);
  }
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '1件選択中');
  moveTo(app, '54');
  await until(() => app.find('10').parentId === '54');
});
test('drag from another tab never moves that receiving tab\'s own selection', async t => {
  const first = await open(tree()); const second = await open(tree()); t.after(first.close); t.after(second.close);
  nav(first.doc, 'すべてのブックマーク').click(); startSelection(first); select(first, '12');
  startSelection(second); select(second, '10');
  const data = {};
  const transfer = { types: ['application/x-tabnest-selection'], setData: (type, value) => { data[type] = value; }, getData: type => data[type] || '' };
  const drag = new first.w.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(drag, 'dataTransfer', { value: transfer });
  first.doc.querySelector('.bookmark-card[data-id="12"]').dispatchEvent(drag);
  const drop = new second.w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  second.doc.querySelector('[data-folder-id="2"]').dispatchEvent(drop);
  await new Promise(r => setTimeout(r, 15));
  assert.equal(second.find('10').parentId, '1');
  assert.equal(second.doc.querySelector('#selectionCount').textContent, '1件選択中');
});
test('card selection works immediately without an offscreen mode button', async t => {
  const app = await open(tree()); t.after(app.close);
  assert.equal(app.doc.querySelector('#bulkToolbar').hidden, true);
  select(app, '10'); select(app, '11');
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '2件選択中');
  assert.equal(app.doc.querySelector('#bulkToolbar').hidden, false);
  nav(app.doc, 'ピン留めしたサイト').click();
  assert.ok(app.doc.querySelector('.pin-card .item-select'));
});
test('card label selects directly and remains available after clearing the last selection', async t => {
  const app = await open(tree()); t.after(app.close);
  const label = app.doc.querySelector('.bookmark-card .card-selection');
  assert.ok(label, 'card contains a visible labelled selection control');
  label.click();
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '1件選択中');
  select(app, '10');
  assert.equal(app.doc.querySelector('#bulkToolbar').hidden, true);
  select(app, '10');
  assert.equal(app.doc.querySelector('#selectionCount').textContent, '1件選択中');
  app.doc.querySelector('#clearSelectionBtn').click();
  assert.equal(app.doc.querySelector('#bulkToolbar').hidden, true);
  assert.ok(app.doc.querySelector('.bookmark-card .item-select'));
});

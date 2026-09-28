/* Mini-CAT storage: IndexedDB wrapper. All data stays in the browser. */
(function (root) {
  'use strict';
  const DB_NAME = 'mini-cat';
  const DB_VERSION = 1;

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tm')) {
          const s = db.createObjectStore('tm', { keyPath: 'id', autoIncrement: true });
          s.createIndex('project', 'project', { unique: false });
          s.createIndex('srcNorm', 'srcNorm', { unique: false });
        }
        if (!db.objectStoreNames.contains('terms')) {
          const s = db.createObjectStore('terms', { keyPath: 'id', autoIncrement: true });
          s.createIndex('project', 'project', { unique: false });
          s.createIndex('zh', 'zh', { unique: false });
        }
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      try { result = fn(s); } catch (err) { reject(err); return; }
      t.oncomplete = () => {
        if (result && typeof result.request !== 'undefined') { /* noop */ }
        resolve(result && result.value !== undefined ? result.value : result);
      };
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  function reqValue(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---- tm ---- */
  const TM = {
    all(project) {
      return open().then(db => {
        if (!project) return reqValue(db.transaction('tm').objectStore('tm').getAll());
        return reqValue(db.transaction('tm').objectStore('tm').index('project').getAll(project));
      });
    },
    count(project) {
      return open().then(db => {
        const idx = db.transaction('tm').objectStore('tm').index('project');
        return reqValue(project ? idx.count(project) : idx.count());
      });
    },
    addMany(rows) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('tm', 'readwrite');
        const s = t.objectStore('tm');
        let n = 0;
        for (const r of rows) { s.put(r); n++; } // put → idempotent re-import by natural key later
        t.oncomplete = () => resolve(n);
        t.onerror = () => reject(t.error);
      }));
    },
    clear(project) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('tm', 'readwrite');
        const s = t.objectStore('tm');
        if (!project) { s.clear(); }
        else {
          const idx = s.index('project');
          const c = idx.openCursor(IDBKeyRange.only(project));
          c.onsuccess = (e) => { const cur = e.target.result; if (cur) { cur.delete(); cur.continue(); } };
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }));
    }
  };

  /* ---- terms ---- */
  const Terms = {
    all(project) {
      return open().then(db => {
        if (!project) return reqValue(db.transaction('terms').objectStore('terms').getAll());
        return reqValue(db.transaction('terms').objectStore('terms').index('project').getAll(project));
      });
    },
    addMany(rows) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('terms', 'readwrite');
        const s = t.objectStore('terms');
        for (const r of rows) s.put(r);
        t.oncomplete = () => resolve(rows.length);
        t.onerror = () => reject(t.error);
      }));
    },
    clear(project) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('terms', 'readwrite');
        const s = t.objectStore('terms');
        if (!project) s.clear();
        else {
          const idx = s.index('project');
          const c = idx.openCursor(IDBKeyRange.only(project));
          c.onsuccess = (e) => { const cur = e.target.result; if (cur) { cur.delete(); cur.continue(); } };
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      }));
    }
  };

  /* ---- projects ---- */
  const Projects = {
    all() { return open().then(db => reqValue(db.transaction('projects').objectStore('projects').getAll())); },
    get(name) { return open().then(db => reqValue(db.transaction('projects').objectStore('projects').get(name))); },
    put(p) { return tx('projects', 'readwrite', s => { s.put(p); return p; }); },
    /* 多标签页保护：同事务内比较项目版本号，仅当 rev 未被他人推进时写入。
     * expectedRev=null 表示强制覆盖（用户在冲突提示中明确选择后）。 */
    saveWithRev(name, expectedRev, data) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('projects', 'readwrite');
        const s = t.objectStore('projects');
        let result = null;
        const g = s.get(name);
        g.onsuccess = () => {
          const cur = g.result;
          const curRev = cur && typeof cur.rev === 'number' ? cur.rev : 0;
          if (expectedRev != null && curRev !== expectedRev) {
            result = { ok: false, conflict: true, currentRev: curRev, segments: (cur && cur.segments) || [], updated: (cur && cur.updated) || '' };
            return; // 不写入：事务提交但数据库未变
          }
          const rec = Object.assign({}, data, { name, rev: curRev + 1 });
          s.put(rec);
          result = { ok: true, newRev: curRev + 1 };
        };
        g.onerror = () => reject(g.error);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
      }));
    },
    delete(name) { return tx('projects', 'readwrite', s => { s.delete(name); }); }
  };

  /* ---- meta (settings) ---- */
  const Meta = {
    get(key, fallback) {
      return open().then(db => reqValue(db.transaction('meta').objectStore('meta').get(key)))
        .then(v => (v === undefined ? fallback : v.value));
    },
    set(key, value) { return tx('meta', 'readwrite', s => { s.put({ key, value }); return value; }); }
  };

  const MiniCatDB = { open, TM, Terms, Projects, Meta };
  if (typeof module !== 'undefined' && module.exports) module.exports = MiniCatDB;
  else root.MiniCatDB = MiniCatDB;
})(typeof self !== 'undefined' ? self : this);

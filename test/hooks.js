// The host runs every handler registered for a waterfall, each handing on to the next. The harnesses used to keep only
// the last one registered, which holds while one module registers each hook; this keeps them all, in the host's order
// (a `prepend` handler first), behind the same `hooks[name](…args, next)` the tests already call.
export function hookTable() {
  const lists = new Map();
  const hooks = {};
  const add = (name, fn, opts) => {
    if (!lists.has(name)) {
      const list = [];
      lists.set(name, list);
      const run = (...args) => {
        const last = args.pop();
        const step = (i, ...rest) => (i < list.length ? list[i](...args, (...over) => step(i + 1, ...over)) : last(...rest));
        return step(0);
      };
      hooks[name] = run;
    }
    const list = lists.get(name);
    if (opts?.prepend) list.unshift(fn); else list.push(fn);
    hooks[name].opts = opts ?? hooks[name].opts;
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  };
  return { hooks, add };
}

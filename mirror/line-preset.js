/* Stores settings only, never images or samples. Shared across mirror editions. */
(() => {
  const KEY='cyber-mirror.line-preset.v1';
  function load(){try{
    const raw=localStorage.getItem(KEY);if(!raw)return null;
    const value=JSON.parse(raw);LineArtEngine.resolveParameters(value);return value;
  }catch(_){return null;}}
  function save(options){LineArtEngine.resolveParameters(options);localStorage.setItem(KEY,JSON.stringify(options));}
  window.MirrorLinePreset={load,save};
})();

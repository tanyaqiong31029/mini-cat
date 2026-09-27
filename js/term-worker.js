importScripts('term-engine.js?v=1.7', 'term-candidates.js?v=1.7');
self.onmessage = e => {
  try { self.postMessage({result:MiniCatCandidates.scan(e.data.segments,e.data.existing,e.data.minFreq)}); }
  catch(error) { self.postMessage({error:error.message}); }
};

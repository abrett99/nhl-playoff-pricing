#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak_render', html);

  // PROBLEM: The delegated handler at the bottom of <script type="module"> tag
  // actually IS in module scope, so it can see `render`. BUT the earlier
  // attachListeners version was inside the module. The OUTER delegated handler
  // was put BEFORE </script> so it IS inside the module scope.
  //
  // Wait - actually looking again, we put `document.addEventListener('click', ...)`
  // at the top level of the module. That DOES have access to `render`.
  //
  // The error says "Can't find variable: render" - which means the code
  // ran from the console (global scope), NOT from the click handler inside the module.
  //
  // So the CLICK HANDLER IS WORKING (because it's in module scope).
  // The issue is something else is crashing.
  
  // Let me check the actual delegated handler and ensure it's INSIDE the module
  
  // Look for the delegated handler
  const handlerStart = html.indexOf('// Global delegated click handler for model toggle');
  if (handlerStart === -1) {
    console.log('[fix] Handler not found');
    return;
  }
  
  // Check if it's BEFORE </script>
  const scriptEndIdx = html.indexOf('</script>', handlerStart);
  const nextScriptStart = html.indexOf('<script', handlerStart);
  
  console.log('[fix] Handler at', handlerStart);
  console.log('[fix] Next </script> at', scriptEndIdx);
  console.log('[fix] Next <script at', nextScriptStart);
  
  // The handler should be AFTER </script> ideally (to be global) 
  // OR we need to wrap render access via window.render
  
  // Best fix: expose render and activeModel globally, wrap the handler to call window.render
  
  // Replace the delegated handler with a version that uses setTimeout to defer
  // and dispatches a custom event instead of calling render directly
  
  const oldHandler = /\/\/ Global delegated click handler for model toggle[\s\S]*?document\.addEventListener\('click', function\(e\) \{[\s\S]*?\}\);/;
  
  const newHandler = `// Global delegated click handler for model toggle (works across re-renders)
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.model-btn');
  if (!btn) return;
  e.preventDefault();
  window.activeModel = btn.dataset.model;
  document.querySelectorAll('.model-btn').forEach(b => b.classList.toggle('active', b === btn));
  // Dispatch custom event - module-scope code listens and calls render()
  window.dispatchEvent(new CustomEvent('modelChanged', { detail: { model: btn.dataset.model } }));
});`;
  
  if (oldHandler.test(html)) {
    html = html.replace(oldHandler, newHandler);
    console.log('[fix] Replaced delegated handler');
  } else {
    console.log('[fix] Old handler pattern not found - will add wrapper');
  }
  
  // Now add the listener inside the module scope - after render() function is defined
  // Find `function render()` or similar
  const renderFnIdx = html.search(/function render\s*\(\s*\)\s*\{/);
  if (renderFnIdx === -1) {
    console.log('[fix] Could not find render function - trying alternative');
  }
  
  // Find end of render function
  // Actually, simpler: just inject at the end of the module script an event listener
  // Find the LAST } before </script>
  
  const moduleScriptStart = html.indexOf('<script type="module">');
  const moduleScriptEnd = html.indexOf('</script>', moduleScriptStart);
  
  if (moduleScriptStart === -1 || moduleScriptEnd === -1) {
    throw new Error('Could not find module script boundaries');
  }
  
  // Insert the event listener just before </script>
  // Also expose render to window for the handler
  const inlineListener = `
// Expose render to window so click handlers can trigger re-render
window.render = render;
// Listen for model changes from delegated click handler
window.addEventListener('modelChanged', () => {
  if (typeof render === 'function') render();
});
`;
  
  // Check if already added
  if (!html.includes('window.render = render')) {
    html = html.slice(0, moduleScriptEnd) + inlineListener + html.slice(moduleScriptEnd);
    console.log('[fix] Added window.render exposure and modelChanged listener');
  }
  
  await fs.writeFile(HTML_PATH, html);
  console.log('[fix] \u2713 Done');
}

main().catch(err => {
  console.error('[fix] FAILED:', err.message);
  process.exit(1);
});

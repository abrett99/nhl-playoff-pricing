#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  await fs.writeFile(HTML_PATH + '.bak_scope', html);

  // Problem: `let activeModel = 'ensemble';` is scoped inside the script,
  // but the delegated handler is in a different execution context.
  // Fix: Promote to window.activeModel
  
  // Replace the declaration
  const oldDecl = `let activeModel = 'ensemble';`;
  const newDecl = `window.activeModel = 'ensemble';`;
  
  if (!html.includes(oldDecl)) {
    console.log('[scope-fix] Declaration already changed or not found');
  } else {
    html = html.replace(oldDecl, newDecl);
    console.log('[scope-fix] Replaced let with window.activeModel');
  }
  
  // Now replace all `activeModel` references (not activeMarketTab!) to use window.activeModel
  // Use a regex that matches activeModel but not activeMarketTab
  const beforeCount = (html.match(/\bactiveModel\b(?!\s*=)/g) || []).length;
  
  // Replace reads: `activeModel` → `window.activeModel`
  // But skip the ones where we already did it and LHS assignments we want as window.activeModel = X
  
  // Replace `activeModel = ` assignments (inside handlers)
  html = html.replace(/(?<!window\.)\bactiveModel\s*=\s*/g, 'window.activeModel = ');
  
  // Replace `activeModel || 'ensemble'` style reads
  html = html.replace(/(?<!window\.)\bactiveModel\b(?!\s*=)/g, 'window.activeModel');
  
  const afterCount = (html.match(/\bwindow\.activeModel\b/g) || []).length;
  console.log(`[scope-fix] Updated ${afterCount} activeModel references`);
  
  await fs.writeFile(HTML_PATH, html);
  console.log('[scope-fix] \u2713 Done');
}

main().catch(err => {
  console.error('[scope-fix] FAILED:', err.message);
  process.exit(1);
});

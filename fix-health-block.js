#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const HTML_PATH = 'src/ui/index.html';

async function main() {
  let html = await fs.readFile(HTML_PATH, 'utf-8');
  
  await fs.writeFile(HTML_PATH + '.bak_fix', html);
  console.log('[fix] Backup saved');
  
  // Find the broken line and the end of the corrupted block
  // The broken code is:  view.innerHTML = renderBacktestTab(); align-items: center; gap: 10px;">
  // We need to replace everything from `view.innerHTML = renderBacktestTab();` 
  // up to and including the final `\`;` (end of the orphaned template string)
  
  const brokenMarker = 'view.innerHTML = renderBacktestTab(); align-items';
  const brokenIdx = html.indexOf(brokenMarker);
  if (brokenIdx === -1) throw new Error('Could not find broken block');
  
  // Find the end of the orphaned template literal  - look for `;` followed by newline and  }
  // The block ends somewhere with `;\n  } else
  let endIdx = -1;
  const searchStart = brokenIdx + brokenMarker.length;
  
  // Look for pattern: `;\n  }  (end of the orphaned template)
  for (let i = searchStart; i < html.length - 10; i++) {
    if (html[i] === '`' && html[i+1] === ';') {
      // Check if followed by newline and closing brace
      let j = i + 2;
      while (j < html.length && (html[j] === '\n' || html[j] === ' ')) j++;
      if (html[j] === '}') {
        endIdx = i + 2; // include `;
        break;
      }
    }
  }
  
  if (endIdx === -1) {
    // Alternative: the whole orphan might not end with `;
    // Find } else if or } else { at brace depth 0 from brokenIdx
    throw new Error('Could not find end of broken block - need manual fix');
  }
  
  console.log('[fix] Replacing broken block from', brokenIdx, 'to', endIdx);
  
  // Replace with simple: view.innerHTML = renderBacktestTab();
  const replacement = 'view.innerHTML = renderBacktestTab();';
  html = html.slice(0, brokenIdx) + replacement + html.slice(endIdx);
  
  await fs.writeFile(HTML_PATH, html);
  console.log('[fix] \u2713 Done');
}

main().catch(err => {
  console.error('[fix] FAILED:', err.message);
  process.exit(1);
});

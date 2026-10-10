// Structural guard: Gen Z Guide must render ONLY inside the authenticated client layout, and never
// on public, admin, or login routes. (RTL is not installed in this project; this source-level guard
// is the reliable way to assert the scope boundary and prevent a future accidental mount.)
import fs from 'fs';
import path from 'path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('Gen Z Guide — render scope boundary', () => {
  test('is mounted by the authenticated client layout', () => {
    const layout = read('src/components/ClientLayoutEnhanced.js');
    expect(layout).toMatch(/import ClientGuideAssistant from '\.\.\/features\/clientAssistant\/ClientGuideAssistant'/);
    expect(layout).toMatch(/<ClientGuideAssistant\s*\/>/);
  });

  test('is NOT referenced by App.js (so public + admin route trees never mount it)', () => {
    const app = read('src/App.js');
    expect(app).not.toMatch(/clientAssistant|ClientGuideAssistant/);
  });

  test('client login does NOT use the client layout (no assistant on /client/login)', () => {
    for (const f of ['src/pages/client/ClientLogin.js', 'src/pages/client/ClientLoginEnhanced.js']) {
      if (fs.existsSync(path.join(process.cwd(), f))) {
        expect(read(f)).not.toMatch(/ClientLayoutEnhanced|ClientGuideAssistant/);
      }
    }
  });

  test('admin layouts do NOT mount the assistant', () => {
    for (const f of ['src/components/AdminLayout.js', 'src/components/AdminLayoutEnhanced.js']) {
      if (fs.existsSync(path.join(process.cwd(), f))) {
        expect(read(f)).not.toMatch(/ClientGuideAssistant|clientAssistant/);
      }
    }
  });
});

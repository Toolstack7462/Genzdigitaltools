// Originality audit + render-scope guard for Zee (source-level; RTL is not installed in this repo).
import fs from 'fs';
import path from 'path';

const AV_DIR = path.join(process.cwd(), 'src/features/genzAvatar');
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const avatarFiles = fs.readdirSync(AV_DIR).filter((f) => f.endsWith('.js') && !f.startsWith('.'));

describe('Zee — originality safeguards', () => {
  test('no Bible Strong / @bible-strong reference in any Zee source file', () => {
    for (const f of avatarFiles) {
      const src = fs.readFileSync(path.join(AV_DIR, f), 'utf8');
      expect(src).not.toMatch(/bible[-_ ]?strong/i);
      expect(src).not.toMatch(/@bible-strong/);
    }
  });

  test('package.json declares no @bible-strong dependency', () => {
    expect(read('package.json')).not.toMatch(/bible-strong/);
  });

  test('all drawn layers use the genz-avatar- prefix', () => {
    for (const f of ['GenzAvatarFace.js', 'GenzAvatarEyes.js', 'GenzAvatarMouth.js', 'GenzAvatarBody.js', 'GenzAvatarRenderer.js']) {
      expect(fs.readFileSync(path.join(AV_DIR, f), 'utf8')).toMatch(/genz-avatar-/);
    }
  });
});

describe('Zee — integration + scope', () => {
  test('rendered behind the existing AvatarRenderer adapter', () => {
    const ar = read('src/features/clientAssistant/AvatarRenderer.js');
    expect(ar).toMatch(/import GenzAvatar from '\.\.\/genzAvatar\/GenzAvatar'/);
    expect(ar).toMatch(/<GenzAvatar\s/);
    // fallback preserved
    expect(ar).toMatch(/cga-avatar-fallback/);
    expect(ar).toMatch(/ZeeBoundary/);
  });

  test('not imported by App.js, public navbar, or admin layouts', () => {
    expect(read('src/App.js')).not.toMatch(/genzAvatar/);
    for (const f of ['src/components/AdminLayout.js', 'src/components/AdminLayoutEnhanced.js', 'src/components/public/PublicNavbar.js']) {
      if (fs.existsSync(path.join(process.cwd(), f))) expect(read(f)).not.toMatch(/genzAvatar/);
    }
  });

  test('reduced-motion and hidden-tab both disable animation in CSS', () => {
    const css = fs.readFileSync(path.join(AV_DIR, 'genzAvatar.css'), 'utf8');
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).toMatch(/data-paused="1"/);
    expect(css).toMatch(/data-reduced="1"/);
  });
});

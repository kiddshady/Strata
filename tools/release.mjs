/* ═══════════════════════════════════════════════════════════════════════════
   Publica una versión de Strata en GitHub Releases.

     1. Subí la versión en package.json (npm version patch|minor|major).
     2. npm run release

   El script se niega si el árbol tiene cambios sin commitear, si el commit no
   está pusheado, si esa versión ya salió o si algún test falla: un release es
   lo que se instala solo en todas las máquinas, así que no sale a medias.

   Lo que sube (instalador + latest.yml + blockmap) es exactamente lo que lee
   electron-updater en las apps instaladas. El token sale de `gh auth token`.
   ═══════════════════════════════════════════════════════════════════════════ */

import { execSync } from 'child_process';
import fs from 'fs';

const run = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const die = (msg) => { console.error(`\n  no sale: ${msg}\n`); process.exit(1); };

const { version, build } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { owner, repo } = build.publish[0];
const tag = `v${version}`;

console.log(`\nStrata ${tag} → github.com/${owner}/${repo}\n`);

if (run('git status --porcelain')) die('hay cambios sin commitear');
run('git fetch origin --quiet');
const branch = run('git rev-parse --abbrev-ref HEAD');
if (run('git rev-parse HEAD') !== run(`git rev-parse origin/${branch}`)) die(`${branch} no está igual que origin/${branch} (¿falta un push?)`);
try { run(`gh release view ${tag} --repo ${owner}/${repo}`); die(`${tag} ya existe: subí la versión con npm version patch`); } catch (err) {
  if (err.message?.startsWith('no sale')) throw err;
}

console.log('  tests…');
execSync('npm run check', { stdio: 'inherit' });

/* El tag y el release van ANTES de subir nada. Si se los deja a electron-builder,
   sube los archivos en paralelo y cada subida intenta crear el release por su
   cuenta: una gana, la otra choca con un 422 y aborta a mitad — así salió la
   1.0.0, con solo el .blockmap y sin el instalador ni el latest.yml (y sin
   latest.yml ninguna app instalada se entera de nada). */
if (!run(`git tag --list ${tag}`)) run(`git tag -a ${tag} -m "Strata ${tag}"`);
run(`git push origin ${tag}`);
run(`gh release create ${tag} --repo ${owner}/${repo} --title ${version} --notes "Strata ${version}" --verify-tag`);

console.log('\n  armando y subiendo…');
const token = run('gh auth token');
execSync('npx electron-builder --win --publish always', { stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } });

const assets = JSON.parse(run(`gh release view ${tag} --repo ${owner}/${repo} --json assets`)).assets.map((a) => a.name);
for (const want of ['latest.yml', `Strata-Setup-${version}.exe`]) {
  if (!assets.includes(want)) die(`el release quedó sin ${want} — las apps instaladas no se van a actualizar`);
}
console.log(`\n  listo: https://github.com/${owner}/${repo}/releases/tag/${tag}\n`);

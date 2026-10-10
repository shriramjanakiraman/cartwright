// Salesforce B2C Commerce: the flavour (Storefront Next or SFRA; PWA Kit is reserved), cartridges, ISML, and the
// skills that fit the flavour. Runs after the language modules, so it can use their facts.
import { runScript } from './node.mjs';

export const PLATFORM = 'Salesforce B2C Commerce';
const SFRA_SKILLS = ['b2c-controllers', 'b2c-forms', 'b2c-isml'];
const SFNEXT_SKILLS = ['sfnext-*'];

export default {
  id: 'sfcc',
  detect(ctx) {
    const pkg = ctx.json('package.json') || {};
    const dep = (name) => ['dependencies', 'devDependencies'].find((k) => typeof pkg[k]?.[name] === 'string');
    const pm = ctx.facts.packageManager?.value;
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    // Cartridges: cartridges/<name>/cartridge/.
    const cartridges = ctx.list('cartridges', { depth: 1 }).filter((d) => d.endsWith('/') && ctx.exists(`${d}cartridge`)).map((d) => d.slice('cartridges/'.length, -1));
    const layout = cartridges.length ? { cartridges: { value: cartridges, source: 'cartridges/' } } : {};

    // Storefront Next wins over SFRA: its generated base cartridge is layout, never SFRA evidence.
    const sfnext = dep('@salesforce/storefront-next-dev') ? `package.json#${dep('@salesforce/storefront-next-dev')}.@salesforce/storefront-next-dev` : pkg.storefrontNext !== undefined ? 'package.json#storefrontNext' : null;
    if (sfnext) {
      const generated = [];
      if (cartridges.includes('app_storefrontnext_base') && typeof scripts['cartridge:generate'] === 'string') {
        generated.push({ path: 'cartridges/app_storefrontnext_base/cartridge/experience/**', regenerate: runScript(pm, 'cartridge:generate'), source: 'package.json#scripts.cartridge:generate' });
      }
      return { platform: { value: PLATFORM, flavour: 'storefront-next', source: sfnext }, layout, generated, guidance: { preferSkills: SFNEXT_SKILLS, avoidSkills: SFRA_SKILLS } };
    }

    if (!cartridges.length) return null;
    const base = typeof pkg.paths?.base === 'string' && pkg.paths.base.includes('app_storefront_base') ? 'package.json#paths.base' : null;
    const controllers = cartridges.find((c) => ctx.exists(`cartridges/${c}/cartridge/controllers`));
    const sfra = base || (dep('sgmf-scripts') && `package.json#${dep('sgmf-scripts')}.sgmf-scripts`)
      || (cartridges.includes('app_storefront_base') && 'cartridges/app_storefront_base')
      || (controllers && `cartridges/${controllers}/cartridge/controllers`);
    if (!sfra) return null;

    const r = { platform: { value: PLATFORM, flavour: 'sfra', source: sfra }, layout, languages: [], generated: [], guidance: { preferSkills: SFRA_SKILLS, avoidSkills: SFNEXT_SKILLS } };
    const isml = cartridges.find((c) => ctx.exists(`cartridges/${c}/cartridge/templates`));
    if (isml) r.languages.push({ value: 'ISML', source: `cartridges/${isml}/cartridge/templates` });
    for (const [script, dir] of [['compile:js', 'js'], ['compile:scss', 'css']]) {
      if (typeof scripts[script] === 'string') r.generated.push({ path: `cartridges/*/cartridge/static/default/${dir}/**`, regenerate: runScript(pm, script), source: `package.json#scripts.${script}` });
    }
    return r;
  },
};

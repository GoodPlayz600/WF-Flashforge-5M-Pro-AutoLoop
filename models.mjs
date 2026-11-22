const definitions = [
  ['ad5m-pro', 'Adventurer 5M Pro', 'rest', ['ad5mpro', '5mpro']],
  ['ad5m', 'Adventurer 5M', 'rest', ['ad5m', '5m']],
  ['ad5x', 'AD5X', 'rest', ['adventurer5x', '5x']],
  ['creator5', 'Creator 5', 'rest', [], 40],
  ['creator5-pro', 'Creator 5 Pro', 'rest', [], 41],
  ['ad3', 'Adventurer 3', 'monitor', ['adventureriii', 'ad3']],
  ['ad3-lite', 'Adventurer 3 Lite', 'monitor', ['adventureriiilite', 'ad3lite']],
  ['ad3-pro', 'Adventurer 3 Pro', 'monitor', ['adventureriiipro', 'ad3pro']],
  ['ad3-pro2', 'Adventurer 3 Pro 2', 'monitor', ['adventureriiipro2', 'ad3pro2']],
  ['ad3c', 'Adventurer 3C', 'monitor', ['adventureriiic', 'ad3c']],
  ['ad4', 'Adventurer 4', 'monitor', ['adventureriv', 'ad4']],
  ['ad4-lite', 'Adventurer 4 Lite', 'monitor', ['adventurerivlite', 'ad4lite']],
  ['ad4-pro', 'Adventurer 4 Pro', 'monitor', ['adventurerivpro', 'ad4pro']],
];

const normalize = value => typeof value === 'string'
  ? value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^flashforge/, '') : '';
export const defaultModel = 'ad5m-pro';
export const models = Object.fromEntries(definitions.map(([id, name, transport, aliases, pid]) => [
  id, { id, name, label: `Flashforge ${name}`, transport, aliases, pid, clearing: id === defaultModel },
]));

export function selectedModel(id = defaultModel) {
  if (typeof id !== 'string' || !Object.hasOwn(models, id)) throw Error('Choose a supported Flashforge printer model.');
  return models[id];
}

export function modelFromName(name) {
  const key = normalize(name);
  return Object.values(models).find(model => normalize(model.name) === key || model.aliases.includes(key));
}

export function modelFromDetail(detail) {
  return Object.hasOwn(models, detail.modelId) ? models[detail.modelId] : modelFromName(detail.verifiedModel ?? detail.name);
}

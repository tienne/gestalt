import type { GestaltConfig } from './config.js';

// These are Gestalt's documented aliases, not a catalog of provider model IDs.
const KNOWN_ALIASES = ['inherit', 'fable', 'haiku', 'sonnet', 'opus'];

/** One insertion, deletion, substitution, or adjacent transposition. */
function resemblesAlias(value: string, alias: string): boolean {
  if (Math.abs(value.length - alias.length) > 1) return false;
  let index = 0;
  while (index < Math.min(value.length, alias.length) && value[index] === alias[index]) index++;
  if (value.length !== alias.length) {
    const [longer, shorter] = value.length > alias.length ? [value, alias] : [alias, value];
    return longer.slice(index + 1) === shorter.slice(index);
  }
  return (
    value.slice(index + 1) === alias.slice(index + 1) ||
    (value[index] === alias[index + 1] &&
      value[index + 1] === alias[index] &&
      value.slice(index + 2) === alias.slice(index + 2))
  );
}

/** Advisory only: never reject, replace, or probe a user-selected model. */
export function diagnoseModelAliases(config: GestaltConfig) {
  const models: Array<[string, string]> = [
    ['reasoningModel', config.reasoningModel],
    ['reasoningModelFallback', config.reasoningModelFallback],
    ...Object.entries(config.tierModels).map(([tier, model]): [string, string] => [
      `tierModels.${tier}`,
      model,
    ]),
  ];
  return models.flatMap(([path, model]) => {
    // Full IDs and arbitrary aliases remain valid; only nearby plain aliases get a hint.
    const normalized = model.toLowerCase();
    if (!/^[a-z]+$/.test(normalized) || KNOWN_ALIASES.includes(normalized)) return [];
    const suggestion = KNOWN_ALIASES.find((alias) => resemblesAlias(normalized, alias));
    return suggestion
      ? [
          {
            path,
            model,
            suggestion,
            message:
              'Possible alias typo; kept unchanged. Ignore this hint if this is an intentional custom alias.',
          },
        ]
      : [];
  });
}

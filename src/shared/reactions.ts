/**
 * The fixed emoji palette for comment reactions (shared by server validation
 * and the sidebar's picker). Fixed on purpose: a handful of well-known
 * meanings keeps the chips scannable, Figma-style.
 */
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '👀', '✅'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

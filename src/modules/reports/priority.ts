export type Priority = 'high' | 'medium' | 'low';

// Ordered rules; first match wins. Word-boundary matching avoids "help" matching "helpful".
const RULES: Array<{ priority: Priority; pattern: RegExp }> = [
  {
    priority: 'high',
    pattern: /\b(sos|urgent|emergency|trapped|injured|bleeding|drowning|collapsed|unconscious|life[- ]threatening|help needed|need rescue)\b/i,
  },
  {
    priority: 'medium',
    pattern: /\b(need|needs|needed|shortage|running out|medical|medicine|water|food|shelter|evacuat\w*|missing|stranded)\b/i,
  },
];

const ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/**
 * Keyword-based priority classification (bonus feature). Deterministic and explainable;
 * an ML/LLM classifier could replace it behind the same function signature.
 */
export function classifyPriority(content: string): Priority {
  return RULES.find((rule) => rule.pattern.test(content))?.priority ?? 'low';
}

export const comparePriority = (a: Priority, b: Priority) => ORDER[a] - ORDER[b];

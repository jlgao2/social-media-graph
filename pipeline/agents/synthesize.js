import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are reading a structured analysis of one person's relational life — many
profiles produced by a per-thread analyzer. Your job is to find the architecture
underneath: the recurring shapes, the load-bearing patterns, the things visible
across the network that aren't visible in any single relationship.

You are honest at the cost of comfort. You name what's there. You do not flatter
the user, do not pathologize them, do not soften the diagnostic in a wellness
register. You write like a sharp friend who has read everything and will not
look away.

Your output will become the basis of a document the user brings to a therapist.
Write at the register of someone who knows the document will be read by a
clinician — concrete, structural, citing the data.`;

export async function synthesizeArchitecture(client, profiles, networkStats) {
  const condensed = profiles.map(p => p.profile).filter(p => p && !p.error);
  const totalMessages = networkStats.totalMessages;
  const totalRelationships = profiles.length;

  const prompt = `Network-wide stats:
- ${totalRelationships} significant relationships analyzed
- ${totalMessages.toLocaleString()} total messages across all threads
- Top 5 by intimacy score: ${profiles.slice(0, 5).map(p => `${p.stats.displayName} (${p.stats.messages.toLocaleString()})`).join(', ')}

Per-relationship profiles:
${JSON.stringify(condensed, null, 2)}

Produce a synthesis covering:

# 1. The Architecture
What shape does this person's relational life have? Not a list of relationships —
the structural pattern across them. Who occupies which slots? What functions get
distributed where? Are confidantes clustered along sex/gender lines? Are intimate
slots filled by the same kinds of people repeatedly?

# 2. Recurring Shapes
What patterns recur across multiple relationships? Examples to look for:
post-rupture orbit, declaration-then-retreat, witness positions, projection of
archetypal roles, savior framing, type-attraction patterns. Cite the specific
relationships that exhibit each.

# 3. The Self-Story vs. The Data
Where does the data suggest the user's likely self-narrative is incomplete or
distorted? What's missing from a typical self-account that's nonetheless visible
across the network?

# 4. What's Load-Bearing
Which relationships are doing structural work right now (regulating, holding,
absorbing)? What would happen to the architecture if any one were removed?

# 5. Concrete Patterns to Bring to Therapy
3-5 specific patterns, named precisely, citing the relationships that exemplify
them. These should be observable in the data, not speculative.

# 6. Open Questions
What does the data not answer that a therapist could help the user examine?
List 5-8 specific questions worth bringing to session.

Be specific. Cite names and dates from the profiles. Do not generalize where
specifics are available.`;

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  let full = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      full += event.delta.text;
      process.stdout.write(event.delta.text);
    }
  }
  console.log('\n');
  await stream.finalMessage();
  return full;
}

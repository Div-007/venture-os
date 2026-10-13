# Dealflow Sales skill for Claude Code

`SKILL.md` is the entry point Claude Code loads. It routes each sales request to one step file in [`steps/`](steps) (morning daybreak, today, finding leads, research and judging, drafting, review, replies, plays, weekly review), with the field formats in [`reference/formats.md`](reference/formats.md).

The skill works with the Dealflow Sales connector at `/mcp/sales`. Claude researches, judges and drafts; people send, approve and decide. See [docs/sales-os-guide.md](../../../docs/sales-os-guide.md).

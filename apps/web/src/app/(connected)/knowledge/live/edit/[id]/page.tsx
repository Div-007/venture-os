import { LiveKnowledgeEditorScreen } from "@/screens/live-knowledge-editor";

export const metadata = { title: "Edit Knowledge — Venture Studio OS" };

export default async function LiveKnowledgeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveKnowledgeEditorScreen documentId={id} />;
}

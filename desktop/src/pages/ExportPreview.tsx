import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';

export default function ExportPreview() {
  return (
    <>
      <PageHeader
        title="Export Preview"
        description="Preview every generated slide before exporting."
      />
      <EmptyState
        icon="📤"
        title="PPTX / PDF / JSON export"
        message="Pick a setlist, preview the exact slides (title slide per song, lyric slides split to fit), then export a .pptx in 16:9 or 4:3 — plus setlist PDF/text and song library JSON."
        phase={5}
      />
    </>
  );
}

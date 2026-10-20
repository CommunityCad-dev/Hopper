import { ICONS, Icon } from './icons';
import { fits, formatSize, typeLabel } from './format';
import { TransferBar } from './TransferBar';
import type { BuildVolume, ModelCard as Card } from './types';

interface Props {
  model: Card;
  volume: BuildVolume | null;
  onOpen: (id: number) => void;
  /** + on the card: add it to the plate you're building. Absent when unlinked. */
  onAdd?: (id: number) => void;
  /** On the plate already, or being added now (with the file coming in, for the bar). */
  added?: boolean;
  adding?: { fileId: number | null } | null;
  /** Why the last + on this card didn't work: shown over the picture, so the card
   * keeps its size. ✕ calls onDismiss. */
  note?: string | null;
  onDismiss?: () => void;
}

export function ModelCardView({ model, volume, onOpen, onAdd, added = false, adding = null, note = null, onDismiss }: Props) {
  const size = formatSize(model.bbox);
  const fitsPrinter = fits(model.bbox, volume);
  const canAdd = !!onAdd && model.has_printable && (model.printable_types ?? []).some((t) => t !== 'gcode');

  return (
    <div class="card-wrap">
    <div class={`card-box${canAdd ? ' can-add' : ''}`}>
    <button class="card" onClick={() => onOpen(model.id)} type="button">
      {model.thumbnail_url ? (
        // Straight from the public bucket: no proxy, no auth, and it means the grid
        // is not waiting on the Pi to relay images.
        <img class="thumb" src={model.thumbnail_url} alt="" loading="lazy" decoding="async" />
      ) : (
        <div class="thumb ph"><Icon path={ICONS.cube} size={40} /></div>
      )}
      <div class="body">
        <div class="title">{model.title}</div>
        <div class="meta">{model.creator.display_name || model.creator.username}</div>
        <div class="meta">{size ?? 'size unknown'}</div>
        {model.printable_types?.length > 0 && (
          <div class="meta types">{model.printable_types.map(typeLabel).join(' · ')}</div>
        )}
        {model.print_count > 0 && (
          <div class="meta">Printed {model.print_count}{model.print_count === 1 ? ' time' : ' times'}</div>
        )}
        <div class="foot">
          {fitsPrinter === true && <span class="badge fit">Fits</span>}
          {fitsPrinter === false && <span class="badge nofit">Too big</span>}
          {!model.has_printable && <span class="badge cad">CAD only</span>}
          {model.visibility && model.visibility !== 'public' && <span class="badge private">Private</span>}
        </div>
      </div>
    </button>
    {canAdd && (
      <button type="button" class={`card-add${added ? ' added' : ''}`} disabled={!!adding || added}
        aria-label={added ? `${model.title} is on your plate` : `Add ${model.title} to your plate`}
        title={added ? 'On your plate' : 'Add to the plate you\'re building'} onClick={() => onAdd!(model.id)}>
        {adding ? '…' : added ? '✓' : '+'}
      </button>
    )}
    {adding?.fileId != null && <div class="card-transfer"><TransferBar modelId={model.id} fileId={adding.fileId} /></div>}
    {note && (
      <div class="card-note" role="status">
        <p title={note}>{note}</p>
        {onDismiss && <button type="button" class="card-note-close" aria-label="Dismiss" onClick={onDismiss}>✕</button>}
      </div>
    )}
    </div>
    </div>
  );
}

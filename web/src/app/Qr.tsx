import qrcode from 'qrcode-generator';

/**
 * QR as inline SVG: crisp at any size, and no canvas or image round-trip.
 *
 * Medium error correction, which tolerates a phone camera held at an angle in
 * workshop lighting. Returns null rather than throwing if encoding fails — a
 * missing QR should cost the user the convenience, not the screen.
 */
export function QrSvg({ text, size = 190 }: { text: string; size?: number }) {
  const encoded = (() => {
    try {
      const qr = qrcode(0, 'M'); // type 0 = smallest version that fits
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const cells: string[] = [];
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) cells.push(`M${col} ${row}h1v1h-1z`);
        }
      }
      return { count, path: cells.join('') };
    } catch {
      return null;
    }
  })();

  if (!encoded) return null;
  return (
    <svg
      class="qr" width={size} height={size}
      viewBox={`0 0 ${encoded.count} ${encoded.count}`}
      role="img" aria-label="QR code for the sign-in link"
    >
      <rect width={encoded.count} height={encoded.count} fill="#fff" />
      <path d={encoded.path} fill="#000" />
    </svg>
  );
}
